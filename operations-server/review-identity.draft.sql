-- DRAFT ONLY. Requires separate approval before applying to the shared project.
-- Prerequisite: operations-server/install.sql and nfc-server/reviews.sql.
-- Impact: one private roster table, one nullable review author snapshot column,
-- one guarded admin RPC, policy/summary helpers, and two write triggers.
-- No existing rows, names, ratings, points, vouchers, or auth roles are rewritten.
-- Roster booth_keys must include EVERY booth run by each of the user's clubs.
-- New club booths require a roster recheck. [] means confirmed no club, not unknown.
-- Until enrollment, every account is denied review writes (including administrators).
-- Apply schema + verified roster + compatible client as one coordinated release.
-- Legacy booth_ratings INSERT/UPDATE and legacy submit RPCs will STOP WORKING.
-- Verify all team dependencies and approved name-publication/retention rules first.
-- On failure before COMMIT, ROLLBACK. After COMMIT do not drop the guards to recover:
-- keep reviews closed, preserve visits/ledger and snapshot definitions for a reviewed
-- forward repair. Private roster removal/retention requires a school-approved plan.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table festival_ops.review_identities (
  event_id uuid not null references festival_ops.events(id),
  user_id integer not null references public.users(id),
  real_name text not null check (length(btrim(real_name)) between 1 and 60),
  booth_keys text[] not null default '{}',
  verified boolean not null default false,
  version integer not null default 1,
  confirmed_by integer not null references public.users(id),
  updated_at timestamptz not null default now(),
  primary key (event_id,user_id),
  check (cardinality(booth_keys) <= 100)
);
alter table festival_ops.review_identities enable row level security;
revoke all on festival_ops.review_identities from public,anon,authenticated;
create index review_identities_user on festival_ops.review_identities(user_id);
create index review_identities_confirmer on festival_ops.review_identities(confirmed_by);
alter table festival_ops.reviews add column author_name text
  check (author_name is null or length(btrim(author_name)) between 1 and 60);

create function festival_ops.review_policy(e uuid,u integer,b text) returns jsonb
language plpgsql set search_path = '' as $$
declare identity festival_ops.review_identities; reason text;
begin
  select * into identity from festival_ops.review_identities where event_id=e and user_id=u;
  if identity.user_id is null or not identity.verified then reason := 'REVIEW_IDENTITY_REQUIRED';
  elsif b=any(identity.booth_keys) then reason := 'OWN_CLUB_REVIEW'; end if;
  return jsonb_build_object('version',1,'allowed',reason is null,'reason',reason,
    'authorName',case when reason is null then coalesce(
      (select author_name from festival_ops.reviews where event_id=e and user_id=u and booth_key=b),identity.real_name) end);
end $$;

create or replace function festival_ops.review_summary(e uuid,u integer,b text) returns jsonb
language sql set search_path = '' as $$
 select jsonb_build_object('boothKey',b,'count',count(*),'average',round(avg(rating),1),
   'reviewPolicy',festival_ops.review_policy(e,u,b),
   'myRating',max(rating) filter(where user_id=u),'reviews',
   coalesce((select jsonb_agg(x.item order by x.ts desc) from (
     select r.created_at ts,jsonb_build_object('rating',r.rating,'content',nullif(r.content,''),
       'createdAt',r.created_at,'mine',r.user_id=u,'author',coalesce(r.author_name,'참여자')) item
     from festival_ops.reviews r where r.event_id=e and r.booth_key=b
     order by r.created_at desc limit 50) x),'[]'::jsonb))
 from festival_ops.reviews where event_id=e and booth_key=b;
$$;

create function festival_ops.guard_named_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me jsonb; policy jsonb;
begin
  -- Same lock as the existing write RPC and roster edits: a fresh membership decision.
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me := festival_nfc_private.current_profile();
  if (me->>'id')::integer <> new.user_id then raise exception 'AUTH_REQUIRED'; end if;
  if not exists(select 1 from festival_ops.events where id=new.event_id and current and state='open') then
    raise exception 'EVENT_CLOSED'; end if;
  if tg_op='UPDATE' and (old.event_id,old.user_id,old.booth_key) is distinct from (new.event_id,new.user_id,new.booth_key) then
    raise exception 'INVALID_INPUT'; end if;
  policy := festival_ops.review_policy(new.event_id,new.user_id,new.booth_key);
  if not (policy->>'allowed')::boolean then raise exception '%',policy->>'reason'; end if;
  -- Never accept an author supplied by the browser; preserve published snapshots.
  new.author_name := case when tg_op='UPDATE' then coalesce(old.author_name,policy->>'authorName') else policy->>'authorName' end;
  return new;
end $$;
create trigger reviews_verified_identity before insert or update on festival_ops.reviews
for each row execute function festival_ops.guard_named_review();

-- Old clients must not bypass membership checks using the previous rating table/RPC.
-- Read access and historical rows are preserved. This affects other legacy clients.
create function festival_ops.block_legacy_review_write() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'REVIEW_POLICY_REQUIRED'; end $$;
create trigger ratings_require_named_reviews before insert or update on public.booth_ratings
for each row execute function festival_ops.block_legacy_review_write();

create function public.festival_review_identity_admin(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb; actor integer; target integer; e uuid; row festival_ops.review_identities;
  keys text[]; name text; why text; account_name text; v integer;
begin
  me := festival_nfc_private.current_profile(); actor := (me->>'id')::integer;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_action is null or p_action not in ('get','save') or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>20000 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  select id into e from festival_ops.events where current;
  if e is null or (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
  target := (p_payload->>'userId')::integer;
  select a.name into account_name from public.users a where a.id=target and a.auth_user_id is not null;
  if account_name is null then raise exception 'INVALID_INPUT'; end if;
  select * into row from festival_ops.review_identities where event_id=e and user_id=target for update;
  if p_action='save' then
    if target=actor then raise exception 'SELF_ADJUSTMENT'; end if;
    v := (p_payload->>'version')::integer;
    if v is distinct from coalesce(row.version,0) then raise exception 'VERSION_CONFLICT'; end if;
    name := btrim(p_payload->>'realName'); why := btrim(p_payload->>'reason');
    if name is null or length(name) not between 1 and 60 or why is null or length(why) not between 3 and 300
      or jsonb_typeof(p_payload->'verified') is distinct from 'boolean'
      or jsonb_typeof(p_payload->'boothKeys') is distinct from 'array' then raise exception 'INVALID_INPUT'; end if;
    if jsonb_array_length(p_payload->'boothKeys')>100 or exists(
      select 1 from jsonb_array_elements(p_payload->'boothKeys') x where jsonb_typeof(x)<>'string') then raise exception 'INVALID_INPUT'; end if;
    select coalesce(array_agg(distinct value order by value),'{}'::text[]) into keys
      from jsonb_array_elements_text(p_payload->'boothKeys');
    if exists(select 1 from unnest(keys) k where not exists(select 1 from festival_ops.booths b where b.event_id=e and b.key=k)) then
      raise exception 'INVALID_INPUT'; end if;
    insert into festival_ops.review_identities(event_id,user_id,real_name,booth_keys,verified,version,confirmed_by)
      values(e,target,name,keys,(p_payload->>'verified')::boolean,v+1,actor)
    on conflict(event_id,user_id) do update set real_name=excluded.real_name,booth_keys=excluded.booth_keys,
      verified=excluded.verified,version=excluded.version,confirmed_by=actor,updated_at=now()
    returning * into row;
  end if;
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(e,actor,'review_identity_'||p_action,target::text,why);
  return jsonb_build_object('eventId',e,'userId',target,'accountName',account_name,'realName',row.real_name,
    'boothKeys',coalesce(to_jsonb(row.booth_keys),'[]'),'verified',coalesce(row.verified,false),'version',coalesce(row.version,0));
end $$;

revoke all on function festival_ops.review_policy(uuid,integer,text),festival_ops.guard_named_review(),
  festival_ops.block_legacy_review_write() from public,anon,authenticated;
revoke all on function public.festival_review_identity_admin(text,jsonb) from public,anon;
grant execute on function public.festival_review_identity_admin(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;

-- DRAFT ONLY. Requires separate approval before applying to the shared project.
-- Prerequisite: operations-server/install.sql and nfc-server/reviews.sql.
-- Impact: two private roster/link tables, one nullable review author snapshot column,
-- one guarded admin RPC, policy/summary helpers, and two write triggers.
-- No existing rows, names, ratings, points, vouchers, or auth roles are rewritten.
-- Import the official workbook using the owner-only import helper. Account links
-- require an operator's independent identity check; user_metadata is never proof.
-- Unknown clubs/conflicting rows remain blocked. A catalog change blocks links
-- until a reviewed reimport and reconfirmation. No automatic account enrollment.
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

create table festival_ops.review_roster (
  event_id uuid not null references festival_ops.events(id),
  student_number text not null check (student_number ~ '^[1-3][0-9]{4}$'),
  real_name text check (real_name is null or length(btrim(real_name)) between 1 and 60),
  clubs text[] not null check (cardinality(clubs) between 1 and 100),
  booth_keys text[] not null,
  status text not null check (status in ('ready','review_required','inactive')),
  issues text[] not null,
  source_cells text[] not null,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  catalog_keys text[] not null,
  version integer not null default 1 check (version>0),
  updated_at timestamptz not null default now(),
  primary key(event_id,student_number),
  check (status<>'ready' or (real_name is not null and cardinality(issues)=0))
);
alter table festival_ops.review_roster enable row level security;
revoke all on festival_ops.review_roster from public,anon,authenticated;
create table festival_ops.review_identities (
  event_id uuid not null references festival_ops.events(id),
  user_id integer not null references public.users(id),
  real_name text not null check (length(btrim(real_name)) between 1 and 60),
  booth_keys text[] not null default '{}',
  verified boolean not null default false,
  version integer not null default 1,
  confirmed_by integer not null references public.users(id),
  student_number text not null,
  roster_version integer not null check (roster_version>0),
  updated_at timestamptz not null default now(),
  primary key (event_id,user_id),
  unique(event_id,student_number),
  foreign key(event_id,student_number) references festival_ops.review_roster(event_id,student_number),
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
declare identity festival_ops.review_identities; roster festival_ops.review_roster; reason text; catalog text[];
begin
  select * into identity from festival_ops.review_identities where event_id=e and user_id=u;
  select * into roster from festival_ops.review_roster where event_id=e and student_number=identity.student_number;
  select coalesce(array_agg(key order by key collate "C"),'{}') into catalog from festival_ops.booths where event_id=e;
  if identity.user_id is null or not identity.verified or roster.status is distinct from 'ready'
    or identity.roster_version is distinct from roster.version or roster.catalog_keys is distinct from catalog
    then reason := 'REVIEW_IDENTITY_REQUIRED';
  elsif b=any(roster.booth_keys) then reason := 'OWN_CLUB_REVIEW'; end if;
  return jsonb_build_object('version',1,'allowed',reason is null,'reason',reason,
    'authorName',case when reason is null then coalesce(
      (select author_name from festival_ops.reviews where event_id=e and user_id=u and booth_key=b),roster.real_name) end);
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
  roster festival_ops.review_roster; why text; account_name text; v integer; sid text;
  catalog text[]; usable boolean; candidate jsonb;
begin
  me := festival_nfc_private.current_profile(); actor := (me->>'id')::integer;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_action is null or p_action not in ('get','lookup','save','revoke') or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>20000 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  select id into e from festival_ops.events where current;
  if e is null or (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
  target := (p_payload->>'userId')::integer;
  select a.name into account_name from public.users a where a.id=target and a.auth_user_id is not null;
  if account_name is null then raise exception 'INVALID_INPUT'; end if;
  select * into row from festival_ops.review_identities where event_id=e and user_id=target for update;
  select coalesce(array_agg(key order by key collate "C"),'{}') into catalog from festival_ops.booths where event_id=e;
  sid := case when p_action in ('lookup','save') then p_payload->>'studentNumber' else row.student_number end;
  if p_action in ('lookup','save') and (sid is null or sid !~ '^[1-3][0-9]{4}$') then raise exception 'INVALID_INPUT'; end if;
  select * into roster from festival_ops.review_roster where event_id=e and student_number=sid;
  usable := roster.status='ready' and roster.catalog_keys=catalog;
  if p_action in ('save','revoke') then
    if target=actor then raise exception 'SELF_ADJUSTMENT'; end if;
    v := (p_payload->>'version')::integer;
    if v is distinct from coalesce(row.version,0) then raise exception 'VERSION_CONFLICT'; end if;
    why := btrim(p_payload->>'reason');
    if why is null or length(why) not between 3 and 300 then raise exception 'INVALID_INPUT'; end if;
    if p_action='save' then
      if not coalesce(usable,false) then raise exception 'ROSTER_REVIEW_REQUIRED'; end if;
      if (p_payload->>'rosterVersion')::integer is distinct from roster.version then raise exception 'VERSION_CONFLICT'; end if;
      if p_payload->'confirmed' is distinct from 'true'::jsonb then raise exception 'INVALID_INPUT'; end if;
      if exists(select 1 from festival_ops.review_identities where event_id=e and student_number=sid and user_id<>target) then
        raise exception 'ROSTER_ALREADY_LINKED'; end if;
      -- The client never chooses a real name or removes an own-club restriction.
      insert into festival_ops.review_identities(event_id,user_id,real_name,booth_keys,verified,version,confirmed_by,student_number,roster_version)
        values(e,target,roster.real_name,roster.booth_keys,true,v+1,actor,sid,roster.version)
      on conflict(event_id,user_id) do update set real_name=excluded.real_name,booth_keys=excluded.booth_keys,
        verified=true,version=excluded.version,confirmed_by=actor,student_number=excluded.student_number,
        roster_version=excluded.roster_version,updated_at=now()
      returning * into row;
    else
      if row.user_id is null then raise exception 'INVALID_INPUT'; end if;
      update festival_ops.review_identities set verified=false,version=version+1,confirmed_by=actor,updated_at=now()
        where event_id=e and user_id=target returning * into row;
    end if;
  end if;
  if roster.student_number is not null then
    candidate := jsonb_build_object('studentNumber',roster.student_number,'realName',roster.real_name,'clubs',roster.clubs,
      'boothKeys',roster.booth_keys,'version',roster.version,'ready',coalesce(usable,false),
      'linkedElsewhere',exists(select 1 from festival_ops.review_identities where event_id=e and student_number=sid and user_id<>target));
  end if;
  -- Audit the account accessed, never copy a student number, name or workbook row.
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(e,actor,'review_identity_'||p_action,target::text,why);
  return jsonb_build_object('eventId',e,'userId',target,'accountName',account_name,'realName',row.real_name,
    'boothKeys',coalesce(to_jsonb(row.booth_keys),'[]'),'verified',coalesce(row.verified,false),'version',coalesce(row.version,0),
    'rosterVersion',row.roster_version,'roster',candidate);
end $$;

-- Owner-only, transactionally imports locally validated records. Not a browser RPC.
create function festival_ops.import_review_roster(p_event uuid,p_document jsonb,p_actor integer) returns jsonb
language plpgsql set search_path = '' as $$
declare item jsonb; sid text; catalog text[]; supplied_catalog text[]; clubs text[]; keys text[];
  reasons text[]; cells text[]; state text; name text; source text; n integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  if not exists(select 1 from public.users where id=p_actor and admin and auth_user_id is not null) then
    raise exception 'ADMIN_REQUIRED'; end if;
  if not exists(select 1 from festival_ops.events where id=p_event and current)
    or p_document->>'format' is distinct from '1' or jsonb_typeof(p_document->'records') is distinct from 'array'
    or jsonb_typeof(p_document->'catalogKeys') is distinct from 'array' then raise exception 'INVALID_ROSTER_IMPORT'; end if;
  n := jsonb_array_length(p_document->'records');
  source := p_document->>'sourceSha256';
  if n not between 1 and 3000 or source is null or source !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_ROSTER_IMPORT'; end if;
  select coalesce(array_agg(key order by key collate "C"),'{}') into catalog from festival_ops.booths where event_id=p_event;
  select array_agg(value order by value collate "C") into supplied_catalog from jsonb_array_elements_text(p_document->'catalogKeys');
  if catalog is distinct from supplied_catalog then raise exception 'ROSTER_CATALOG_CHANGED'; end if;
  if (select count(distinct r->>'studentNumber') from jsonb_array_elements(p_document->'records') r)<>n then
    raise exception 'INVALID_ROSTER_IMPORT'; end if;
  for item in select * from jsonb_array_elements(p_document->'records') loop
    sid := item->>'studentNumber'; state := item->>'status'; name := btrim(item->>'realName');
    if sid is null or sid !~ '^[1-3][0-9]{4}$' or state is null or state not in ('ready','review_required')
      or (name is not null and length(name) not between 1 and 60)
      or jsonb_typeof(item->'clubs') is distinct from 'array' or jsonb_typeof(item->'boothKeys') is distinct from 'array'
      or jsonb_typeof(item->'issues') is distinct from 'array' or jsonb_typeof(item->'sourceCells') is distinct from 'array'
      then raise exception 'INVALID_ROSTER_IMPORT'; end if;
    if exists(select 1 from jsonb_array_elements((item->'clubs')||(item->'boothKeys')||(item->'issues')||(item->'sourceCells')) x
      where jsonb_typeof(x)<>'string' or length(x#>>'{}') not between 1 and 300) then raise exception 'INVALID_ROSTER_IMPORT'; end if;
    select array_agg(value order by value collate "C") into clubs from jsonb_array_elements_text(item->'clubs');
    select coalesce(array_agg(value order by value collate "C"),'{}') into keys from jsonb_array_elements_text(item->'boothKeys');
    select coalesce(array_agg(value),'{}') into reasons from jsonb_array_elements_text(item->'issues');
    select array_agg(value) into cells from jsonb_array_elements_text(item->'sourceCells');
    if clubs is null or cardinality(clubs)>100 or cells is null or cardinality(cells)>100
      or not keys<@catalog or cardinality(keys)>100 or cardinality(reasons)>20
      or (state='ready' and (name is null or cardinality(reasons)<>0)) then raise exception 'INVALID_ROSTER_IMPORT'; end if;
    insert into festival_ops.review_roster as old(event_id,student_number,real_name,clubs,booth_keys,status,issues,source_cells,source_sha256,catalog_keys)
      values(p_event,sid,name,clubs,keys,state,reasons,cells,source,catalog)
    on conflict(event_id,student_number) do update set real_name=excluded.real_name,clubs=excluded.clubs,booth_keys=excluded.booth_keys,
      status=excluded.status,issues=excluded.issues,source_cells=excluded.source_cells,source_sha256=excluded.source_sha256,
      catalog_keys=excluded.catalog_keys,version=old.version+1,updated_at=now()
    where (old.real_name,old.clubs,old.booth_keys,old.status,old.issues,old.source_cells,old.source_sha256,old.catalog_keys)
      is distinct from (excluded.real_name,excluded.clubs,excluded.booth_keys,excluded.status,excluded.issues,excluded.source_cells,excluded.source_sha256,excluded.catalog_keys);
  end loop;
  update festival_ops.review_roster set status='inactive',version=version+1,updated_at=now()
    where event_id=p_event and status<>'inactive' and student_number not in
      (select r->>'studentNumber' from jsonb_array_elements(p_document->'records') r);
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(p_event,p_actor,'maintenance_review_roster_import',source,'Owner import: '||n::text||' records; account links require independent verification');
  return (select jsonb_build_object('total',count(*),'ready',count(*) filter(where status='ready'),
    'pending',count(*) filter(where status='review_required'),'inactive',count(*) filter(where status='inactive'))
    from festival_ops.review_roster where event_id=p_event);
end $$;

revoke all on function festival_ops.review_policy(uuid,integer,text),festival_ops.guard_named_review(),
  festival_ops.block_legacy_review_write(),festival_ops.import_review_roster(uuid,jsonb,integer) from public,anon,authenticated;
revoke all on function public.festival_review_identity_admin(text,jsonb) from public,anon;
grant execute on function public.festival_review_identity_admin(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;

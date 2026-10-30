-- Approved repair: operator-verified review identity and single-event participation reset.
-- Apply after the 1.18 server updates. Installing this file changes functions only.
-- Existing self-registered links and published reviews are retained for operator review.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create or replace function festival_ops.identity_state(e uuid,u integer) returns jsonb
language plpgsql set search_path='' as $$
declare identity festival_ops.review_identities; roster festival_ops.review_roster; catalog text[]; valid boolean;
begin
  select * into identity from festival_ops.review_identities where event_id=e and user_id=u;
  select * into roster from festival_ops.review_roster where event_id=e and student_number=identity.student_number;
  select coalesce(array_agg(key order by key collate "C"),'{}') into catalog from festival_ops.booths where event_id=e;
  valid := coalesce(identity.verified and identity.confirmed_by<>u and roster.status='ready'
    and identity.roster_version=roster.version and roster.catalog_keys=catalog,false);
  return jsonb_build_object('verified',valid,
    'locked',coalesce(not identity.verified and identity.confirmed_by<>u,false),
    'selfRegistered',coalesce(identity.confirmed_by=u,false),
    'realName',case when valid then identity.real_name end,
    'clubs',case when valid then to_jsonb(roster.clubs) else '[]'::jsonb end,
    'boothKeys',case when valid then to_jsonb(identity.booth_keys) else '[]'::jsonb end);
end $$;

create or replace function festival_ops.review_policy(e uuid,u integer,b text) returns jsonb
language plpgsql set search_path='' as $$
declare identity festival_ops.review_identities; roster festival_ops.review_roster; reason text; catalog text[];
begin
  select * into identity from festival_ops.review_identities where event_id=e and user_id=u;
  select * into roster from festival_ops.review_roster where event_id=e and student_number=identity.student_number;
  select coalesce(array_agg(key order by key collate "C"),'{}') into catalog from festival_ops.booths where event_id=e;
  if identity.user_id is null or not identity.verified or identity.confirmed_by=u
    or roster.status is distinct from 'ready' or identity.roster_version is distinct from roster.version
    or roster.catalog_keys is distinct from catalog then reason:='REVIEW_IDENTITY_REQUIRED';
  elsif b=any(roster.booth_keys) then reason:='OWN_CLUB_REVIEW'; end if;
  return jsonb_build_object('version',1,'allowed',reason is null,'reason',reason,
    'authorName',case when reason is null then coalesce(
      (select author_name from festival_ops.reviews where event_id=e and user_id=u and booth_key=b),roster.real_name) end);
end $$;

create or replace function public.festival_review_identity_self(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; sid text; identity jsonb; result text;
begin
  if p_action is null or p_action not in ('status','confirm') or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>500 then raise exception 'INVALID_INPUT'; end if;
  -- Use the same lock order as operator writes; client metadata is never proof of identity.
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  identity:=festival_ops.identity_state(e,u);
  if (identity->>'verified')::boolean then
    select student_number into sid from festival_ops.review_identities where event_id=e and user_id=u;
  else sid:=me->>'studentNumber'; end if;
  if p_action='confirm' then
    if (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
    result:=case when (identity->>'verified')::boolean then 'CONFIRMED' else 'OPERATOR_LOCKED' end;
  end if;
  -- OPERATOR_LOCKED is understood by older clients too. No roster lookup or enrollment here.
  return jsonb_build_object('version',1,'eventId',e,'result',result,'studentNumber',sid,
    'eligible',coalesce(sid ~ '^[12][0-9]{4}$',false)) || identity;
end $$;

create or replace function public.festival_ops_reset(p_payload jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; old festival_ops.requests; fp bytea; result jsonb; identities boolean;
  c_vouchers integer; c_ledger integer; c_reviews integer; c_visits integer; c_identities integer:=0;
  c_stamps integer;
begin
  if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>500 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current for update;
  if e is null or (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
  if p_payload->>'confirm' is distinct from U&'\CD08\AE30\D654' then raise exception 'RESET_CONFIRM_REQUIRED'; end if;
  if jsonb_typeof(p_payload->'identities') is distinct from 'boolean' then raise exception 'INVALID_INPUT'; end if;
  identities:=(p_payload->>'identities')::boolean;
  fp:=extensions.digest('participation_reset:'||p_payload::text,'sha256');
  select * into old from festival_ops.requests where actor_id=u and request_id=p_request_id;
  if found then
    if old.fingerprint<>fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  -- Legacy mirrors and request receipts have no event column. Refuse an ambiguous reset.
  lock table festival_ops.events in share row exclusive mode;
  if exists(select 1 from festival_ops.events where id<>e) then raise exception 'RESET_SCOPE_UNAVAILABLE'; end if;

  -- Remove only legacy stamp entries backed by this event's actual NFC visits.
  update public.users a set completed_booths=array(
    select stamp from unnest(a.completed_booths) stamp where not exists(
      select 1 from festival_ops.visits v join festival_ops.booths b on b.event_id=v.event_id and b.key=v.booth_key
      where v.event_id=e and v.user_id=a.id and v.method='nfc' and b.legacy_key=stamp))
    where exists(select 1 from festival_ops.visits v join festival_ops.booths b on b.event_id=v.event_id and b.key=v.booth_key
      where v.event_id=e and v.user_id=a.id and v.method='nfc' and b.legacy_key=any(a.completed_booths));
  get diagnostics c_stamps=row_count;
  delete from festival_ops.vouchers where event_id=e; get diagnostics c_vouchers=row_count;
  delete from festival_ops.ledger where event_id=e; get diagnostics c_ledger=row_count;
  delete from festival_ops.reviews where event_id=e; get diagnostics c_reviews=row_count;
  delete from festival_ops.visits where event_id=e; get diagnostics c_visits=row_count;
  if identities then delete from festival_ops.review_identities where event_id=e; get diagnostics c_identities=row_count; end if;
  -- Preserve shared quests, money, legacy ratings, tag lifetime counters and all reset receipts.
  delete from festival_ops.requests where response->>'reset' is distinct from 'true';
  result:=jsonb_build_object('reset',true,'vouchers',c_vouchers,'points',c_ledger,'reviews',c_reviews,'visits',c_visits,
    'identities',c_identities,'ratings',0,'stampAccounts',c_stamps);
  insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e,u,'participation_reset',null,result::text);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;

revoke all on function festival_ops.identity_state(uuid,integer),festival_ops.review_policy(uuid,integer,text) from public,anon,authenticated;
revoke all on function public.festival_review_identity_self(text,jsonb),public.festival_ops_reset(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.festival_review_identity_self(text,jsonb),public.festival_ops_reset(jsonb,uuid) to authenticated;
notify pgrst,'reload schema';
commit;

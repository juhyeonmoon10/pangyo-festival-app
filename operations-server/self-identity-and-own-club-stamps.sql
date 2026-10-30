-- Approved 2026-10-30 (user request): students confirm their own club against the uploaded roster,
-- and no participant can earn a stamp at their own club's booth. Apply after
-- operator-identity-and-scoped-reset.sql. No table is added.
-- 1. Self-confirmation returns: the sign-up student number must be on the ready roster and the typed
--    name must match it. One roster row links to one account; conflicting attempts are audited and
--    listed for operators, who can revoke or relink any account. An operator-revoked link stays locked.
-- 2. festival_ops.own_booths: a verified link's booths, or before verification the roster booths of the
--    sign-up student number. NFC claims and manual approvals at those booths raise OWN_CLUB_STAMP.
-- 3. Existing own-club stamps are removed now and whenever an account is (re)confirmed. The legacy
--    completed_booths mirror loses only the entries backed by a removed NFC visit. Issued vouchers stay.
-- 4. public.festival_identity_overview: operator summary of roster, links, conflicts and removals.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create function festival_ops.own_booths(e uuid,u integer) returns text[]
language plpgsql stable set search_path='' as $$
declare keys text[]; sid text;
begin
  select booth_keys into keys from festival_ops.review_identities where event_id=e and user_id=u and verified;
  if keys is not null then return keys; end if;
  select btrim(a.raw_user_meta_data->>'festival_student_number') into sid
    from public.users p join auth.users a on a.id=p.auth_user_id where p.id=u;
  select r.booth_keys into keys from festival_ops.review_roster r
    where r.event_id=e and r.student_number=sid and r.status='ready';
  return coalesce(keys,'{}');
end $$;

create function festival_ops.strip_own_club_stamps(e uuid,u integer,actor integer) returns integer
language plpgsql set search_path='' as $$
declare keys text[]; legacy public.booth_enum[]; removed integer;
begin
  keys:=festival_ops.own_booths(e,u);
  if cardinality(keys)=0 then return 0; end if;
  with gone as (delete from festival_ops.visits where event_id=e and user_id=u and booth_key=any(keys) returning booth_key,method)
  select count(*),coalesce(array_agg(b.legacy_key) filter (where g.method='nfc' and b.legacy_key is not null),'{}')
    into removed,legacy from gone g left join festival_ops.booths b on b.event_id=e and b.key=g.booth_key;
  if cardinality(legacy)>0 then
    update public.users set completed_booths=array(select s from unnest(completed_booths) s where s<>all(legacy))
      where id=u and completed_booths && legacy;
  end if;
  if removed>0 then
    insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e,actor,'own_club_stamp_remove',u::text,removed::text);
  end if;
  return removed;
end $$;

create function festival_ops.block_own_club_visit() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.booth_key=any(festival_ops.own_booths(new.event_id,new.user_id)) then
    raise exception using errcode='42501', message='OWN_CLUB_STAMP';
  end if;
  return new;
end $$;
create trigger visits_block_own_club before insert on festival_ops.visits
  for each row execute function festival_ops.block_own_club_visit();

create function festival_ops.strip_after_identity() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.verified then perform festival_ops.strip_own_club_stamps(new.event_id,new.user_id,new.confirmed_by); end if;
  return null;
end $$;
create trigger review_identities_strip_own_club after insert or update of verified,booth_keys on festival_ops.review_identities
  for each row execute function festival_ops.strip_after_identity();

-- Self-confirmed and operator-confirmed links are both valid.
create or replace function festival_ops.identity_state(e uuid,u integer) returns jsonb
language plpgsql set search_path='' as $$
declare identity festival_ops.review_identities; roster festival_ops.review_roster; catalog text[]; valid boolean;
begin
  select * into identity from festival_ops.review_identities where event_id=e and user_id=u;
  select * into roster from festival_ops.review_roster where event_id=e and student_number=identity.student_number;
  select coalesce(array_agg(key order by key collate "C"),'{}') into catalog from festival_ops.booths where event_id=e;
  valid := coalesce(identity.verified and roster.status='ready' and identity.roster_version=roster.version
    and roster.catalog_keys=catalog,false);
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
  if identity.user_id is null or not identity.verified
    or roster.status is distinct from 'ready' or identity.roster_version is distinct from roster.version
    or roster.catalog_keys is distinct from catalog then reason:='REVIEW_IDENTITY_REQUIRED';
  elsif b=any(roster.booth_keys) then reason:='OWN_CLUB_REVIEW'; end if;
  return jsonb_build_object('version',1,'allowed',reason is null,'reason',reason,
    'authorName',case when reason is null then coalesce(
      (select author_name from festival_ops.reviews where event_id=e and user_id=u and booth_key=b),roster.real_name) end);
end $$;

create or replace function public.festival_review_identity_self(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; sid text; roster festival_ops.review_roster; catalog text[];
  identity jsonb; failures integer; result text; typed text; holder integer;
begin
  if p_action is null or p_action not in ('status','confirm') or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>500 then raise exception 'INVALID_INPUT'; end if;
  -- Same lock order as operator writes.
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  identity:=festival_ops.identity_state(e,u);
  -- A confirmed link keeps its student number even if the sign-up profile is edited later.
  if (identity->>'verified')::boolean then
    select student_number into sid from festival_ops.review_identities where event_id=e and user_id=u;
  else sid:=me->>'studentNumber'; end if;
  if p_action='confirm' then
    if (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
    typed:=btrim(p_payload->>'realName');
    if typed is null or length(typed) not between 1 and 60 then raise exception 'INVALID_INPUT'; end if;
    if (identity->>'verified')::boolean then result:='CONFIRMED';
    elsif (identity->>'locked')::boolean then result:='OPERATOR_LOCKED';
    elsif sid is null or sid !~ '^[12][0-9]{4}$' then result:='ROSTER_NOT_FOUND';
    else
      select count(*) into failures from festival_ops.audit where event_id=e and actor_id=u
        and action in ('review_identity_self_mismatch','review_identity_self_conflict') and created_at>now()-interval '1 hour';
      select * into roster from festival_ops.review_roster where event_id=e and student_number=sid;
      select coalesce(array_agg(key order by key collate "C"),'{}') into catalog from festival_ops.booths where event_id=e;
      select user_id into holder from festival_ops.review_identities where event_id=e and student_number=sid and user_id<>u and verified;
      if failures>=5 then result:='TOO_MANY_ATTEMPTS';
      elsif roster.student_number is null or roster.status<>'ready' or roster.catalog_keys is distinct from catalog then
        result:='ROSTER_NOT_FOUND';
      elsif regexp_replace(normalize(roster.real_name,NFKC),'\s','','g') is distinct from regexp_replace(normalize(typed,NFKC),'\s','','g') then
        result:='IDENTITY_MISMATCH';
        -- Count attempts without storing the typed name.
        insert into festival_ops.audit(event_id,actor_id,action,target) values(e,u,'review_identity_self_mismatch',u::text);
      elsif holder is not null then
        result:='ROSTER_ALREADY_LINKED';
        -- Operators see both accounts and decide which one is the actual student.
        insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e,u,'review_identity_self_conflict',u::text,holder::text);
      else
        -- An operator-revoked link on another account no longer holds this student number.
        delete from festival_ops.review_identities where event_id=e and student_number=sid and user_id<>u and not verified;
        insert into festival_ops.review_identities(event_id,user_id,real_name,booth_keys,verified,version,confirmed_by,student_number,roster_version)
          values(e,u,roster.real_name,roster.booth_keys,true,1,u,sid,roster.version)
        on conflict(event_id,user_id) do update set real_name=excluded.real_name,booth_keys=excluded.booth_keys,verified=true,
          version=festival_ops.review_identities.version+1,confirmed_by=u,student_number=excluded.student_number,
          roster_version=excluded.roster_version,updated_at=now();
        insert into festival_ops.audit(event_id,actor_id,action,target) values(e,u,'review_identity_self_confirm',u::text);
        result:='CONFIRMED';
      end if;
    end if;
    identity:=festival_ops.identity_state(e,u);
  end if;
  return jsonb_build_object('version',1,'eventId',e,'result',result,'studentNumber',sid,
    'eligible',coalesce(sid ~ '^[12][0-9]{4}$',false)) || identity;
end $$;

-- NFC claims at an own-club booth are refused before the legacy mirror or tag counter changes.
create or replace function festival_nfc_private.claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb;
  config jsonb;
  payload jsonb;
  encoded text;
  expected text;
  booth public.booth_enum;
  profile public.users%rowtype;
  duplicate boolean;
  tag_id text;
  stopped boolean;
  guard festival_ops.claim_guard;
  recent integer;
  current_event uuid;
begin
  me := festival_nfc_private.current_profile();
  if (me->>'needsProfile')::boolean then
    raise exception using errcode = '42501', message = 'PROFILE_REQUIRED';
  end if;
  select decrypted_secret::jsonb into config from vault.decrypted_secrets where name = 'pangyo_festival_nfc_v1';
  if config is null or coalesce((config->>'enabled')::boolean, false) is not true then
    raise exception using errcode = '42501', message = 'NFC_DISABLED';
  end if;
  if p_token is null or length(p_token) > 1024
    or p_token !~ '^nf1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
  end if;
  encoded := split_part(p_token, '.', 2);
  expected := encode(extensions.hmac(convert_to('nf1.' || encoded, 'UTF8'), decode(config->>'key', 'hex'), 'sha256'), 'hex');
  if split_part(p_token, '.', 3) <> expected then
    raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
  end if;
  begin
    payload := convert_from(decode(rpad(translate(encoded, '-_', '+/'), ((length(encoded)+3)/4)*4, '='), 'base64'), 'UTF8')::jsonb;
    booth := (payload->>'booth')::public.booth_enum;
    if payload->>'epoch' is distinct from config->>'epoch' then
      raise exception 'NFC_TAG_EXPIRED';
    end if;
    -- Only an explicitly signed permanent payload bypasses the clock check.
    if payload->>'lifetime' = 'permanent' then
      if (payload->'expires') is distinct from 'null'::jsonb
        or coalesce(payload->>'nonce', '') !~ '^[0-9a-f]{32}$' then
        raise exception 'NFC_TAG_EXPIRED';
      end if;
    elsif payload ? 'lifetime' or payload->>'expires' is null
      or payload->>'expires' !~ '^[0-9]{1,12}$'
      or (payload->>'expires')::bigint <= extract(epoch from now()) then
      raise exception 'NFC_TAG_EXPIRED';
    end if;
  exception when others then
    raise exception using errcode = '22023', message = 'NFC_TAG_EXPIRED';
  end;
  if booth is null or not exists(select 1 from public.booths where id = booth) then
    raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
  end if;
  -- A tag issued before the registry appears in the operator list on its first scan.
  tag_id := festival_nfc_private.tag_register(encoded, payload, 'discovered', null);
  if tag_id is not null then
    select revoked_at is not null into stopped from festival_nfc_private.tags where id = tag_id for update;
    if stopped then
      raise exception using errcode = '22023', message = 'NFC_TAG_EXPIRED';
    end if;
  end if;
  select id into current_event from festival_ops.events where current;
  if current_event is not null and exists(select 1 from festival_ops.booths b where b.event_id = current_event
      and b.legacy_key = booth and b.key = any(festival_ops.own_booths(current_event, (me->>'id')::integer))) then
    raise exception using errcode = '42501', message = 'OWN_CLUB_STAMP';
  end if;
  -- Rate limit: a new booth beyond the operator's "N stamps in M minutes" is refused.
  -- Re-scanning an already earned booth is never limited.
  guard := festival_ops.claim_guard_of(current_event);
  if guard.enabled and guard.event_id is not null and not exists(select 1 from festival_ops.visits v
      join festival_ops.booths b on b.event_id = v.event_id and b.key = v.booth_key
      where v.event_id = guard.event_id and v.user_id = (me->>'id')::integer and b.legacy_key = booth) then
    select count(*) into recent from festival_ops.visits
      where event_id = guard.event_id and user_id = (me->>'id')::integer and method = 'nfc'
        and created_at > now() - make_interval(mins => guard.window_minutes);
    if recent >= guard.max_claims then
      raise exception using errcode = '42501', message = 'CLAIM_RATE_LIMITED';
    end if;
  end if;
  select * into profile from public.users where id = (me->>'id')::integer and auth_user_id = auth.uid() for update;
  if not found then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;
  duplicate := coalesce(booth = any(profile.completed_booths), false);
  if not duplicate then
    update public.users set completed_booths = array_append(completed_booths, booth)
      where id = profile.id returning * into profile;
  end if;
  if tag_id is not null then
    update festival_nfc_private.tags set use_count = use_count + 1, last_used_at = now() where id = tag_id;
  end if;
  return jsonb_build_object('result', case when duplicate then 'ALREADY_EARNED' else 'EARNED' end,
    'boothKey', booth, 'completedBooths', to_jsonb(profile.completed_booths), 'checkedAt', now());
end $$;

-- Operators: roster coverage, link counts, accounts that tried a student number already linked
-- elsewhere, and own-club stamps removed. Names shown are account names already visible to operators.
create function public.festival_identity_overview() returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; e uuid;
begin
  me:=festival_nfc_private.current_profile();
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  return jsonb_build_object('eventId',e,
    'roster',(select jsonb_build_object('students',count(*),'ready',count(*) filter (where status='ready'),
      'review',count(*) filter (where status<>'ready'),'withBooth',count(*) filter (where status='ready' and cardinality(booth_keys)>0))
      from festival_ops.review_roster where event_id=e),
    'links',(select jsonb_build_object('self',count(*) filter (where verified and confirmed_by=user_id),
      'operator',count(*) filter (where verified and confirmed_by<>user_id),'revoked',count(*) filter (where not verified))
      from festival_ops.review_identities where event_id=e),
    'removedStamps',(select coalesce(sum(reason::integer),0) from festival_ops.audit where event_id=e and action='own_club_stamp_remove'),
    'conflicts',coalesce((select jsonb_agg(jsonb_build_object('userId',x.actor_id,'accountName',ua.name,
        'holderId',x.reason::integer,'holderName',uh.name,'at',x.created_at) order by x.id desc)
      from (select * from festival_ops.audit where event_id=e and action='review_identity_self_conflict' order by id desc limit 20) x
      left join public.users ua on ua.id=x.actor_id left join public.users uh on uh.id=x.reason::integer),'[]'::jsonb),
    'removals',coalesce((select jsonb_agg(jsonb_build_object('userId',x.target::integer,'accountName',ut.name,
        'count',x.reason::integer,'at',x.created_at) order by x.id desc)
      from (select * from festival_ops.audit where event_id=e and action='own_club_stamp_remove' order by id desc limit 20) x
      left join public.users ut on ut.id=x.target::integer),'[]'::jsonb));
end $$;

revoke all on function festival_ops.own_booths(uuid,integer),festival_ops.strip_own_club_stamps(uuid,integer,integer),
  festival_ops.block_own_club_visit(),festival_ops.strip_after_identity(),
  festival_ops.identity_state(uuid,integer),festival_ops.review_policy(uuid,integer,text) from public,anon,authenticated;
revoke all on function public.festival_review_identity_self(text,jsonb),public.festival_identity_overview() from public,anon,authenticated;
grant execute on function public.festival_review_identity_self(text,jsonb),public.festival_identity_overview() to authenticated;

-- Remove own-club stamps that already exist for the current festival.
do $$
declare e uuid; r record;
begin
  select id into e from festival_ops.events where current;
  if e is null then return; end if;
  for r in select distinct user_id from festival_ops.visits where event_id=e loop
    perform festival_ops.strip_own_club_stamps(e,r.user_id,r.user_id);
  end loop;
end $$;

notify pgrst,'reload schema';
commit;

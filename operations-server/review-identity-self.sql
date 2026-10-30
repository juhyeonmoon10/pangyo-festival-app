-- Approved 2026-10-30: students confirm their own club membership against the official roster.
-- Apply after review-identity.draft.sql (installed) and voucher-unlimited-and-reset.sql.
-- A student whose profile student number is on the roster and who types the roster name is linked
-- immediately (auto-approval). Operators list every link and can revoke or relink it. A link revoked
-- by an operator cannot be re-created by that student, and no longer reserves the student number.
-- No table is added; review_policy and the review triggers are unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

-- Same validity rule as review_policy: verified, roster ready, same roster version and booth catalog.
create function festival_ops.identity_state(e uuid,u integer) returns jsonb
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

create function public.festival_review_identity_self(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; sid text; roster festival_ops.review_roster; catalog text[];
  identity jsonb; failures integer; result text; typed text;
begin
  if p_action is null or p_action not in ('status','confirm') or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>500 then raise exception 'INVALID_INPUT'; end if;
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  -- The student number registered at sign-up is used; the browser never chooses it.
  sid:=me->>'studentNumber';
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  if p_action='confirm' then
    perform pg_catalog.pg_advisory_xact_lock(170926,1);
    if (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
    typed:=btrim(p_payload->>'realName');
    if typed is null or length(typed) not between 1 and 60 then raise exception 'INVALID_INPUT'; end if;
    identity:=festival_ops.identity_state(e,u);
    if (identity->>'verified')::boolean then result:='CONFIRMED';
    elsif (identity->>'locked')::boolean then result:='OPERATOR_LOCKED';
    elsif sid is null or sid !~ '^[12][0-9]{4}$' then result:='ROSTER_NOT_FOUND';
    else
      select count(*) into failures from festival_ops.audit
        where event_id=e and actor_id=u and action='review_identity_self_mismatch' and created_at>now()-interval '1 hour';
      select * into roster from festival_ops.review_roster where event_id=e and student_number=sid;
      select coalesce(array_agg(key order by key collate "C"),'{}') into catalog from festival_ops.booths where event_id=e;
      if failures>=5 then result:='TOO_MANY_ATTEMPTS';
      elsif roster.student_number is null or roster.status<>'ready' or roster.catalog_keys is distinct from catalog then
        result:='ROSTER_NOT_FOUND';
      elsif regexp_replace(normalize(roster.real_name,NFKC),'\s','','g') is distinct from regexp_replace(normalize(typed,NFKC),'\s','','g') then
        result:='IDENTITY_MISMATCH';
        -- Count attempts without storing the typed name.
        insert into festival_ops.audit(event_id,actor_id,action,target) values(e,u,'review_identity_self_mismatch',u::text);
      elsif exists(select 1 from festival_ops.review_identities where event_id=e and student_number=sid and user_id<>u and verified) then
        result:='ROSTER_ALREADY_LINKED';
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
  end if;
  return jsonb_build_object('version',1,'eventId',e,'result',result,'studentNumber',sid,
    'eligible',coalesce(sid ~ '^[12][0-9]{4}$',false)) || festival_ops.identity_state(e,u);
end $$;

CREATE OR REPLACE FUNCTION public.festival_review_identity_admin(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb; actor integer; target integer; e uuid; row festival_ops.review_identities;
  roster festival_ops.review_roster; why text; account_name text; v integer; sid text;
  catalog text[]; usable boolean; candidate jsonb; q text; offn integer; items jsonb;
begin
  me := festival_nfc_private.current_profile(); actor := (me->>'id')::integer;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_action is null or p_action not in ('get','lookup','save','revoke','list') or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>20000 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  select id into e from festival_ops.events where current;
  if e is null or (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
  if p_action='list' then
    q := left(btrim(coalesce(p_payload->>'search','')),100);
    offn := greatest(0,least(100000,coalesce((p_payload->>'offset')::integer,0)));
    select coalesce(jsonb_agg(x.item order by x.ts desc),'[]'::jsonb) into items from (
      select i.updated_at ts,jsonb_build_object('userId',i.user_id,'accountName',a.name,'realName',i.real_name,
        'studentNumber',i.student_number,'clubs',coalesce(to_jsonb(r.clubs),'[]'::jsonb),'boothKeys',to_jsonb(i.booth_keys),
        'selfRegistered',i.confirmed_by=i.user_id,'state',festival_ops.identity_state(e,i.user_id),'updatedAt',i.updated_at) item
      from festival_ops.review_identities i join public.users a on a.id=i.user_id
      left join festival_ops.review_roster r on r.event_id=i.event_id and r.student_number=i.student_number
      where i.event_id=e and (q='' or a.name ilike '%'||q||'%' or i.real_name ilike '%'||q||'%' or i.student_number=q)
      order by i.updated_at desc offset offn limit 50) x;
    insert into festival_ops.audit(event_id,actor_id,action,target) values(e,actor,'review_identity_list',null);
    return jsonb_build_object('eventId',e,'items',items,
      'counts',(select jsonb_build_object('linked',count(*) filter(where verified),'self',count(*) filter(where verified and confirmed_by=user_id),
        'revoked',count(*) filter(where not verified)) from festival_ops.review_identities where event_id=e));
  end if;
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
      if exists(select 1 from festival_ops.review_identities where event_id=e and student_number=sid and user_id<>target and verified) then
        raise exception 'ROSTER_ALREADY_LINKED'; end if;
      -- A revoked link elsewhere does not reserve the student number.
      delete from festival_ops.review_identities where event_id=e and student_number=sid and user_id<>target and not verified;
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
      'linkedElsewhere',exists(select 1 from festival_ops.review_identities where event_id=e and student_number=sid and user_id<>target and verified));
  end if;
  -- Audit the account accessed, never copy a student number, name or workbook row.
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(e,actor,'review_identity_'||p_action,target::text,why);
  return jsonb_build_object('eventId',e,'userId',target,'accountName',account_name,'realName',row.real_name,
    'boothKeys',coalesce(to_jsonb(row.booth_keys),'[]'),'verified',coalesce(row.verified,false),'version',coalesce(row.version,0),
    'rosterVersion',row.roster_version,'roster',candidate,
    'selfRegistered',coalesce(row.confirmed_by=row.user_id,false));
end $$;

revoke all on function festival_ops.identity_state(uuid,integer) from public,anon,authenticated;
revoke all on function public.festival_review_identity_self(text,jsonb) from public,anon,authenticated;
grant execute on function public.festival_review_identity_self(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;

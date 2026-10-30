-- Rollback for nfc-tag-registry.sql: restores the previous claim/admin_issue, removes tag management
-- and the tag registry, and keeps the pg_safeupdate-compatible reset (the old one always failed).
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

drop function public.festival_nfc_tag_admin(text, jsonb);

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
  select * into profile from public.users where id = (me->>'id')::integer and auth_user_id = auth.uid() for update;
  if not found then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;
  duplicate := coalesce(booth = any(profile.completed_booths), false);
  if not duplicate then
    update public.users set completed_booths = array_append(completed_booths, booth)
      where id = profile.id returning * into profile;
  end if;
  return jsonb_build_object('result', case when duplicate then 'ALREADY_EARNED' else 'EARNED' end,
    'boothKey', booth, 'completedBooths', to_jsonb(profile.completed_booths), 'checkedAt', now());
end $$;

create or replace function festival_nfc_private.admin_issue(p_booth text, p_valid_minutes integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb;
  is_admin boolean;
  booth public.booth_enum;
  expires timestamptz;
  token text;
begin
  me := festival_nfc_private.current_profile();
  select admin into is_admin from public.users
    where id = (me->>'id')::integer and auth_user_id = auth.uid();
  if coalesce(is_admin, false) is not true then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  -- null requests a permanent tag; finite values remain compatible with older clients.
  if p_valid_minutes is not null and (p_valid_minutes < 1 or p_valid_minutes > 7 * 24 * 60) then
    raise exception using errcode = '22023', message = 'INVALID_TAG_ISSUE_REQUEST';
  end if;
  if p_booth is null or length(p_booth) > 120
    or not exists(select 1 from public.booths where id::text = p_booth) then
    raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
  end if;
  booth := p_booth::public.booth_enum;
  expires := case when p_valid_minutes is null then null
    else date_trunc('second', now()) + make_interval(mins => p_valid_minutes) end;
  token := festival_nfc_private.issue_tag(booth, expires);
  return jsonb_build_object('token', token, 'boothKey', booth, 'expiresAt', expires,
    'issuedAt', now(), 'validMinutes', p_valid_minutes);
end $$;

create or replace function public.festival_ops_reset(p_payload jsonb, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; old festival_ops.requests; fp bytea; result jsonb; identities boolean;
  c_vouchers integer; c_ledger integer; c_reviews integer; c_visits integer; c_identities integer:=0;
  c_ratings integer; c_stamps integer; c_requests integer;
begin
  if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>500 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current for update;
  if e is null or (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
  if p_payload->>'confirm' is distinct from '초기화' then raise exception 'RESET_CONFIRM_REQUIRED'; end if;
  if jsonb_typeof(p_payload->'identities') is distinct from 'boolean' then raise exception 'INVALID_INPUT'; end if;
  identities:=(p_payload->>'identities')::boolean;
  fp:=extensions.digest('participation_reset:'||p_payload::text,'sha256');
  select * into old from festival_ops.requests where actor_id=u and request_id=p_request_id;
  if found then
    if old.fingerprint<>fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  -- Children before parents: reviews reference visits.
  delete from festival_ops.vouchers where event_id=e; get diagnostics c_vouchers=row_count;
  delete from festival_ops.ledger where event_id=e; get diagnostics c_ledger=row_count;
  delete from festival_ops.reviews where event_id=e; get diagnostics c_reviews=row_count;
  delete from festival_ops.visits where event_id=e; get diagnostics c_visits=row_count;
  if identities then delete from festival_ops.review_identities where event_id=e; get diagnostics c_identities=row_count; end if;
  -- Legacy stamp and rating records shown by the same app. The rating trigger resets booth averages.
  delete from public.booth_ratings where booth_id is not null; get diagnostics c_ratings=row_count;
  update public.booths set rating=0 where rating<>0;
  update public.users set completed_booths='{}',completed_quests='{}'
    where cardinality(completed_booths)>0 or cardinality(completed_quests)>0;
  get diagnostics c_stamps=row_count;
  -- Cached responses would otherwise replay deleted records.
  delete from festival_ops.requests where request_id is not null; get diagnostics c_requests=row_count;
  result:=jsonb_build_object('reset',true,'vouchers',c_vouchers,'points',c_ledger,'reviews',c_reviews,'visits',c_visits,
    'identities',c_identities,'ratings',c_ratings,'stampAccounts',c_stamps);
  insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e,u,'participation_reset',null,result::text);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;

drop function festival_nfc_private.tag_register(text, jsonb, text, integer);
drop table festival_nfc_private.tags;

notify pgrst,'reload schema';
commit;

-- Approved scope: replace these three existing NFC functions only.
-- No tables, policies, grants, secrets, student records, or legacy tokens are changed.
-- Compare deployed definitions with the reviewed baseline before applying.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if to_regprocedure('festival_nfc_private.claim(text)') is null
    or to_regprocedure('festival_nfc_private.issue_tag(public.booth_enum, timestamptz)') is null
    or to_regprocedure('festival_nfc_private.admin_issue(text, integer)') is null then
    raise exception 'NFC_INSTALL_REQUIRED_FIRST';
  end if;
  -- Refuse to overwrite a different deployment or silently run this update twice.
  if exists (
    select 1 from (values
      ('festival_nfc_private.admin_issue(text,integer)', 'd968c39ae7bc6bcd9b8ab31fce06fa13'),
      ('festival_nfc_private.claim(text)', '839dbdecd5295d6e25a6a55695bd3471'),
      ('festival_nfc_private.issue_tag(public.booth_enum,timestamptz)', '8da2fbc1164e56337d0832241c31ac01')
    ) expected(signature, body_hash)
    join pg_proc p on p.oid = to_regprocedure(expected.signature)
    where md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) <> expected.body_hash
  ) then
    raise exception 'NFC_SOURCE_CHANGED_REVIEW_REQUIRED';
  end if;
  perform set_config('festival.nfc_permissions_before', (
    select jsonb_agg(jsonb_build_object('oid', p.oid, 'owner', p.proowner,
      'acl', p.proacl::text, 'definer', p.prosecdef, 'config', p.proconfig::text) order by p.oid)::text
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='festival_nfc_private'
  ), true);
end $$;

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

create or replace function festival_nfc_private.issue_tag(p_booth public.booth_enum, p_expires timestamptz) returns text
language plpgsql security invoker set search_path = '' as $$
declare config jsonb; encoded text; payload jsonb;
begin
  if p_booth is null
    or (p_expires is not null and (p_expires <= now() or p_expires > now() + interval '7 days'))
    or not exists(select 1 from public.booths where id = p_booth) then
    raise exception 'INVALID_TAG_ISSUE_REQUEST';
  end if;
  select decrypted_secret::jsonb into config from vault.decrypted_secrets where name = 'pangyo_festival_nfc_v1';
  if config is null or coalesce((config->>'enabled')::boolean, false) is not true then
    raise exception 'NFC_DISABLED';
  end if;
  payload := jsonb_build_object('booth', p_booth,
    'expires', floor(extract(epoch from p_expires))::bigint, 'epoch', config->>'epoch',
    'nonce', encode(extensions.gen_random_bytes(16), 'hex'));
  if p_expires is null then
    payload := payload || jsonb_build_object('lifetime', 'permanent');
  end if;
  encoded := rtrim(translate(replace(encode(convert_to(payload::text, 'UTF8'), 'base64'), E'\n', ''), '+/', '-_'), '=');
  return 'nf1.' || encoded || '.' || encode(extensions.hmac(convert_to('nf1.' || encoded, 'UTF8'), decode(config->>'key', 'hex'), 'sha256'), 'hex');
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

-- Validate with the real signing provider without exposing tokens or creating visits.
do $$
declare
  permissions jsonb;
  booth public.booth_enum;
  token text;
  encoded text;
  payload jsonb;
begin
  select jsonb_agg(jsonb_build_object('oid', p.oid, 'owner', p.proowner,
    'acl', p.proacl::text, 'definer', p.prosecdef, 'config', p.proconfig::text) order by p.oid)
    into permissions from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='festival_nfc_private';
  if permissions is distinct from current_setting('festival.nfc_permissions_before')::jsonb then
    raise exception 'NFC_PERMISSION_CHANGE_ABORTED';
  end if;
  select id into booth from public.booths order by id::text limit 1;
  if booth is null then raise exception 'NFC_BOOTH_REQUIRED_FOR_VERIFICATION'; end if;
  token := festival_nfc_private.issue_tag(booth, null);
  encoded := split_part(token, '.', 2);
  payload := convert_from(decode(rpad(translate(encoded, '-_', '+/'), ((length(encoded)+3)/4)*4, '='), 'base64'), 'UTF8')::jsonb;
  if (payload->>'lifetime') is distinct from 'permanent'
    or (payload->'expires') is distinct from 'null'::jsonb
    or coalesce(payload->>'nonce', '') !~ '^[0-9a-f]{32}$'
    or token !~ '^nf1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$' then
    raise exception 'NFC_PERMANENT_VERIFICATION_FAILED';
  end if;
  token := festival_nfc_private.issue_tag(booth, now()+interval '1 hour');
  encoded := split_part(token, '.', 2);
  payload := convert_from(decode(rpad(translate(encoded, '-_', '+/'), ((length(encoded)+3)/4)*4, '='), 'base64'), 'UTF8')::jsonb;
  if payload ? 'lifetime' or payload->>'expires' is null
    or (payload->>'expires')::bigint <= extract(epoch from now()) then
    raise exception 'NFC_LEGACY_VERIFICATION_FAILED';
  end if;
end $$;

commit;
select 'NFC_PERMANENT_UPDATE_APPLIED' as result, 3 as updated_functions,
  'unchanged' as permissions, 'unchanged' as student_records;

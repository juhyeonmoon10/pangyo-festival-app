-- Approved scope: existing public.users, new NFC functions, no new tables.
-- Reviewed deployment artifact. Do not run the old standalone NFC schema.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.users') is null or to_regclass('public.booths') is null
    or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'REQUIRED_EXISTING_OBJECT_MISSING';
  end if;
  if has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT')
    or has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT') then
    raise exception 'VAULT_ACCESS_MUST_BE_PRIVATE';
  end if;
  if exists(select 1 from pg_namespace where nspname = 'festival_nfc_private') then
    raise exception 'NFC_ALREADY_INSTALLED_REVIEW_BEFORE_UPDATING';
  end if;
end $$;

create schema festival_nfc_private;
revoke all on schema festival_nfc_private from public, anon, authenticated;
grant usage on schema festival_nfc_private to authenticated;

-- The existing Vault stores the signing material; never place it in a function body.
select vault.create_secret(
  jsonb_build_object('key', encode(extensions.gen_random_bytes(32), 'hex'),
    'epoch', encode(extensions.gen_random_bytes(16), 'hex'), 'enabled', true)::text,
  'pangyo_festival_nfc_v1', 'Personal festival NFC: existing users.completed_booths only'
);

alter policy users_authenticated_select on public.users
  using (auth_user_id = (select auth.uid()));
alter policy users_authenticated_update on public.users
  using (false) with check (false);
revoke update on public.users from anon, authenticated;
revoke update(id, name, email, money, completed_booths, completed_quests, admin, rank, auth_user_id)
  on public.users from anon, authenticated;

create function festival_nfc_private.current_profile() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  session_text text := auth.jwt()->>'session_id';
  account auth.users%rowtype;
  profile public.users%rowtype;
  display_name text;
  student_number text;
begin
  if uid is null or session_text is null
    or session_text !~ '^[0-9a-fA-F-]{36}$' then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;
  select * into account from auth.users where id = uid;
  if not found or account.email_confirmed_at is null
    or account.banned_until > now()
    or coalesce(account.raw_app_meta_data->>'provider', '') <> 'google'
    or not exists(select 1 from auth.sessions where id = session_text::uuid and user_id = uid
      and (not_after is null or not_after > now())) then
    raise exception using errcode = '42501', message = 'GOOGLE_AUTH_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  if (select count(*) from public.users where auth_user_id = uid) > 1 then
    raise exception using errcode = '23505', message = 'PROFILE_CONFLICT';
  end if;
  select * into profile from public.users where auth_user_id = uid;
  if not found then
    select * into profile from public.users where email = account.email for update;
    if found then
      if profile.auth_user_id is not null then
        raise exception using errcode = '23505', message = 'PROFILE_CONFLICT';
      end if;
      update public.users set auth_user_id = uid where id = profile.id returning * into profile;
    else
      insert into public.users(auth_user_id, email, name)
        values(uid, account.email, left(coalesce(account.raw_user_meta_data->>'full_name', 'Student'), 80))
        returning * into profile;
    end if;
  end if;
  display_name := btrim(coalesce(account.raw_user_meta_data->>'festival_name', ''));
  student_number := btrim(coalesce(account.raw_user_meta_data->>'festival_student_number', ''));
  -- isAdmin reports the caller's own existing users.admin flag so the app can show operator
  -- screens. Every privileged action is still re-checked server side; this value grants nothing.
  return jsonb_build_object('id', profile.id, 'authUserId', uid, 'name', display_name,
    'email', account.email, 'studentNumber', student_number,
    'needsProfile', not (length(display_name) between 1 and 60 and student_number ~ '^[1-3][0-9]{4}$'),
    'isAdmin', coalesce(profile.admin, false),
    'completedBooths', to_jsonb(profile.completed_booths));
end $$;

create function festival_nfc_private.claim(p_token text) returns jsonb
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
    if payload->>'expires' is null or payload->>'expires' !~ '^[0-9]{1,12}$'
      or payload->>'epoch' is distinct from config->>'epoch'
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

-- Operator-only minting. No browser role can create valid NFC tokens.
create function festival_nfc_private.issue_tag(p_booth public.booth_enum, p_expires timestamptz) returns text
language plpgsql security invoker set search_path = '' as $$
declare config jsonb; encoded text;
begin
  if p_expires is null or p_booth is null or p_expires <= now() or p_expires > now() + interval '7 days'
    or not exists(select 1 from public.booths where id = p_booth) then
    raise exception 'INVALID_TAG_ISSUE_REQUEST';
  end if;
  select decrypted_secret::jsonb into config from vault.decrypted_secrets where name = 'pangyo_festival_nfc_v1';
  if config is null or coalesce((config->>'enabled')::boolean, false) is not true then
    raise exception 'NFC_DISABLED';
  end if;
  encoded := rtrim(translate(replace(encode(convert_to(jsonb_build_object('booth', p_booth,
    'expires', floor(extract(epoch from p_expires))::bigint, 'epoch', config->>'epoch',
    'nonce', encode(extensions.gen_random_bytes(16), 'hex'))::text, 'UTF8'), 'base64'), E'\n', ''), '+/', '-_'), '=');
  return 'nf1.' || encoded || '.' || encode(extensions.hmac(convert_to('nf1.' || encoded, 'UTF8'), decode(config->>'key', 'hex'), 'sha256'), 'hex');
end $$;

create function public.festival_nfc_profile() returns jsonb
language sql security invoker set search_path = '' as $$ select festival_nfc_private.current_profile(); $$;
create function public.festival_nfc_claim(p_token text) returns jsonb
language sql security invoker set search_path = '' as $$ select festival_nfc_private.claim(p_token); $$;

revoke all on all functions in schema festival_nfc_private from public, anon, authenticated;
grant execute on function festival_nfc_private.current_profile(), festival_nfc_private.claim(text) to authenticated;
revoke all on function public.festival_nfc_profile(), public.festival_nfc_claim(text) from public, anon, authenticated;
grant execute on function public.festival_nfc_profile(), public.festival_nfc_claim(text) to authenticated;

notify pgrst, 'reload schema';
commit;

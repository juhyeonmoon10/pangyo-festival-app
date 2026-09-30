-- Append to install.sql INSTEAD OF its COMMIT. All fixture rows and DDL roll back.
select set_config('pangyo.test_uid', extensions.gen_random_uuid()::text, true);
select set_config('pangyo.test_other_uid', extensions.gen_random_uuid()::text, true);
select set_config('pangyo.test_session', extensions.gen_random_uuid()::text, true);

insert into auth.users(id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select id, 'nfc-test-' || id::text || '@example.invalid', now(),
  '{"provider":"google","providers":["google"]}'::jsonb,
  '{"full_name":"NFC Test Fixture","festival_name":"NFC Test Fixture","festival_student_number":"21001"}'::jsonb,
  now(), now()
from (values(current_setting('pangyo.test_uid')::uuid), (current_setting('pangyo.test_other_uid')::uuid)) fixture(id);

insert into auth.sessions(id, user_id, created_at, updated_at)
values(current_setting('pangyo.test_session')::uuid, current_setting('pangyo.test_uid')::uuid, now(), now());

select set_config('pangyo.test_token_one', festival_nfc_private.issue_tag('글빛누리', now()+interval '1 hour'), true);
select set_config('pangyo.test_token_two', festival_nfc_private.issue_tag('매커니즘', now()+interval '1 hour'), true);
do $$
declare config jsonb; encoded text;
begin
  select decrypted_secret::jsonb into config from vault.decrypted_secrets where name='pangyo_festival_nfc_v1';
  encoded := rtrim(translate(replace(encode(convert_to(jsonb_build_object('booth','글빛누리',
    'expires',0,'epoch',config->>'epoch')::text,'UTF8'),'base64'),E'\n',''),'+/','-_'),'=');
  perform set_config('pangyo.test_expired','nf1.'||encoded||'.'||encode(extensions.hmac(
    convert_to('nf1.'||encoded,'UTF8'),decode(config->>'key','hex'),'sha256'),'hex'),true);
end $$;
select set_config('request.jwt.claims', jsonb_build_object('sub',current_setting('pangyo.test_uid'),
  'role','authenticated','session_id',current_setting('pangyo.test_session'))::text, true);

set local role authenticated;
do $$
declare r jsonb; rejected boolean := false;
begin
  r := public.festival_nfc_profile();
  if r->>'authUserId' <> current_setting('pangyo.test_uid') or (r->>'needsProfile')::boolean then
    raise exception 'PROFILE_ASSERTION_FAILED';
  end if;
  if exists(select 1 from public.users where auth_user_id=current_setting('pangyo.test_other_uid')::uuid) then
    raise exception 'OTHER_USER_VISIBLE';
  end if;
  begin
    update public.users set admin=true where auth_user_id=current_setting('pangyo.test_uid')::uuid;
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'DIRECT_UPDATE_ALLOWED'; end if;
  rejected := false;
  begin
    perform festival_nfc_private.issue_tag('글빛누리',now()+interval '1 hour');
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'STUDENT_CAN_MINT'; end if;
  r := public.festival_nfc_claim(current_setting('pangyo.test_token_one'));
  if r->>'result' <> 'EARNED' or jsonb_array_length(r->'completedBooths') <> 1 then raise exception 'FIRST_CLAIM_FAILED'; end if;
  r := public.festival_nfc_claim(current_setting('pangyo.test_token_one'));
  if r->>'result' <> 'ALREADY_EARNED' or jsonb_array_length(r->'completedBooths') <> 1 then raise exception 'DUPLICATE_FAILED'; end if;
  r := public.festival_nfc_claim(current_setting('pangyo.test_token_two'));
  if r->>'result' <> 'EARNED' or jsonb_array_length(r->'completedBooths') <> 2 then raise exception 'SECOND_CLAIM_FAILED'; end if;
  rejected := false;
  begin
    perform public.festival_nfc_claim(current_setting('pangyo.test_token_one') || 'a');
  exception when invalid_parameter_value then rejected := true;
  end;
  if not rejected then raise exception 'FORGED_TOKEN_ACCEPTED'; end if;
  rejected := false;
  begin perform public.festival_nfc_claim(current_setting('pangyo.test_expired'));
  exception when invalid_parameter_value then
    if SQLERRM = 'NFC_TAG_EXPIRED' then rejected := true; end if;
  end;
  if not rejected then raise exception 'EXPIRED_TOKEN_ACCEPTED'; end if;
  rejected := false;
  begin perform 1 from vault.decrypted_secrets limit 1;
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'VAULT_EXPOSED'; end if;
end $$;

set local role anon;
do $$
declare rejected boolean := false;
begin
  begin perform public.festival_nfc_claim(current_setting('pangyo.test_token_one'));
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'ANON_CLAIM_ALLOWED'; end if;
end $$;
reset role;
update auth.sessions set not_after=now()-interval '1 minute' where id=current_setting('pangyo.test_session')::uuid;
set local role authenticated;
do $$ declare rejected boolean := false; begin
  begin perform public.festival_nfc_profile();
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'EXPIRED_SESSION_ACCEPTED'; end if;
end $$;
reset role;
rollback;
select 'PASS: profile, own-row RLS, direct update denied, mint denied, two stamps, duplicate, forgery, expiry, revoked session, anon denied; all changes rolled back' as verification;

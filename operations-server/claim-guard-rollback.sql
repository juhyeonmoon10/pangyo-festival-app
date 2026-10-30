-- Rollback for claim-guard.sql: restores claim() from nfc-tag-registry.sql and removes the limit.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);
drop function public.festival_claim_guard(text,jsonb);
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

drop function festival_ops.claim_guard_of(uuid);
drop table festival_ops.claim_guard;
notify pgrst,'reload schema';
commit;

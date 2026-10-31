-- Approved 2026-10-31 (user request): NTAG 424 DNA secure cards (SUN, Secure Unique NFC) as a second,
-- separately managed NFC stamp method. The signed-URL tags (nf1, festival_nfc_private.claim and the
-- tag registry) are not changed.
-- Apply after operator-self-actions.sql.
--
-- A card mirrors two values into its URL on every read:
--   picc_data = AES-128-CBC(SDMMetaReadKey, IV 0) of 0xC7 || UID(7) || SDMReadCtr(3, little endian) || padding
--   cmac      = odd bytes of AES-CMAC(SesSDMFileReadMACKey, MAC input)
--   SesSDMFileReadMACKey = AES-CMAC(SDMFileReadKey, 3CC3 0001 0080 || UID || SDMReadCtr)
-- (NXP AN12196). The MAC input is empty when SDMMACInputOffset = SDMMACOffset (recommended), or the
-- URL text from the start of picc_data up to the start of the cmac value.
-- A stamp is accepted only when the read counter is higher than the last accepted one, so a copied
-- link works at most once.
--
-- Keys live in Vault as 'pangyo_festival_sun_v1' = {"metaKey","fileKey","enabled","createdAt"}.
-- The card master key (key 0) never reaches the server.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create table if not exists festival_nfc_private.sun_cards(
  uid text primary key check (uid ~ '^[0-9A-F]{14}$'),
  booth public.booth_enum not null,
  label text not null default '' check (length(label) <= 40),
  last_counter integer not null check (last_counter between 0 and 16777215),
  registered_at timestamptz not null default now(),
  registered_by integer,
  revoked_at timestamptz,
  revoked_by integer,
  use_count integer not null default 0 check (use_count >= 0),
  last_used_at timestamptz
);
create index if not exists sun_cards_booth_idx on festival_nfc_private.sun_cards(booth, registered_at desc);
alter table festival_nfc_private.sun_cards enable row level security;
revoke all on festival_nfc_private.sun_cards from public, anon, authenticated;

-- AES-128 block encryption, XOR and one-bit left shift for AES-CMAC (RFC 4493).
create or replace function festival_nfc_private.sun_aes(k bytea, b bytea) returns bytea
language sql immutable strict set search_path = '' as $$ select extensions.encrypt(b, k, 'aes-ecb/pad:none') $$;

create or replace function festival_nfc_private.sun_xor(a bytea, b bytea) returns bytea
language plpgsql immutable strict set search_path = '' as $$
declare r bytea := a; i integer;
begin
  for i in 0 .. length(a) - 1 loop r := set_byte(r, i, get_byte(a, i) # get_byte(b, i)); end loop;
  return r;
end $$;

create or replace function festival_nfc_private.sun_shl(a bytea) returns bytea
language plpgsql immutable strict set search_path = '' as $$
declare r bytea := a; i integer; carry integer := 0; v integer;
begin
  for i in reverse length(a) - 1 .. 0 loop
    v := get_byte(a, i);
    r := set_byte(r, i, ((v << 1) & 255) | carry);
    carry := v >> 7;
  end loop;
  return r;
end $$;

create or replace function festival_nfc_private.sun_cmac(k bytea, m bytea) returns bytea
language plpgsql immutable strict set search_path = '' as $$
declare
  zero constant bytea := '\x00000000000000000000000000000000';
  rb constant bytea := '\x00000000000000000000000000000087';
  l bytea; k1 bytea; k2 bytea; x bytea := zero; last bytea; n integer; i integer;
begin
  l := festival_nfc_private.sun_aes(k, zero);
  k1 := festival_nfc_private.sun_shl(l);
  if get_byte(l, 0) >= 128 then k1 := festival_nfc_private.sun_xor(k1, rb); end if;
  k2 := festival_nfc_private.sun_shl(k1);
  if get_byte(k1, 0) >= 128 then k2 := festival_nfc_private.sun_xor(k2, rb); end if;
  n := greatest(1, (length(m) + 15) / 16);
  for i in 0 .. n - 2 loop
    x := festival_nfc_private.sun_aes(k, festival_nfc_private.sun_xor(x, substring(m from i * 16 + 1 for 16)));
  end loop;
  last := substring(m from (n - 1) * 16 + 1);
  if length(last) = 16 then last := festival_nfc_private.sun_xor(last, k1);
  else last := festival_nfc_private.sun_xor(last || '\x80'::bytea || decode(repeat('00', 15 - length(last)), 'hex'), k2);
  end if;
  return festival_nfc_private.sun_aes(k, festival_nfc_private.sun_xor(x, last));
end $$;

-- Verifies one SUN read. Returns {ok:true, uid, counter, macMode} or {ok:false, reason}:
-- 'format' (not hex of the right length), 'meta' (picc_data does not decrypt with the meta key, or the
-- card mirrors something other than UID + counter), 'mac' (the CMAC does not match the file key).
create or replace function festival_nfc_private.sun_verify(p_picc text, p_cmac text, p_input text, p_config jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare plain bytea; uid bytea; ctr bytea; ses bytea; full_mac bytea; mac bytea; i integer; mode text;
begin
  if p_picc is null or p_cmac is null or p_picc !~ '^[0-9A-Fa-f]{32}$' or p_cmac !~ '^[0-9A-Fa-f]{16}$'
    or (p_input is not null and p_input !~ '^[!-~]{1,200}$') then
    return jsonb_build_object('ok', false, 'reason', 'format');
  end if;
  plain := extensions.decrypt_iv(decode(p_picc, 'hex'), decode(p_config->>'metaKey', 'hex'),
    '\x00000000000000000000000000000000'::bytea, 'aes-cbc/pad:none');
  -- 0xC7: UID mirrored, read counter mirrored, 7-byte UID.
  if get_byte(plain, 0) <> 199 then return jsonb_build_object('ok', false, 'reason', 'meta'); end if;
  uid := substring(plain from 2 for 7);
  ctr := substring(plain from 9 for 3);
  ses := festival_nfc_private.sun_cmac(decode(p_config->>'fileKey', 'hex'), '\x3cc300010080'::bytea || uid || ctr);
  foreach mode in array array['empty', 'input'] loop
    continue when mode = 'input' and p_input is null;
    full_mac := festival_nfc_private.sun_cmac(ses, case when mode = 'empty' then ''::bytea else convert_to(p_input, 'UTF8') end);
    mac := '\x0000000000000000';
    for i in 0 .. 7 loop mac := set_byte(mac, i, get_byte(full_mac, i * 2 + 1)); end loop;
    if mac = decode(p_cmac, 'hex') then
      return jsonb_build_object('ok', true, 'uid', upper(encode(uid, 'hex')), 'macMode', mode,
        'counter', get_byte(ctr, 0) + get_byte(ctr, 1) * 256 + get_byte(ctr, 2) * 65536);
    end if;
  end loop;
  return jsonb_build_object('ok', false, 'reason', 'mac');
end $$;

create or replace function festival_nfc_private.sun_config() returns jsonb
language sql stable set search_path = '' as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets where name = 'pangyo_festival_sun_v1' $$;

revoke all on function festival_nfc_private.sun_aes(bytea, bytea), festival_nfc_private.sun_xor(bytea, bytea),
  festival_nfc_private.sun_shl(bytea), festival_nfc_private.sun_cmac(bytea, bytea),
  festival_nfc_private.sun_verify(text, text, text, jsonb), festival_nfc_private.sun_config()
  from public, anon, authenticated;

-- Student stamp with a secure card. Same checks and records as the signed-tag claim in
-- festival_ops_write: event and booth open, own club, rate limit, legacy stamp mirror, visit.
create or replace function public.festival_sun_claim(p_payload jsonb, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb; u integer; e festival_ops.events; old festival_ops.requests; fp bytea; cfg jsonb; tag jsonb;
  card festival_nfc_private.sun_cards; b festival_ops.booths; guard festival_ops.claim_guard; recent integer;
  profile public.users%rowtype; changed integer; result jsonb;
begin
  if p_request_id is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 600 then
    raise exception 'INVALID_INPUT';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean, true) then raise exception 'PROFILE_REQUIRED'; end if;
  fp := extensions.digest('sun_claim:' || p_payload::text, 'sha256');
  select * into old from festival_ops.requests where actor_id = u and request_id = p_request_id;
  if found then
    if old.fingerprint <> fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  select * into e from festival_ops.events where current for update;
  if e.id is null then raise exception 'OPS_NOT_READY'; end if;
  if e.state <> 'open' then raise exception 'EVENT_CLOSED'; end if;
  cfg := festival_nfc_private.sun_config();
  if cfg is null or coalesce((cfg->>'enabled')::boolean, false) is not true then raise exception 'SUN_DISABLED'; end if;
  tag := festival_nfc_private.sun_verify(p_payload->>'picc', p_payload->>'cmac', p_payload->>'macInput', cfg);
  if not (tag->>'ok')::boolean then raise exception 'SUN_CARD_INVALID'; end if;
  select * into card from festival_nfc_private.sun_cards where uid = tag->>'uid' for update;
  if card.uid is null then raise exception 'SUN_CARD_UNKNOWN'; end if;
  if card.revoked_at is not null then raise exception 'SUN_CARD_STOPPED'; end if;
  if (tag->>'counter')::integer <= card.last_counter then raise exception 'SUN_CARD_REPLAYED'; end if;
  select * into b from festival_ops.booths where event_id = e.id and legacy_key = card.booth;
  if b.key is null then raise exception 'NOT_FOUND'; end if;
  if b.status <> 'open' then raise exception 'BOOTH_CLOSED'; end if;
  if b.key = any(festival_ops.own_booths(e.id, u)) then raise exception 'OWN_CLUB_STAMP'; end if;
  -- Rate limit shared with signed tags: both record method 'nfc'.
  guard := festival_ops.claim_guard_of(e.id);
  if guard.enabled and guard.event_id is not null
    and not exists(select 1 from festival_ops.visits where event_id = e.id and user_id = u and booth_key = b.key) then
    select count(*) into recent from festival_ops.visits
      where event_id = e.id and user_id = u and method = 'nfc'
        and created_at > now() - make_interval(mins => guard.window_minutes);
    if recent >= guard.max_claims then raise exception 'CLAIM_RATE_LIMITED'; end if;
  end if;
  select * into profile from public.users where id = u and auth_user_id = auth.uid() for update;
  if not found then raise exception 'AUTH_REQUIRED'; end if;
  if not coalesce(card.booth = any(profile.completed_booths), false) then
    update public.users set completed_booths = array_append(completed_booths, card.booth)
      where id = u returning * into profile;
  end if;
  insert into festival_ops.visits(event_id, user_id, booth_key, method, actor_id)
    values(e.id, u, b.key, 'nfc', u) on conflict do nothing;
  get diagnostics changed = row_count;
  -- An already earned booth still uses up this read, so the link cannot be passed on.
  update festival_nfc_private.sun_cards set last_counter = (tag->>'counter')::integer,
    use_count = use_count + 1, last_used_at = now() where uid = card.uid;
  result := jsonb_build_object('result', case when changed = 0 then 'ALREADY_EARNED' else 'EARNED' end,
    'boothKey', card.booth::text, 'completedBooths', to_jsonb(profile.completed_booths), 'checkedAt', now());
  insert into festival_ops.requests(actor_id, request_id, fingerprint, response) values(u, p_request_id, fp, result);
  return result;
end $$;
revoke all on function public.festival_sun_claim(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.festival_sun_claim(jsonb, uuid) to authenticated;

-- Operator management: status, keys_create, keys_reveal, enable, inspect, register, move, label, revoke, restore.
create or replace function public.festival_sun_admin(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb; u integer; e uuid; cfg jsonb; secret uuid; tag jsonb; card festival_nfc_private.sun_cards;
  memo text; new_booth public.booth_enum; meta text; file text; active integer;
begin
  if p_action is null or p_action not in ('status','keys_create','keys_reveal','enable','inspect','register','move','label','revoke','restore')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 1000 then
    raise exception 'INVALID_INPUT';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean, true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean, false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  cfg := festival_nfc_private.sun_config();
  memo := btrim(coalesce(p_payload->>'label', ''));
  if length(memo) > 40 then raise exception 'INVALID_INPUT'; end if;

  if p_action = 'status' then
    return jsonb_build_object('configured', cfg is not null, 'enabled', coalesce((cfg->>'enabled')::boolean, false),
      'keysCreatedAt', cfg->>'createdAt',
      'items', coalesce((select jsonb_agg(jsonb_build_object('uid', c.uid, 'boothKey', c.booth::text, 'label', c.label,
        'lastCounter', c.last_counter, 'registeredAt', c.registered_at, 'registeredByName', ru.name,
        'revokedAt', c.revoked_at, 'useCount', c.use_count, 'lastUsedAt', c.last_used_at) order by c.booth, c.registered_at)
        from festival_nfc_private.sun_cards c left join public.users ru on ru.id = c.registered_by), '[]'::jsonb));
  end if;

  if p_action = 'keys_create' then
    select count(*) into active from festival_nfc_private.sun_cards where revoked_at is null;
    -- Replacing keys breaks every card written with the old ones.
    if cfg is not null and active > 0 and p_payload->>'confirm' is distinct from '키 교체' then
      raise exception 'SUN_KEYS_CONFIRM_REQUIRED';
    end if;
    meta := lower(coalesce(nullif(p_payload->>'metaKey', ''), encode(extensions.gen_random_bytes(16), 'hex')));
    file := lower(coalesce(nullif(p_payload->>'fileKey', ''), encode(extensions.gen_random_bytes(16), 'hex')));
    if meta !~ '^[0-9a-f]{32}$' or file !~ '^[0-9a-f]{32}$' or meta = file
      or meta = repeat('0', 32) or file = repeat('0', 32) then raise exception 'SUN_KEY_INVALID'; end if;
    select id into secret from vault.decrypted_secrets where name = 'pangyo_festival_sun_v1';
    cfg := jsonb_build_object('metaKey', meta, 'fileKey', file, 'enabled', coalesce((cfg->>'enabled')::boolean, true),
      'createdAt', now());
    if secret is null then perform vault.create_secret(cfg::text, 'pangyo_festival_sun_v1', 'NTAG 424 DNA SUN keys');
    else perform vault.update_secret(secret, cfg::text); end if;
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values(e, u, 'sun_keys_create', null, case when p_payload ? 'metaKey' then '직접 입력' else '자동 생성' end);
    return jsonb_build_object('configured', true, 'keysCreatedAt', cfg->>'createdAt');
  end if;

  if cfg is null then raise exception 'SUN_NOT_READY'; end if;

  if p_action = 'keys_reveal' then
    insert into festival_ops.audit(event_id, actor_id, action, target, reason) values(e, u, 'sun_keys_reveal', null, null);
    return jsonb_build_object('metaKey', cfg->>'metaKey', 'fileKey', cfg->>'fileKey', 'keysCreatedAt', cfg->>'createdAt');
  end if;

  if p_action = 'enable' then
    if jsonb_typeof(p_payload->'enabled') is distinct from 'boolean' then raise exception 'INVALID_INPUT'; end if;
    select id into secret from vault.decrypted_secrets where name = 'pangyo_festival_sun_v1';
    perform vault.update_secret(secret, (cfg || jsonb_build_object('enabled', (p_payload->>'enabled')::boolean))::text);
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values(e, u, 'sun_enable', null, case when (p_payload->>'enabled')::boolean then '사용' else '중지' end);
    return jsonb_build_object('enabled', (p_payload->>'enabled')::boolean);
  end if;

  if p_action in ('inspect', 'register') then
    tag := festival_nfc_private.sun_verify(p_payload->>'picc', p_payload->>'cmac', p_payload->>'macInput', cfg);
    -- Inspect never uses up the read; the operator can still register or stamp with the same link.
    if p_action = 'inspect' then
      if not (tag->>'ok')::boolean then return tag; end if;
      select * into card from festival_nfc_private.sun_cards where uid = tag->>'uid';
      return tag || jsonb_build_object('fresh', card.uid is null or (tag->>'counter')::integer > card.last_counter,
        'card', case when card.uid is null then null else jsonb_build_object('uid', card.uid, 'boothKey', card.booth::text,
          'label', card.label, 'lastCounter', card.last_counter, 'revokedAt', card.revoked_at, 'useCount', card.use_count) end);
    end if;
    if not (tag->>'ok')::boolean then raise exception 'SUN_CARD_INVALID'; end if;
    if exists(select 1 from festival_nfc_private.sun_cards where uid = tag->>'uid') then raise exception 'SUN_CARD_EXISTS'; end if;
    if p_payload->>'booth' is null or not exists(select 1 from public.booths where id::text = p_payload->>'booth') then
      raise exception 'NOT_FOUND';
    end if;
    insert into festival_nfc_private.sun_cards(uid, booth, label, last_counter, registered_by)
      values(tag->>'uid', (p_payload->>'booth')::public.booth_enum, memo, (tag->>'counter')::integer, u)
      returning * into card;
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values(e, u, 'sun_card_register', card.booth::text, concat_ws(' · ', card.uid, nullif(memo, '')));
    return jsonb_build_object('uid', card.uid, 'boothKey', card.booth::text, 'label', card.label, 'lastCounter', card.last_counter);
  end if;

  select * into card from festival_nfc_private.sun_cards where uid = upper(coalesce(p_payload->>'uid', '')) for update;
  if card.uid is null then raise exception 'NOT_FOUND'; end if;
  if p_action = 'move' then
    if p_payload->>'booth' is null or not exists(select 1 from public.booths where id::text = p_payload->>'booth') then
      raise exception 'NOT_FOUND';
    end if;
    new_booth := (p_payload->>'booth')::public.booth_enum;
    if new_booth <> card.booth then
      update festival_nfc_private.sun_cards set booth = new_booth where uid = card.uid;
      insert into festival_ops.audit(event_id, actor_id, action, target, reason)
        values(e, u, 'sun_card_move', new_booth::text, card.booth::text || ' → ' || new_booth::text || ' · ' || card.uid);
    end if;
  elsif p_action = 'label' then
    update festival_nfc_private.sun_cards set label = memo where uid = card.uid;
  elsif p_action = 'revoke' then
    if card.revoked_at is null then
      update festival_nfc_private.sun_cards set revoked_at = now(), revoked_by = u where uid = card.uid;
      insert into festival_ops.audit(event_id, actor_id, action, target, reason)
        values(e, u, 'sun_card_revoke', card.booth::text, card.uid);
    end if;
  else
    if card.revoked_at is not null then
      update festival_nfc_private.sun_cards set revoked_at = null, revoked_by = null where uid = card.uid;
      insert into festival_ops.audit(event_id, actor_id, action, target, reason)
        values(e, u, 'sun_card_restore', card.booth::text, card.uid);
    end if;
  end if;
  select * into card from festival_nfc_private.sun_cards where uid = card.uid;
  return jsonb_build_object('uid', card.uid, 'boothKey', card.booth::text, 'label', card.label, 'revokedAt', card.revoked_at);
end $$;
revoke all on function public.festival_sun_admin(text, jsonb) from public, anon, authenticated;
grant execute on function public.festival_sun_admin(text, jsonb) to authenticated;

notify pgrst,'reload schema';
commit;

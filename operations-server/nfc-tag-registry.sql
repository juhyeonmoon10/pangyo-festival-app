-- Approved 2026-10-30: issued NFC tag management and the participation reset fix.
-- Apply after nfc-server/updates/20260930-nonexpiring-tags.sql and voucher-unlimited-and-reset.sql.
-- 1. festival_nfc_private.tags records every issued tag (booth, signed payload, memo, issuer) so
--    operators can list, re-copy, rename, stop and restore tags. Signed tokens are rebuilt from
--    the stored payload on request and are never stored. Tags issued before this registry are
--    registered the first time a student scans them ('discovered').
-- 2. claim() rejects a stopped tag with NFC_TAG_EXPIRED and counts successful scans.
-- 3. festival_ops_reset: the shared DB loads pg_safeupdate for API roles, which rejects a DELETE
--    without a WHERE clause even inside a function, so every reset returned an unknown error.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create table festival_nfc_private.tags(
  id text primary key check (id ~ '^[0-9a-f]{32}$'),
  booth public.booth_enum not null,
  encoded text not null check (length(encoded) between 1 and 1024),
  epoch text not null,
  expires_at timestamptz,
  label text not null default '' check (length(label) <= 40),
  source text not null default 'issued' check (source in ('issued','discovered')),
  issued_by integer,
  issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by integer,
  use_count integer not null default 0 check (use_count >= 0),
  last_used_at timestamptz
);
create index tags_booth_idx on festival_nfc_private.tags(booth, issued_at desc);
alter table festival_nfc_private.tags enable row level security;
revoke all on festival_nfc_private.tags from public, anon, authenticated;

-- Registers a verified token payload; a repeated registration keeps the first row.
create function festival_nfc_private.tag_register(p_encoded text, p_payload jsonb, p_source text, p_actor integer)
returns text language plpgsql security invoker set search_path = '' as $$
declare tag_id text := p_payload->>'nonce';
begin
  if tag_id is null or tag_id !~ '^[0-9a-f]{32}$' then return null; end if;
  insert into festival_nfc_private.tags(id, booth, encoded, epoch, expires_at, source, issued_by)
    values(tag_id, (p_payload->>'booth')::public.booth_enum, p_encoded, coalesce(p_payload->>'epoch', ''),
      case when p_payload->>'expires' ~ '^[0-9]{1,12}$' then to_timestamp((p_payload->>'expires')::bigint) end,
      p_source, p_actor)
    on conflict (id) do nothing;
  return tag_id;
end $$;
revoke all on function festival_nfc_private.tag_register(text, jsonb, text, integer) from public, anon, authenticated;

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

create or replace function festival_nfc_private.admin_issue(p_booth text, p_valid_minutes integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb;
  is_admin boolean;
  booth public.booth_enum;
  expires timestamptz;
  token text;
  encoded text;
  tag_id text;
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
  encoded := split_part(token, '.', 2);
  tag_id := festival_nfc_private.tag_register(encoded,
    convert_from(decode(rpad(translate(encoded, '-_', '+/'), ((length(encoded)+3)/4)*4, '='), 'base64'), 'UTF8')::jsonb,
    'issued', (me->>'id')::integer);
  return jsonb_build_object('token', token, 'boothKey', booth, 'expiresAt', expires,
    'issuedAt', now(), 'validMinutes', p_valid_minutes, 'tagId', tag_id);
end $$;

-- Operator tag management: list, issue (with a memo), url (re-copy), label, revoke, restore.
create function public.festival_nfc_tag_admin(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb; u integer; is_admin boolean; config jsonb; t festival_nfc_private.tags; result jsonb;
  memo text; issued jsonb; e uuid; booth_filter text;
begin
  if p_action is null or p_action not in ('list','issue','url','label','revoke','restore')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_INPUT';
  end if;
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean, true) then raise exception using errcode = '42501', message = 'PROFILE_REQUIRED'; end if;
  select admin into is_admin from public.users where id = u and auth_user_id = auth.uid();
  if coalesce(is_admin, false) is not true then raise exception using errcode = '42501', message = 'ADMIN_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  select decrypted_secret::jsonb into config from vault.decrypted_secrets where name = 'pangyo_festival_nfc_v1';
  select id into e from festival_ops.events where current;
  memo := btrim(coalesce(p_payload->>'label', ''));
  if length(memo) > 40 then raise exception using errcode = '22023', message = 'INVALID_INPUT'; end if;

  if p_action = 'list' then
    booth_filter := nullif(p_payload->>'booth', '');
    return jsonb_build_object('enabled', coalesce((config->>'enabled')::boolean, false),
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'boothKey', x.booth::text, 'label', x.label,
        'source', x.source, 'issuedAt', x.issued_at, 'issuedBy', x.issued_by, 'issuerName', iu.name,
        'expiresAt', x.expires_at, 'revokedAt', x.revoked_at, 'useCount', x.use_count, 'lastUsedAt', x.last_used_at,
        'status', case when x.revoked_at is not null then 'revoked'
          when x.epoch is distinct from config->>'epoch' or (x.expires_at is not null and x.expires_at <= now()) then 'expired'
          else 'active' end) order by x.issued_at desc)
        from (select * from festival_nfc_private.tags
          where booth_filter is null or booth::text = booth_filter order by issued_at desc limit 500) x
        left join public.users iu on iu.id = x.issued_by), '[]'::jsonb));
  end if;

  if p_action = 'issue' then
    issued := festival_nfc_private.admin_issue(p_payload->>'booth', null);
    update festival_nfc_private.tags set label = memo where id = issued->>'tagId';
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values(e, u, 'nfc_tag_issue', issued->>'boothKey', nullif(memo, ''));
    return issued;
  end if;

  select * into t from festival_nfc_private.tags where id = p_payload->>'id' for update;
  if t.id is null then raise exception using errcode = '22023', message = 'NOT_FOUND'; end if;
  if p_action = 'url' then
    if t.revoked_at is not null or t.epoch is distinct from config->>'epoch'
      or (t.expires_at is not null and t.expires_at <= now()) then
      raise exception using errcode = '22023', message = 'NFC_TAG_EXPIRED';
    end if;
    if coalesce((config->>'enabled')::boolean, false) is not true then
      raise exception using errcode = '42501', message = 'NFC_DISABLED';
    end if;
    return jsonb_build_object('id', t.id, 'boothKey', t.booth::text, 'token', 'nf1.' || t.encoded || '.'
      || encode(extensions.hmac(convert_to('nf1.' || t.encoded, 'UTF8'), decode(config->>'key', 'hex'), 'sha256'), 'hex'));
  elsif p_action = 'label' then
    update festival_nfc_private.tags set label = memo where id = t.id;
  elsif p_action = 'revoke' then
    if t.revoked_at is null then
      update festival_nfc_private.tags set revoked_at = now(), revoked_by = u where id = t.id;
      insert into festival_ops.audit(event_id, actor_id, action, target, reason)
        values(e, u, 'nfc_tag_revoke', t.booth::text, nullif(t.label, ''));
    end if;
  else
    if t.epoch is distinct from config->>'epoch' then
      raise exception using errcode = '22023', message = 'NFC_TAG_EXPIRED';
    end if;
    if t.revoked_at is not null then
      update festival_nfc_private.tags set revoked_at = null, revoked_by = null where id = t.id;
      insert into festival_ops.audit(event_id, actor_id, action, target, reason)
        values(e, u, 'nfc_tag_restore', t.booth::text, nullif(t.label, ''));
    end if;
  end if;
  select * into t from festival_nfc_private.tags where id = t.id;
  return jsonb_build_object('id', t.id, 'label', t.label, 'revokedAt', t.revoked_at);
end $$;
revoke all on function public.festival_nfc_tag_admin(text, jsonb) from public, anon, authenticated;
grant execute on function public.festival_nfc_tag_admin(text, jsonb) to authenticated;

-- Same reset as voucher-unlimited-and-reset.sql with WHERE clauses that pg_safeupdate accepts.
-- Tag scan counts are participation records too; the tags themselves are kept.
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
  update festival_nfc_private.tags set use_count=0,last_used_at=null where use_count>0 or last_used_at is not null;
  -- Cached responses would otherwise replay deleted records.
  delete from festival_ops.requests where request_id is not null; get diagnostics c_requests=row_count;
  result:=jsonb_build_object('reset',true,'vouchers',c_vouchers,'points',c_ledger,'reviews',c_reviews,'visits',c_visits,
    'identities',c_identities,'ratings',c_ratings,'stampAccounts',c_stamps);
  insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e,u,'participation_reset',null,result::text);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;

notify pgrst,'reload schema';
commit;

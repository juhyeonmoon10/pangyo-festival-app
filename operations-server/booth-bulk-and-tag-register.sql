-- Approved 2026-10-30: bulk booth status change and registering cards issued before the tag registry.
-- Apply after claim-guard.sql. No table is added.
-- 1. public.festival_booth_status_bulk: sets one operating status on many booths in one transaction.
-- 2. festival_nfc_tag_admin('register'): an operator reads or pastes an existing card address; the
--    signature and key generation are verified and the card is listed for management. No stamp is earned.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create function public.festival_booth_status_bulk(p_payload jsonb, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; old festival_ops.requests; fp bytea; result jsonb; keys text[]; next_status text; changed integer;
begin
  if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>20000
    or jsonb_typeof(p_payload->'booths') is distinct from 'array' then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current for update;
  if e is null or (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
  next_status:=p_payload->>'status';
  if next_status is null or next_status not in ('open','paused','closed') then raise exception 'INVALID_INPUT'; end if;
  select array_agg(distinct x) into keys from jsonb_array_elements_text(p_payload->'booths') x;
  if keys is null or cardinality(keys) not between 1 and 300 then raise exception 'INVALID_INPUT'; end if;
  fp:=extensions.digest('booth_status_bulk:'||p_payload::text,'sha256');
  select * into old from festival_ops.requests where actor_id=u and request_id=p_request_id;
  if found then
    if old.fingerprint<>fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  if (select count(*) from festival_ops.booths where event_id=e and key=any(keys))<>cardinality(keys) then raise exception 'NOT_FOUND'; end if;
  update festival_ops.booths set status=next_status,version=version+1 where event_id=e and key=any(keys) and status<>next_status;
  get diagnostics changed=row_count;
  result:=jsonb_build_object('status',next_status,'selected',cardinality(keys),'changed',changed);
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(e,u,'booth_status_bulk',next_status,format('%s개 선택, %s개 변경',cardinality(keys),changed));
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;
revoke all on function public.festival_booth_status_bulk(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.festival_booth_status_bulk(jsonb,uuid) to authenticated;

create or replace function public.festival_nfc_tag_admin(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb; u integer; is_admin boolean; config jsonb; t festival_nfc_private.tags; result jsonb;
  memo text; issued jsonb; e uuid; booth_filter text; tok text; enc text; payload jsonb; existed boolean;
begin
  if p_action is null or p_action not in ('list','issue','url','label','revoke','restore','register')
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

  -- A card written before the registry: verify its signature and list it without earning a stamp.
  if p_action = 'register' then
    tok := p_payload->>'token';
    if tok is null or length(tok) > 1024 or tok !~ '^nf1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
    end if;
    enc := split_part(tok, '.', 2);
    if config is null or split_part(tok, '.', 3) <> encode(extensions.hmac(convert_to('nf1.' || enc, 'UTF8'), decode(config->>'key', 'hex'), 'sha256'), 'hex') then
      raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
    end if;
    begin
      payload := convert_from(decode(rpad(translate(enc, '-_', '+/'), ((length(enc)+3)/4)*4, '='), 'base64'), 'UTF8')::jsonb;
    exception when others then
      raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
    end;
    if payload->>'epoch' is distinct from config->>'epoch' then
      raise exception using errcode = '22023', message = 'NFC_TAG_EXPIRED';
    end if;
    if coalesce(payload->>'nonce', '') !~ '^[0-9a-f]{32}$'
      or not exists(select 1 from public.booths where id::text = payload->>'booth') then
      raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
    end if;
    existed := exists(select 1 from festival_nfc_private.tags where id = payload->>'nonce');
    perform festival_nfc_private.tag_register(enc, payload, 'discovered', null);
    if not existed and memo <> '' then
      update festival_nfc_private.tags set label = memo where id = payload->>'nonce';
    end if;
    if not existed then
      insert into festival_ops.audit(event_id, actor_id, action, target, reason)
        values(e, u, 'nfc_tag_register', payload->>'booth', nullif(memo, ''));
    end if;
    return jsonb_build_object('id', payload->>'nonce', 'boothKey', payload->>'booth', 'added', not existed);
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

notify pgrst,'reload schema';
commit;

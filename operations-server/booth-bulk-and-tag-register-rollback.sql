-- Rollback for booth-bulk-and-tag-register.sql: removes bulk status and the register action.
-- Cards already registered stay in the list.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);
drop function public.festival_booth_status_bulk(jsonb,uuid);
create or replace function public.festival_nfc_tag_admin(p_action text, p_payload jsonb) returns jsonb
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
notify pgrst,'reload schema';
commit;

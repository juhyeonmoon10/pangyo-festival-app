-- Rollback of waiting.sql (1.59): removes 웨이팅, posters and 예상 소요시간, and brings back the 1.58 booth save
-- (booth-profile.sql) and booth program limits (booth-managers.sql), which accept operating hours again.
-- Deleted operating hours do not come back. Poster files in Storage are left for an operator to delete.
-- Run waiting-push-rollback.sql first where waiting-push.sql was applied.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

drop function if exists public.festival_waiting(text, jsonb);
drop function if exists public.festival_waiting_manage(text, jsonb);
drop function if exists public.festival_booth_posters_admin();
drop function if exists festival_ops.booth_manager_item(festival_ops.booths, boolean);
drop function if exists festival_ops.waiting_add(uuid, text, integer, text, text, integer, text);
drop function if exists festival_ops.waiting_settings_for(uuid, text);
drop function if exists festival_ops.waiting_settings_json(festival_ops.waiting_settings);
drop function if exists festival_ops.waiting_qr_valid(festival_ops.waiting_settings, text);
drop function if exists festival_ops.waiting_qr_token(festival_ops.waiting_settings, bigint);
drop function if exists festival_ops.waiting_tick(uuid, text);
drop function if exists festival_ops.waiting_entry_json(uuid);
drop function if exists festival_ops.waiting_sync(uuid, text);
drop function if exists festival_ops.waiting_wait_text(integer, smallint);
drop function if exists festival_ops.push_enqueue(integer, uuid, text, text, text);
drop function if exists festival_ops.push_kick();
drop function if exists festival_ops.kst_day();
drop function if exists festival_ops.duration_minutes_from(text);
drop table if exists festival_ops.push_config, festival_ops.push_outbox, festival_ops.push_subscriptions,
  festival_ops.waiting_entries, festival_ops.waiting_counters, festival_ops.waiting_settings, festival_ops.booth_poster_files;

-- 예상 소요시간 goes back into program.duration as text.
update festival_ops.booths set program = program || jsonb_build_object('duration', duration_minutes || '분') where duration_minutes is not null;
alter table festival_ops.booths drop constraint if exists booths_duration_range;
alter table festival_ops.booths drop constraint if exists booths_posters_shape;
alter table festival_ops.booths drop column if exists duration_minutes;
alter table festival_ops.booths drop column if exists posters;

create or replace function festival_ops.booth_program(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; limits constant jsonb := '{"title":80,"description":1000,"hours":100,"duration":100,"participation":300,"materials":200}';
  out jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return out; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'INVALID_INPUT'; end if;
  for k in select jsonb_object_keys(p) loop
    if not limits ? k or jsonb_typeof(p->k) <> 'string' or length(p->>k) > (limits->>k)::integer then raise exception 'INVALID_INPUT'; end if;
    if btrim(p->>k) <> '' then out := out || jsonb_build_object(k, btrim(p->>k)); end if;
  end loop;
  return out;
end $$;

create or replace function public.festival_booth_manager(p_action text, p_payload jsonb, p_request_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me jsonb; u integer; admin boolean; e festival_ops.events; b festival_ops.booths; approve boolean;
  sid text; target integer; why text; changed integer; old festival_ops.requests; fp bytea; result jsonb; n integer;
  loc text; fl integer; rm text; img text;
begin
  if p_action is null or p_action not in ('status','save','lookup','visit_approve')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 6000 then
    raise exception 'INVALID_INPUT';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean, true) then raise exception 'PROFILE_REQUIRED'; end if;
  admin := coalesce((me->>'isAdmin')::boolean, false);
  select * into e from festival_ops.events where current;
  if e.id is null then
    if p_action = 'status' then return jsonb_build_object('isAdmin', admin, 'items', '[]'::jsonb); end if;
    raise exception 'OPS_NOT_READY';
  end if;

  if p_action = 'status' then
    return jsonb_build_object('isAdmin', admin, 'items', coalesce((select jsonb_agg(jsonb_build_object(
        'key', x.key, 'name', x.name, 'location', x.location, 'floor', x.floor, 'room', x.room, 'image', x.image, 'status', x.status,
        'description', x.description, 'program', x.program, 'version', x.version, 'canApprove', m.can_approve)
        order by x.floor, x.name)
      from festival_ops.managed_booths(e.id, u, admin) m join festival_ops.booths x on x.event_id = e.id and x.key = m.booth_key), '[]'::jsonb));
  end if;

  select m.can_approve into approve from festival_ops.managed_booths(e.id, u, admin) m where m.booth_key = p_payload->>'booth';
  if approve is null then raise exception 'BOOTH_MANAGER_REQUIRED'; end if;
  select * into b from festival_ops.booths where event_id = e.id and key = p_payload->>'booth' for update;

  if p_action = 'save' then
    if (p_payload->>'version')::integer is distinct from b.version then raise exception 'VERSION_CONFLICT'; end if;
    if p_payload->>'status' not in ('open','paused','closed') or length(coalesce(p_payload->>'description', '')) > 2000
      or (p_payload ? 'floor' and (jsonb_typeof(p_payload->'floor') <> 'number' or p_payload->>'floor' !~ '^[1-4]$'))
      or exists(select 1 from unnest(array['location','room','image']) k where p_payload ? k and jsonb_typeof(p_payload->k) <> 'string') then
      raise exception 'INVALID_INPUT';
    end if;
    loc := case when p_payload ? 'location' then btrim(p_payload->>'location') else b.location end;
    rm := case when p_payload ? 'room' then btrim(p_payload->>'room') else b.room end;
    img := case when p_payload ? 'image' then p_payload->>'image' else b.image end;
    fl := case when p_payload ? 'floor' then (p_payload->>'floor')::integer else b.floor end;
    if length(loc) > 200 or length(rm) > 40 or loc ~ '[[:cntrl:]]' or rm ~ '[[:cntrl:]]' or fl not between 1 and 4
      or (img <> '' and img !~ '^booths/[0-9a-f]{32}\.(jpg|png|webp)$') then
      raise exception 'INVALID_INPUT';
    end if;
    -- A new photo must be in the bucket already. Storage exists only on Supabase; the inner query is
    -- a statement of its own so it is planned only when the table exists.
    if img <> '' and img <> b.image and to_regclass('storage.objects') is not null then
      if not exists(select 1 from storage.objects o where o.bucket_id = 'festival-booths' and o.name = img
        and (admin or o.owner_id = (select auth.uid())::text)) then
        raise exception 'BOOTH_IMAGE_NOT_FOUND';
      end if;
    end if;
    update festival_ops.booths set status = p_payload->>'status', description = btrim(coalesce(p_payload->>'description', '')),
      program = festival_ops.booth_program(p_payload->'program'), location = loc, floor = fl, room = rm, image = img,
      version = version + 1
      where event_id = e.id and key = b.key returning * into b;
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values(e.id, u, case when admin then 'booth_info_save' else 'booth_manager_save' end, b.key,
        b.status || ' · ' || b.floor || '층' || case when b.room <> '' then ' ' || b.room else '' end);
    return jsonb_build_object('key', b.key, 'name', b.name, 'location', b.location, 'floor', b.floor, 'room', b.room, 'image', b.image,
      'status', b.status, 'description', b.description, 'program', b.program, 'version', b.version, 'canApprove', approve);
  end if;

  if not approve then raise exception 'BOOTH_APPROVAL_NOT_ALLOWED'; end if;
  sid := btrim(coalesce(p_payload->>'studentNumber', ''));
  if sid !~ '^[1-3][0-9]{4}$' then raise exception 'INVALID_INPUT'; end if;

  if p_action = 'lookup' then
    select count(*) into n from festival_ops.student_accounts(e.id, sid);
    if n = 0 then raise exception 'STUDENT_NOT_FOUND'; end if;
    return jsonb_build_object('studentNumber', sid, 'accounts', (select jsonb_agg(jsonb_build_object('name', s.name, 'ref', s.ref,
        'email', case when n > 1 then s.masked end, 'selected', n = 1 or (s.held and (select count(*) from festival_ops.student_accounts(e.id, sid) h where h.held) = 1),
        'visited', exists(select 1 from festival_ops.visits v where v.event_id = e.id and v.user_id = s.user_id and v.booth_key = b.key),
        'ownClub', b.key = any(festival_ops.own_booths(e.id, s.user_id))) order by s.name)
      from festival_ops.student_accounts(e.id, sid) s));
  end if;

  if p_request_id is null then raise exception 'INVALID_INPUT'; end if;
  fp := extensions.digest('booth_manager_visit:' || p_payload::text, 'sha256');
  select * into old from festival_ops.requests where actor_id = u and request_id = p_request_id;
  if found then
    if old.fingerprint <> fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  if e.state <> 'open' then raise exception 'EVENT_CLOSED'; end if;
  if b.status <> 'open' then raise exception 'BOOTH_CLOSED'; end if;
  why := btrim(coalesce(p_payload->>'reason', ''));
  if length(why) not between 3 and 300 then raise exception 'INVALID_INPUT'; end if;
  if nullif(p_payload->>'ref', '') is not null then
    select s.user_id into target from festival_ops.student_accounts(e.id, sid) s where s.ref = p_payload->>'ref';
    if target is null then raise exception 'STUDENT_NOT_FOUND'; end if;
  else
    target := festival_ops.resolve_student(e.id, sid, null);
  end if;
  if b.key = any(festival_ops.own_booths(e.id, target)) then raise exception 'OWN_CLUB_STAMP'; end if;
  insert into festival_ops.visits(event_id, user_id, booth_key, method, actor_id, reason)
    values(e.id, target, b.key, 'manual', u, why) on conflict do nothing;
  get diagnostics changed = row_count;
  insert into festival_ops.audit(event_id, actor_id, action, target, reason)
    values(e.id, u, 'booth_manager_visit', target::text, b.key || ' · ' || why);
  result := jsonb_build_object('result', case when changed = 0 then 'ALREADY_EARNED' else 'EARNED' end, 'booth', b.key);
  insert into festival_ops.requests(actor_id, request_id, fingerprint, response) values(u, p_request_id, fp, result);
  return result;
end $$;
revoke all on function public.festival_booth_manager(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.festival_booth_manager(text, jsonb, uuid) to authenticated;

-- Account deletion goes back to its 1.58 body (the three lines waiting.sql added are taken out).
do $$
declare d text; patched text;
begin
  if to_regprocedure('public.festival_account_delete(jsonb,uuid)') is null then return; end if;
  d := pg_get_functiondef('public.festival_account_delete(jsonb,uuid)'::regprocedure);
  if d !~ 'festival_ops\.waiting_entries' then return; end if;
  patched := regexp_replace(d, '\n  delete from festival_ops\.waiting_entries where user_id=target;\n  delete from festival_ops\.push_subscriptions where user_id=target;\n  delete from festival_ops\.push_outbox where user_id=target;', '');
  if patched ~ 'festival_ops\.waiting_entries' then raise exception 'ACCOUNT_DELETE_UNPATCH_FAILED'; end if;
  execute patched;
end $$;

do $$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  execute 'drop policy if exists festival_booth_posters_insert on storage.objects';
  execute 'drop policy if exists festival_booth_posters_select on storage.objects';
  execute 'drop policy if exists festival_booth_posters_delete on storage.objects';
end $$;

notify pgrst,'reload schema';
commit;

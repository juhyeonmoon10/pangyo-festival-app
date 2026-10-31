-- Approved 2026-10-31 (user request): booth managers edit everything about their booth.
-- Apply after booth-managers.sql and notice-images.sql.
-- * festival_ops.booths.image: profile photo, a path 'booths/<32 hex>.(jpg|png|webp)' in the public
--   Storage bucket 'festival-booths'. festival_ops.booths.room: the map room the booth sits in.
-- * festival_booth_manager 'save' also takes location, floor, room and image. Keys left out keep their
--   value, so a client from before this change still saves safely. Operating hours stay in program.hours.
-- * A new photo must already be in the bucket, uploaded by the manager themself (operators: anyone's).
-- * Storage: operators and active booth managers upload; owners and operators read back and delete.
--   Notice photos get the read policy too: Storage deletes return the removed rows, so a delete
--   without a read policy removed nothing.
-- Rollback: booth-profile-rollback.sql, then booth-managers.sql again for the previous function.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

alter table festival_ops.booths add column if not exists image text not null default '';
alter table festival_ops.booths add column if not exists room text not null default '';
alter table festival_ops.booths drop constraint if exists booths_image_shape;
alter table festival_ops.booths add constraint booths_image_shape
  check (image = '' or image ~ '^booths/[0-9a-f]{32}\.(jpg|png|webp)$');
alter table festival_ops.booths drop constraint if exists booths_room_shape;
alter table festival_ops.booths add constraint booths_room_shape check (length(room) <= 40);

-- Same as booth-managers.sql except 'save' (location, floor, room, image) and the returned fields.
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

-- Storage check: an operator, or someone who manages a booth right now.
create or replace function public.festival_can_upload_booth_image() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.users p where p.auth_user_id = auth.uid() and (p.admin or exists(
    select 1 from festival_ops.events e cross join lateral festival_ops.managed_booths(e.id, p.id, false) m where e.current))) $$;
revoke all on function public.festival_can_upload_booth_image() from public, anon, authenticated;
grant execute on function public.festival_can_upload_booth_image() to authenticated;

do $$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    values('festival-booths', 'festival-booths', true, 3145728, array['image/jpeg','image/png','image/webp'])
    on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  execute 'drop policy if exists festival_booth_images_insert on storage.objects';
  execute 'drop policy if exists festival_booth_images_select on storage.objects';
  execute 'drop policy if exists festival_booth_images_delete on storage.objects';
  execute 'drop policy if exists festival_notice_images_select on storage.objects';
  execute $p$create policy festival_booth_images_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'festival-booths' and name ~ '^booths/[0-9a-f]{32}\.(jpg|png|webp)$' and public.festival_can_upload_booth_image())$p$;
  execute $p$create policy festival_booth_images_select on storage.objects for select to authenticated
    using (bucket_id = 'festival-booths' and (owner_id = (select auth.uid())::text or public.festival_is_operator()))$p$;
  execute $p$create policy festival_booth_images_delete on storage.objects for delete to authenticated
    using (bucket_id = 'festival-booths' and (owner_id = (select auth.uid())::text or public.festival_is_operator()))$p$;
  execute $p$create policy festival_notice_images_select on storage.objects for select to authenticated
    using (bucket_id = 'festival-notices' and public.festival_is_operator())$p$;
end $$;

notify pgrst,'reload schema';
commit;

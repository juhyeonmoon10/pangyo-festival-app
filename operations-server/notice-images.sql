-- Approved 2026-10-31 (user request): photos in festival notices.
-- Apply after booth-managers.sql.
-- * festival_ops.notices.images: up to 4 storage paths 'notices/<32 hex>.(jpg|png|webp)'.
-- * Storage bucket 'festival-notices': public read (participants see notice photos), upload and
--   delete only by operators, images only, at most 3 MB each. The app shrinks photos before upload.
-- * festival_notices and festival_notice_admin are edited in place to carry the paths.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

alter table festival_ops.notices add column if not exists images text[] not null default '{}';
alter table festival_ops.notices drop constraint if exists notices_images_shape;
alter table festival_ops.notices add constraint notices_images_shape check (cardinality(images) <= 4);

create or replace function festival_ops.notice_images(p jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare out text[] := '{}'; v jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return out; end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 4 then raise exception 'INVALID_INPUT'; end if;
  for v in select jsonb_array_elements(p) loop
    if jsonb_typeof(v) <> 'string' or v #>> '{}' !~ '^notices/[0-9a-f]{32}\.(jpg|png|webp)$' then raise exception 'INVALID_INPUT'; end if;
    if not (v #>> '{}') = any(out) then out := out || (v #>> '{}'); end if;
  end loop;
  return out;
end $$;
revoke all on function festival_ops.notice_images(jsonb) from public, anon, authenticated;

do $$
declare d text; pairs text[][]; i integer; before text;
begin
  -- Each edit must apply exactly as written, or nothing changes.
  d := replace(pg_get_functiondef('public.festival_notices()'::regprocedure), E'\r\n', E'\n'); before := d;
  d := replace(d, '''important'',n.important,''publishedAt''', '''important'',n.important,''images'',to_jsonb(n.images),''publishedAt''');
  if d = before then raise exception 'NOTICE_IMAGES_NOT_APPLIED festival_notices'; end if;
  execute d;

  d := replace(pg_get_functiondef('public.festival_notice_admin(text,jsonb)'::regprocedure), E'\r\n', E'\n');
  pairs := array[
    array['v_title text; v_body text; nid uuid;', 'v_title text; v_body text; nid uuid; v_images text[];'],
    array['v_body:=btrim(coalesce(p_payload->>''body'',''''));', E'v_body:=btrim(coalesce(p_payload->>''body'',''''));\n    v_images:=festival_ops.notice_images(p_payload->''images'');'],
    array['insert into festival_ops.notices(event_id,title,body,important,published,created_by)', 'insert into festival_ops.notices(event_id,title,body,important,published,created_by,images)'],
    array['(p_payload->>''published'')::boolean,u) returning * into n;', '(p_payload->>''published'')::boolean,u,v_images) returning * into n;'],
    array['published=(p_payload->>''published'')::boolean,version=version+1', 'published=(p_payload->>''published'')::boolean,images=v_images,version=version+1'],
    array['''body'',x.body,''important'',x.important,', '''body'',x.body,''important'',x.important,''images'',to_jsonb(x.images),']];
  for i in 1 .. array_length(pairs, 1) loop
    before := d; d := replace(d, pairs[i][1], pairs[i][2]);
    if d = before then raise exception 'NOTICE_IMAGES_NOT_APPLIED festival_notice_admin %', i; end if;
  end loop;
  execute d;
end $$;

-- Shared check for storage policies: is the signed-in account an operator?
create or replace function public.festival_is_operator() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(bool_or(admin), false) from public.users where auth_user_id = auth.uid() $$;
revoke all on function public.festival_is_operator() from public, anon, authenticated;
grant execute on function public.festival_is_operator() to authenticated;

-- Storage exists only on Supabase; isolated test databases skip this part.
do $$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    values('festival-notices', 'festival-notices', true, 3145728, array['image/jpeg','image/png','image/webp'])
    on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  execute 'drop policy if exists festival_notice_images_insert on storage.objects';
  execute 'drop policy if exists festival_notice_images_delete on storage.objects';
  execute $p$create policy festival_notice_images_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'festival-notices' and name ~ '^notices/[0-9a-f]{32}\.(jpg|png|webp)$' and public.festival_is_operator())$p$;
  execute $p$create policy festival_notice_images_delete on storage.objects for delete to authenticated
    using (bucket_id = 'festival-notices' and public.festival_is_operator())$p$;
end $$;

notify pgrst,'reload schema';
commit;

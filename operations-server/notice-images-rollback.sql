-- Rollback for notice-images.sql: notices stop carrying photos. The images column, the bucket and the
-- uploaded files are kept so a re-apply shows the same photos; remove them separately if unwanted.
begin;
select pg_catalog.pg_advisory_xact_lock(170926,1);
do $$
declare d text; before text;
begin
  d := replace(pg_get_functiondef('public.festival_notices()'::regprocedure), E'\r\n', E'\n'); before := d;
  d := replace(d, '''images'',to_jsonb(n.images),', '');
  if d = before then raise exception 'ROLLBACK_NOT_APPLIED festival_notices'; end if;
  execute d;
  d := replace(pg_get_functiondef('public.festival_notice_admin(text,jsonb)'::regprocedure), E'\r\n', E'\n'); before := d;
  d := replace(d, ' v_images text[];', '');
  d := replace(d, E'\n    v_images:=festival_ops.notice_images(p_payload->''images'');', '');
  d := replace(d, 'created_by,images)', 'created_by)');
  d := replace(d, ',u,v_images) returning', ',u) returning');
  d := replace(d, 'images=v_images,', '');
  d := replace(d, '''images'',to_jsonb(x.images),', '');
  if d = before or d ~ 'images' then raise exception 'ROLLBACK_NOT_APPLIED festival_notice_admin'; end if;
  execute d;
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists festival_notice_images_insert on storage.objects';
    execute 'drop policy if exists festival_notice_images_delete on storage.objects';
  end if;
end $$;
drop function if exists public.festival_is_operator();
drop function if exists festival_ops.notice_images(jsonb);
notify pgrst,'reload schema';
commit;

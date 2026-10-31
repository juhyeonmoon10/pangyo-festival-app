-- Reverses booth-profile.sql. Apply booth-managers.sql afterwards to restore the previous
-- festival_booth_manager. Photo paths, map rooms and the bucket's files are kept.
begin;
set local lock_timeout='5s';
select pg_catalog.pg_advisory_xact_lock(170926,1);
do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  execute 'drop policy if exists festival_booth_images_insert on storage.objects';
  execute 'drop policy if exists festival_booth_images_select on storage.objects';
  execute 'drop policy if exists festival_booth_images_delete on storage.objects';
  execute 'drop policy if exists festival_notice_images_select on storage.objects';
end $$;
drop function if exists public.festival_can_upload_booth_image();
notify pgrst,'reload schema';
commit;

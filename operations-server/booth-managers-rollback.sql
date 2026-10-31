-- Rollback for booth-managers.sql: removes the 부스 담당자 role. Booth programs written so far stay in
-- festival_ops.booths.program (the column is kept; drop it separately if no longer wanted), and manual
-- stamps that managers approved stay as visits.
begin;
select pg_catalog.pg_advisory_xact_lock(170926,1);
drop function if exists public.festival_booth_manager_admin(text, jsonb);
drop function if exists public.festival_booth_manager(text, jsonb, uuid);
drop function if exists festival_ops.student_accounts(uuid, text);
drop function if exists festival_ops.booth_program(jsonb);
drop function if exists festival_ops.managed_booths(uuid, integer, boolean);
drop table if exists festival_ops.booth_managers;
notify pgrst,'reload schema';
commit;

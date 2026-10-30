-- Rollback for notices.sql. Deletes every notice.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);
drop function public.festival_notice_admin(text,jsonb);
drop function public.festival_notices();
drop table festival_ops.notices;
notify pgrst,'reload schema';
commit;

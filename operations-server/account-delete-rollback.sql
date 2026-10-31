-- Rollback for account-delete.sql: removes the 학생 계정 삭제 function. Accounts already deleted stay
-- deleted (their festival records cannot be restored); their audit rows stay.
begin;
select pg_catalog.pg_advisory_xact_lock(170926,1);
drop function if exists public.festival_account_delete(jsonb,uuid);
notify pgrst,'reload schema';
commit;

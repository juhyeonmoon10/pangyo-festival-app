-- Removes the reset RPC and restores a mandatory stock. Function changes in
-- voucher-unlimited-and-reset.sql stay: they behave as before once every stock is set.
-- An unlimited stock becomes the previous maximum (100000) instead of blocking issuance.
begin;
set local lock_timeout='5s';
select pg_catalog.pg_advisory_xact_lock(170926,1);
drop function public.festival_ops_reset(jsonb,uuid);
update festival_ops.rules set stock=100000,version=version+1 where stock is null;
alter table festival_ops.rules alter column stock set not null;
notify pgrst,'reload schema';
commit;

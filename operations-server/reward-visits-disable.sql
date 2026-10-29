begin;
select pg_catalog.pg_advisory_xact_lock(170926,1);
update festival_ops.rules set enabled=false,version=version+1 where enabled;
notify pgrst,'reload schema';
commit;

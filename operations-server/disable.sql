-- Emergency stop: preserve all records and the existing NFC system.
begin;
revoke execute on function public.festival_ops_read(text,jsonb), public.festival_ops_write(text,jsonb,uuid) from authenticated;
notify pgrst,'reload schema';
commit;

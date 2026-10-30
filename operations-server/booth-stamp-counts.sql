-- Approved 2026-10-30: per-booth stamp completion counts on the operator dashboard.
-- Read-only and operator-only. No table is added or changed. Rollback: drop the function.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- One visit row is one participant's stamp at one booth; distinct users are counted anyway.
create function public.festival_booth_stamp_counts() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare me jsonb; e uuid;
begin
  me := festival_nfc_private.current_profile();
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  if e is null then return jsonb_build_object('items','[]'::jsonb); end if;
  return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('booth',x.key,'name',x.name,'status',x.status,
      'stamps',x.stamps,'nfc',x.nfc,'manual',x.stamps-x.nfc) order by x.stamps desc,x.name)
    from (select b.key,b.name,b.status,
        (select count(distinct v.user_id) from festival_ops.visits v where v.event_id=e and v.booth_key=b.key)::integer stamps,
        (select count(distinct v.user_id) from festival_ops.visits v where v.event_id=e and v.booth_key=b.key and v.method='nfc')::integer nfc
      from festival_ops.booths b where b.event_id=e) x),'[]'::jsonb));
end $$;
revoke all on function public.festival_booth_stamp_counts() from public,anon,authenticated;
grant execute on function public.festival_booth_stamp_counts() to authenticated;

notify pgrst,'reload schema';
commit;

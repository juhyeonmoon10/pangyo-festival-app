-- Approved 2026-10-31 (user request): operators may act on their own account in every operator tool:
-- manual stamp, points, voucher issue, void and redemption, and linking their own club membership.
-- Apply after student-number-only.sql. No table is added and no data changes.
-- The live definitions are edited in place: only the self-account refusals are removed, everything else
-- (permissions, validation, own-club stamp rule, audit) stays. The block fails if a refusal remains.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

do $$
declare d text;
begin
  d:=pg_get_functiondef('public.festival_ops_write(text,jsonb,uuid)'::regprocedure); d:=replace(d,E'\r\n',E'\n');
  -- visit_approve and points_adjust
  d:=replace(d,E'      if target=u then raise exception ''SELF_ADJUSTMENT''; end if;\n','');
  -- voucher_issue
  d:=replace(d,'(target=u or coalesce(length(why),0) not between 3 and 300)','(coalesce(length(why),0) not between 3 and 300)');
  -- voucher_redeem (legacy QR token) and voucher_void
  d:=replace(d,E'      if v.user_id=u then raise exception ''SELF_REDEMPTION''; end if;\n','');
  d:=replace(d,E'      if v.user_id=u then raise exception ''SELF_ADJUSTMENT''; end if;\n','');
  if d ~ 'SELF_ADJUSTMENT|SELF_REDEMPTION|target=u or' then raise exception 'SELF_RULE_REMAINS festival_ops_write'; end if;
  execute d;

  d:=pg_get_functiondef('public.festival_review_identity_admin_internal(text,jsonb)'::regprocedure); d:=replace(d,E'\r\n',E'\n');
  d:=replace(d,E'    if target=actor then raise exception ''SELF_ADJUSTMENT''; end if;\n','');
  if d ~ 'SELF_ADJUSTMENT' then raise exception 'SELF_RULE_REMAINS festival_review_identity_admin_internal'; end if;
  execute d;

  -- Legacy QR voucher check: an operator's own voucher is valid too.
  d:=pg_get_functiondef('public.festival_ops_read(text,jsonb)'::regprocedure); d:=replace(d,E'\r\n',E'\n');
  d:=replace(d,' and v.user_id<>u and e.state=''open''',' and e.state=''open''');
  if d ~ 'v\.user_id<>u' then raise exception 'SELF_RULE_REMAINS festival_ops_read'; end if;
  execute d;
end $$;

notify pgrst,'reload schema';
commit;

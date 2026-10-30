-- Rollback for operator-self-actions.sql: puts the self-account refusals back into the live definitions.
-- No data changes; actions already taken on an operator's own account stay recorded.
begin;
select pg_catalog.pg_advisory_xact_lock(170926,1);
do $$
declare d text; before text;
begin
  d:=pg_get_functiondef('public.festival_ops_write(text,jsonb,uuid)'::regprocedure); d:=replace(d,E'\r\n',E'\n'); before:=d;
  d:=replace(d,E'      target := (p_payload->>''userId'')::integer;\n      if not exists',
    E'      target := (p_payload->>''userId'')::integer;\n      if target=u then raise exception ''SELF_ADJUSTMENT''; end if;\n      if not exists');
  d:=replace(d,E'      target := (p_payload->>''userId'')::integer; delta := (p_payload->>''delta'')::integer;\n',
    E'      target := (p_payload->>''userId'')::integer; delta := (p_payload->>''delta'')::integer;\n      if target=u then raise exception ''SELF_ADJUSTMENT''; end if;\n');
  d:=replace(d,'if p_action=''voucher_issue'' and (coalesce(length(why),0) not between 3 and 300)','if p_action=''voucher_issue'' and (target=u or coalesce(length(why),0) not between 3 and 300)');
  d:=replace(d,E'      if v.id is null then raise exception ''VOUCHER_INVALID''; end if;\n',
    E'      if v.id is null then raise exception ''VOUCHER_INVALID''; end if;\n      if v.user_id=u then raise exception ''SELF_REDEMPTION''; end if;\n');
  d:=replace(d,E'      if v.id is null then raise exception ''NOT_FOUND''; end if;\n      if v.state<>''available'' then raise exception ''VOUCHER_USED''; end if;\n      update festival_ops.vouchers set state=''void''',
    E'      if v.id is null then raise exception ''NOT_FOUND''; end if;\n      if v.user_id=u then raise exception ''SELF_ADJUSTMENT''; end if;\n      if v.state<>''available'' then raise exception ''VOUCHER_USED''; end if;\n      update festival_ops.vouchers set state=''void''');
  if d=before then raise exception 'ROLLBACK_NOT_APPLIED festival_ops_write'; end if;
  execute d;

  d:=pg_get_functiondef('public.festival_review_identity_admin_internal(text,jsonb)'::regprocedure); d:=replace(d,E'\r\n',E'\n'); before:=d;
  d:=replace(d,E'  if p_action in (''save'',''revoke'') then\n',E'  if p_action in (''save'',''revoke'') then\n    if target=actor then raise exception ''SELF_ADJUSTMENT''; end if;\n');
  if d=before then raise exception 'ROLLBACK_NOT_APPLIED festival_review_identity_admin_internal'; end if;
  execute d;

  d:=pg_get_functiondef('public.festival_ops_read(text,jsonb)'::regprocedure); d:=replace(d,E'\r\n',E'\n'); before:=d;
  d:=replace(d,' and v.token_expires_at>now() and e.state=''open''',' and v.token_expires_at>now() and v.user_id<>u and e.state=''open''');
  if d=before then raise exception 'ROLLBACK_NOT_APPLIED festival_ops_read'; end if;
  execute d;
end $$;
notify pgrst,'reload schema';
commit;

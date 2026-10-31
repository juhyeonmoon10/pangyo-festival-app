-- Approved 2026-10-31 (user request): 관리 마법사 → 참여자 → 학생 계정 삭제.
-- Apply after voucher-approval-and-manual-issue.sql.
-- The project and public.users are shared with ORBIT, so the account row, the Google sign-in and every
-- ORBIT record (points, orders, stocks, games, rankings, legacy booth ratings) stay. What is deleted is
-- the student's festival account:
-- * festival records of every event: visits (stamps), vouchers, reviews, festival points, the 소속 확인
--   link, 부스 담당자 and 바우처 담당자 roles and request receipts; legacy stamp mirrors in
--   public.users.completed_booths that those NFC visits created (as festival_ops_reset does);
-- * the festival registration (festival_name, festival_student_number in the Google account metadata);
-- * every sign-in session, so the student is signed out at once.
-- On the next sign-in the student registers again as a new participant.
-- Audit rows are kept, and a new 'account_delete' row records who deleted which account and why.
-- Only operators may delete, never their own account or another operator, and only after typing "삭제".
-- Rollback (removes the function; deleted records cannot be restored): account-delete-rollback.sql.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create or replace function public.festival_account_delete(p_payload jsonb, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e uuid; u integer; target integer; who public.users; sid text; why text; old festival_ops.requests; fp bytea; result jsonb;
  c_visits integer; c_vouchers integer; c_reviews integer; c_ledger integer; c_identity integer; c_booth integer; c_voucher integer;
  c_sessions integer; c_stamps integer;
begin
  if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or p_payload ? 'userId'
    or length(p_payload::text)>1000 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  e:=festival_ops.require_operator();
  u:=(festival_nfc_private.current_profile()->>'id')::integer;
  fp:=extensions.digest('account_delete:'||p_payload::text,'sha256');
  select * into old from festival_ops.requests where actor_id=u and request_id=p_request_id;
  if found then
    if old.fingerprint<>fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  if p_payload->>'confirm' is distinct from U&'\C0AD\C81C' then raise exception 'ACCOUNT_DELETE_CONFIRM_REQUIRED'; end if;
  why:=btrim(coalesce(p_payload->>'reason',''));
  if length(why) not between 3 and 300 then raise exception 'INVALID_INPUT'; end if;
  target:=festival_ops.resolve_student(e,btrim(coalesce(p_payload->>'studentNumber','')),nullif(btrim(p_payload->>'email'),''));
  if target=u then raise exception 'ACCOUNT_DELETE_SELF'; end if;
  select * into who from public.users where id=target for update;
  if coalesce(who.admin,false) then raise exception 'ACCOUNT_DELETE_OPERATOR'; end if;
  sid:=festival_ops.student_number_of(e,target);

  -- Legacy stamp mirrors created by this student's own NFC visits (any event).
  update public.users a set completed_booths=array(
    select stamp from unnest(a.completed_booths) stamp where not exists(
      select 1 from festival_ops.visits v join festival_ops.booths b on b.event_id=v.event_id and b.key=v.booth_key
      where v.user_id=a.id and v.method='nfc' and b.legacy_key=stamp))
    where a.id=target and exists(select 1 from festival_ops.visits v join festival_ops.booths b on b.event_id=v.event_id and b.key=v.booth_key
      where v.user_id=a.id and v.method='nfc' and b.legacy_key=any(a.completed_booths));
  get diagnostics c_stamps=row_count;
  delete from festival_ops.vouchers where user_id=target; get diagnostics c_vouchers=row_count;
  delete from festival_ops.ledger where user_id=target; get diagnostics c_ledger=row_count;
  delete from festival_ops.reviews where user_id=target; get diagnostics c_reviews=row_count;
  delete from festival_ops.visits where user_id=target; get diagnostics c_visits=row_count;
  delete from festival_ops.review_identities where user_id=target; get diagnostics c_identity=row_count;
  delete from festival_ops.booth_managers where user_id=target; get diagnostics c_booth=row_count;
  delete from festival_ops.voucher_managers where user_id=target; get diagnostics c_voucher=row_count;
  delete from festival_ops.requests where actor_id=target;
  -- The festival registration, then every session: the next sign-in starts a new registration.
  update auth.users set raw_user_meta_data=coalesce(raw_user_meta_data,'{}'::jsonb)-'festival_name'-'festival_student_number'
    where id=who.auth_user_id;
  delete from auth.sessions where user_id=who.auth_user_id; get diagnostics c_sessions=row_count;

  result:=jsonb_build_object('deleted',true,'name',coalesce(who.name,'참여자'),'studentNumber',sid,
    'visits',c_visits,'vouchers',c_vouchers,'reviews',c_reviews,'points',c_ledger,
    'identity',c_identity>0,'roles',c_booth+c_voucher,'stampMirrors',c_stamps,'signedOut',c_sessions>0);
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(e,u,'account_delete',target::text,coalesce(sid,'학번 없음')||' · '||why||' · '||(result-'deleted'-'name'-'studentNumber')::text);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;
revoke all on function public.festival_account_delete(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.festival_account_delete(jsonb,uuid) to authenticated;

notify pgrst,'reload schema';
commit;

-- Rollback for student-number-only.sql: restores the account-number admin functions for the browser.
-- No data changes. Older browser code that sends account numbers works again after this.
begin;
select pg_catalog.pg_advisory_xact_lock(170926,1);
drop trigger audit_student_number_only on festival_ops.audit;
drop function festival_ops.guard_account_number_write();
drop function public.festival_review_identity_student(text,jsonb);
drop function public.festival_ops_write_student(text,jsonb,uuid);
drop function public.festival_student_lookup(jsonb);
alter function public.festival_review_identity_admin_internal(text,jsonb) rename to festival_review_identity_admin;
revoke all on function public.festival_review_identity_admin(text,jsonb) from public,anon;
grant execute on function public.festival_review_identity_admin(text,jsonb) to authenticated;
create or replace function public.festival_identity_overview() returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; e uuid;
begin
  me:=festival_nfc_private.current_profile();
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  return jsonb_build_object('eventId',e,
    'roster',(select jsonb_build_object('students',count(*),'ready',count(*) filter (where status='ready'),
      'review',count(*) filter (where status<>'ready'),'withBooth',count(*) filter (where status='ready' and cardinality(booth_keys)>0))
      from festival_ops.review_roster where event_id=e),
    'links',(select jsonb_build_object('self',count(*) filter (where verified and confirmed_by=user_id),
      'operator',count(*) filter (where verified and confirmed_by<>user_id),'revoked',count(*) filter (where not verified))
      from festival_ops.review_identities where event_id=e),
    'removedStamps',(select coalesce(sum(reason::integer),0) from festival_ops.audit where event_id=e and action='own_club_stamp_remove'),
    'conflicts',coalesce((select jsonb_agg(jsonb_build_object('userId',x.actor_id,'accountName',ua.name,
        'studentNumber',festival_ops.student_number_of(e,x.actor_id),
        'holderId',x.reason::integer,'holderName',uh.name,'holderStudentNumber',festival_ops.student_number_of(e,x.reason::integer),
        'at',x.created_at) order by x.id desc)
      from (select * from festival_ops.audit where event_id=e and action='review_identity_self_conflict' order by id desc limit 20) x
      left join public.users ua on ua.id=x.actor_id left join public.users uh on uh.id=x.reason::integer),'[]'::jsonb),
    'removals',coalesce((select jsonb_agg(jsonb_build_object('userId',x.target::integer,'accountName',ut.name,
        'studentNumber',festival_ops.student_number_of(e,x.target::integer),'count',x.reason::integer,'at',x.created_at) order by x.id desc)
      from (select * from festival_ops.audit where event_id=e and action='own_club_stamp_remove' order by id desc limit 20) x
      left join public.users ut on ut.id=x.target::integer),'[]'::jsonb));
end $$;
create or replace function public.festival_ops_read(p_kind text, p_query jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; admin boolean; e festival_ops.events; result jsonb; q text; offn integer;
begin
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  admin := coalesce((me->>'isAdmin')::boolean,false);
  if p_kind not in ('catalog','me','reviews','dashboard','participants','visits','ledger','rules','vouchers','audit','voucher_check')
    or jsonb_typeof(p_query) <> 'object' or length(p_query::text)>2000 then raise exception 'INVALID_INPUT'; end if;
  if p_kind in ('dashboard','participants','visits','ledger','rules','vouchers','audit','voucher_check') and not admin then raise exception 'ADMIN_REQUIRED'; end if;
  select * into e from festival_ops.events where current;
  if e.id is null then return jsonb_build_object('ready',false,'items','[]'::jsonb); end if;
  offn := greatest(0,least(100000,coalesce((p_query->>'offset')::integer,0)));
  q := btrim(left(coalesce(p_query->>'search',''),100));
  if p_kind='catalog' then
    select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('rating',
      (select round(avg(r.rating),1) from festival_ops.reviews r where r.event_id=e.id and r.booth_key=b.key)) order by b.floor,b.name),'[]') into result from festival_ops.booths b where event_id=e.id;
  elsif p_kind='me' then
    return jsonb_build_object('ready',true,'event',to_jsonb(e),
      'points',(select coalesce(sum(delta),0) from festival_ops.ledger where event_id=e.id and user_id=u),
      'visits',(select coalesce(jsonb_agg(to_jsonb(v) order by created_at),'[]') from festival_ops.visits v where event_id=e.id and user_id=u),
      'reviews',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from festival_ops.reviews r where event_id=e.id and user_id=u),
      'rules',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'target',r.target,'expires_at',r.expires_at)),'[]') from festival_ops.rules r where event_id=e.id and enabled and expires_at>now()),
      'vouchers',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'state',v.state,'expiresAt',v.expires_at,'redeemedAt',v.redeemed_at) order by created_at desc),'[]') from festival_ops.vouchers v where event_id=e.id and user_id=u));
  elsif p_kind='reviews' then
    return festival_ops.review_summary(e.id,u,p_query->>'booth');
  elsif p_kind='voucher_check' then
    select jsonb_build_object('id',v.id,'title',v.title,'participant',a.name,'state',v.state,
      'valid',v.state='available' and v.expires_at>now() and v.token_expires_at>now() and v.user_id<>u and e.state='open') into result
      from festival_ops.vouchers v join public.users a on a.id=v.user_id where v.event_id=e.id
      and v.token_hash=extensions.digest(p_query->>'token','sha256');
    if result is null then raise exception 'VOUCHER_INVALID'; end if;
    return result;
  elsif p_kind='dashboard' then
    return jsonb_build_object('ready',true,'event',to_jsonb(e),
      'participants',(select count(distinct user_id) from festival_ops.visits where event_id=e.id),
      'visits',(select count(*) from festival_ops.visits where event_id=e.id),
      'reviews',(select count(*) from festival_ops.reviews where event_id=e.id),
      'issued',(select count(*) from festival_ops.vouchers where event_id=e.id),
      'used',(select count(*) from festival_ops.vouchers where event_id=e.id and state='used'));
  elsif p_kind='participants' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select a.id,a.name,s.sid student_number,(select count(*) from festival_ops.visits v where v.user_id=a.id and v.event_id=e.id) visits,
        (select coalesce(sum(delta),0) from festival_ops.ledger l where l.user_id=a.id and l.event_id=e.id) points
      from public.users a cross join lateral (select festival_ops.student_number_of(e.id,a.id) sid) s
      where a.auth_user_id is not null and (q='' or a.name ilike '%'||q||'%' or s.sid=q)
      order by s.sid nulls last,a.name limit 50 offset offn) x;
  elsif p_kind='visits' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select v.*,a.name,s.sid student_number from festival_ops.visits v join public.users a on a.id=v.user_id
      cross join lateral (select festival_ops.student_number_of(e.id,v.user_id) sid) s
      where v.event_id=e.id and (q='' or v.booth_key=q or s.sid=q or a.name ilike '%'||q||'%') order by v.created_at desc limit 50 offset offn) x;
  elsif p_kind='ledger' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select l.*,a.name,s.sid student_number from festival_ops.ledger l join public.users a on a.id=l.user_id
      cross join lateral (select festival_ops.student_number_of(e.id,l.user_id) sid) s
      where l.event_id=e.id and (q='' or s.sid=q or a.name ilike '%'||q||'%') order by l.id desc limit 50 offset offn) x;
  elsif p_kind='rules' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select r.*,(select count(*) from festival_ops.vouchers v where v.rule_id=r.id) issued
      from festival_ops.rules r where r.event_id=e.id order by r.target,r.id) x;
  elsif p_kind='vouchers' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select v.id,v.user_id,a.name,s.sid student_number,v.title,v.state,v.created_at,v.expires_at,v.redeemed_at
      from festival_ops.vouchers v join public.users a on a.id=v.user_id
      cross join lateral (select festival_ops.student_number_of(e.id,v.user_id) sid) s where v.event_id=e.id
      and (q='' or s.sid=q or a.name ilike '%'||q||'%' or v.id::text=q) order by v.created_at desc limit 50 offset offn) x;
  elsif p_kind='audit' then
    -- Actions whose target is an account record that account's name and student number, not its id.
    select coalesce(jsonb_agg(to_jsonb(x) - 'target_user'),'[]') into result from (
      select au.*,pa.name actor_name,festival_ops.student_number_of(e.id,au.actor_id) actor_student_number,
        pt.name target_name,case when pt.id is not null then festival_ops.student_number_of(e.id,pt.id) end target_student_number,
        pt.id target_user
      from festival_ops.audit au left join public.users pa on pa.id=au.actor_id
      left join public.users pt on pt.id=(case when au.target ~ '^[0-9]{1,9}$' then au.target::integer end)
        and (au.action like 'review_identity%' or au.action in ('own_club_stamp_remove','visit_approve','points_adjust','voucher_issue'))
      where au.event_id=e.id order by au.id desc limit 50 offset offn) x;
  end if;
  return jsonb_build_object('ready',true,'event',to_jsonb(e),'items',result,'offset',offn);
end $$;

create or replace function public.festival_claim_guard(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; g festival_ops.claim_guard; win integer; maxc integer;
begin
  if p_action is null or p_action not in ('read','save') or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or length(p_payload::text)>500 then raise exception 'INVALID_INPUT'; end if;
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  if p_action='save' then
    perform pg_catalog.pg_advisory_xact_lock(170926,1);
    g:=festival_ops.claim_guard_of(e);
    if (p_payload->>'version')::integer is distinct from g.version then raise exception 'VERSION_CONFLICT'; end if;
    if jsonb_typeof(p_payload->'enabled') is distinct from 'boolean' then raise exception 'INVALID_INPUT'; end if;
    win:=(p_payload->>'windowMinutes')::integer; maxc:=(p_payload->>'maxClaims')::integer;
    if win is null or win not between 1 and 180 or maxc is null or maxc not between 1 and 100 then raise exception 'INVALID_INPUT'; end if;
    insert into festival_ops.claim_guard(event_id,enabled,window_minutes,max_claims,version,updated_by,updated_at)
      values(e,(p_payload->>'enabled')::boolean,win,maxc,g.version+1,u,now())
    on conflict(event_id) do update set enabled=excluded.enabled,window_minutes=excluded.window_minutes,
      max_claims=excluded.max_claims,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
    insert into festival_ops.audit(event_id,actor_id,action,target,reason)
      values(e,u,'claim_guard_save',null,format('%s, %s분에 최대 %s개',case when (p_payload->>'enabled')::boolean then '사용' else '사용 안 함' end,win,maxc));
  end if;
  g:=festival_ops.claim_guard_of(e);
  -- A participant is listed when some M-minute span holds at least N NFC stamps (the limit was reached).
  return jsonb_build_object('enabled',g.enabled,'windowMinutes',g.window_minutes,'maxClaims',g.max_claims,'version',g.version,
    'items',coalesce((select jsonb_agg(jsonb_build_object('userId',x.user_id,'name',coalesce(pu.name,'참여자'),
        'studentNumber',festival_ops.student_number_of(e,x.user_id),'peak',x.peak,
        'nfc',x.nfc,'manual',x.manual,'lastAt',x.last_at,'peakAt',x.peak_at) order by x.peak desc,x.last_at desc)
      from (select w.user_id,max(w.n) peak,
          (array_agg(w.created_at order by w.n desc,w.created_at desc))[1] peak_at,
          (select count(*) from festival_ops.visits where event_id=e and user_id=w.user_id and method='nfc') nfc,
          (select count(*) from festival_ops.visits where event_id=e and user_id=w.user_id and method<>'nfc') manual,
          max(w.created_at) last_at
        from (select a.user_id,a.created_at,(select count(*) from festival_ops.visits b where b.event_id=e and b.user_id=a.user_id
            and b.method='nfc' and b.created_at>a.created_at-make_interval(mins=>g.window_minutes) and b.created_at<=a.created_at) n
          from festival_ops.visits a where a.event_id=e and a.method='nfc') w
        group by w.user_id having max(w.n)>=g.max_claims order by max(w.n) desc limit 200) x
      left join public.users pu on pu.id=x.user_id),'[]'::jsonb));
end $$;

drop function festival_ops.require_operator();
drop function festival_ops.resolve_student(uuid,text,text);
notify pgrst,'reload schema';
commit;

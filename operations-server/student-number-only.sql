-- Approved 2026-10-31 (user request): remove the participant-number system. Operators name a participant
-- only by student number (학번); the browser never sends or receives an internal account number.
-- Apply after student-number-display.sql. No table is added; public.users.id stays the shared primary key.
-- 1. festival_ops.resolve_student(event, 학번, email): the account a student number refers to. A confirmed
--    link wins; otherwise exactly one account must carry the number. Two accounts sharing a 학번 are told
--    apart by their Google email (shown to operators only in that case).
-- 2. public.festival_student_lookup: operator preview of the accounts behind a 학번.
-- 3. public.festival_ops_write_student: manual stamp, points and voucher issue by 학번.
-- 4. public.festival_review_identity_student: 소속 확인 get/lookup/save/revoke/list by 학번.
-- 5. festival_identity_overview identifies conflicting accounts by 학번 and email, not account numbers.
-- 6. The account-number writes are closed to the browser: visit_approve, points_adjust and manual
--    voucher_issue succeed only through festival_ops_write_student, and festival_review_identity_admin is
--    renamed to an internal function the browser cannot call.
-- 7. Operator lists carry no account numbers: festival_ops_read drops id/user_id/actor_id from participants,
--    visits, points, vouchers and audit rows (account targets are shown by name and 학번 only), and the
--    claim guard list drops userId.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create function festival_ops.resolve_student(e uuid,sid text,mail text default null) returns integer
language plpgsql stable set search_path='' as $$
declare ids integer[]; held integer[];
begin
  if sid is null or sid !~ '^[1-3][0-9]{4}$' or (mail is not null and length(mail)>320) then raise exception 'INVALID_INPUT'; end if;
  select array_agg(p.id),array_agg(p.id) filter (where exists(select 1 from festival_ops.review_identities i
      where i.event_id=e and i.user_id=p.id and i.verified and i.student_number=sid))
    into ids,held
    from public.users p join auth.users a on a.id=p.auth_user_id
    where festival_ops.student_number_of(e,p.id)=sid and (mail is null or lower(a.email)=lower(mail));
  if ids is null then raise exception 'STUDENT_NOT_FOUND'; end if;
  if cardinality(ids)=1 then return ids[1]; end if;
  if mail is null and cardinality(held)=1 then return held[1]; end if;
  raise exception 'STUDENT_AMBIGUOUS';
end $$;

create function festival_ops.require_operator() returns uuid
language plpgsql set search_path='' as $$
declare me jsonb; e uuid;
begin
  me:=festival_nfc_private.current_profile();
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  return e;
end $$;

create function public.festival_student_lookup(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e uuid; sid text; me integer; chosen integer;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>200 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  e:=festival_ops.require_operator();
  me:=(festival_nfc_private.current_profile()->>'id')::integer;
  sid:=btrim(p_payload->>'studentNumber');
  if sid is null or sid !~ '^[1-3][0-9]{4}$' then raise exception 'INVALID_INPUT'; end if;
  begin chosen:=festival_ops.resolve_student(e,sid); exception when others then chosen:=null; end;
  return jsonb_build_object('studentNumber',sid,
    'accounts',coalesce((select jsonb_agg(jsonb_build_object('name',p.name,'email',a.email,'self',p.id=me,'selected',p.id=chosen,
        'visits',(select count(*) from festival_ops.visits v where v.event_id=e and v.user_id=p.id),
        'points',(select coalesce(sum(delta),0) from festival_ops.ledger l where l.event_id=e and l.user_id=p.id))
        || (festival_ops.identity_state(e,p.id) - 'boothKeys') order by p.id=chosen desc,p.name)
      from public.users p join auth.users a on a.id=p.auth_user_id where festival_ops.student_number_of(e,p.id)=sid),'[]'::jsonb));
end $$;

create function public.festival_ops_write_student(p_action text,p_payload jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e uuid; target integer;
begin
  if p_action is null or p_action not in ('visit_approve','points_adjust','voucher_issue') or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or p_payload ? 'userId' or length(p_payload::text)>6000 then raise exception 'INVALID_INPUT'; end if;
  -- Same lock order as festival_ops_write: the operations lock before the profile lock.
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  e:=festival_ops.require_operator();
  target:=festival_ops.resolve_student(e,btrim(p_payload->>'studentNumber'),nullif(btrim(p_payload->>'email'),''));
  perform set_config('festival.student_write','on',true);
  return public.festival_ops_write(p_action,(p_payload-'studentNumber'-'email')||jsonb_build_object('userId',target),p_request_id);
end $$;

-- The account-number form of these writes is no longer accepted from the browser.
create function festival_ops.guard_account_number_write() returns trigger
language plpgsql set search_path='' as $$
begin
  if current_setting('festival.student_write',true) is distinct from 'on' then raise exception 'INVALID_INPUT'; end if;
  return new;
end $$;
-- festival_ops_write audits each of these with the account number as target; automatic voucher awards
-- audit 'voucher_issue' with a voucher id instead and are unaffected.
create trigger audit_student_number_only before insert on festival_ops.audit
  for each row when (new.action in ('visit_approve','points_adjust') or (new.action='voucher_issue' and new.target ~ '^[0-9]+$'))
  execute function festival_ops.guard_account_number_write();

create function public.festival_review_identity_student(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e uuid; target integer; r jsonb; acct jsonb;
begin
  if p_action is null or p_action not in ('get','lookup','save','revoke','list') or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or p_payload ? 'userId' or length(p_payload::text)>20000 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  e:=festival_ops.require_operator();
  if p_action='list' then
    r:=public.festival_review_identity_admin_internal('list',p_payload);
    return (r-'items')||jsonb_build_object('items',coalesce((select jsonb_agg((it-'userId')||jsonb_build_object(
        'email',(select a.email from public.users p join auth.users a on a.id=p.auth_user_id where p.id=(it->>'userId')::integer),
        'accountStudentNumber',festival_ops.student_number_of(e,(it->>'userId')::integer)))
      from jsonb_array_elements(r->'items') it),'[]'::jsonb));
  end if;
  acct:=p_payload->'account';
  if jsonb_typeof(acct) is distinct from 'object' then raise exception 'INVALID_INPUT'; end if;
  target:=festival_ops.resolve_student(e,btrim(acct->>'studentNumber'),nullif(btrim(acct->>'email'),''));
  r:=public.festival_review_identity_admin_internal(p_action,(p_payload-'account')||jsonb_build_object('userId',target));
  return (r-'userId')||jsonb_build_object('account',jsonb_build_object('studentNumber',festival_ops.student_number_of(e,target),
    'email',(select a.email from public.users p join auth.users a on a.id=p.auth_user_id where p.id=target)));
end $$;

-- Keep the account-number implementation for the 학번 wrapper only.
alter function public.festival_review_identity_admin(text,jsonb) rename to festival_review_identity_admin_internal;
revoke all on function public.festival_review_identity_admin_internal(text,jsonb) from public,anon,authenticated;

create or replace function public.festival_identity_overview() returns jsonb
language plpgsql security definer set search_path='' as $$
declare e uuid;
begin
  e:=festival_ops.require_operator();
  return jsonb_build_object('eventId',e,
    'roster',(select jsonb_build_object('students',count(*),'ready',count(*) filter (where status='ready'),
      'review',count(*) filter (where status<>'ready'),'withBooth',count(*) filter (where status='ready' and cardinality(booth_keys)>0))
      from festival_ops.review_roster where event_id=e),
    'links',(select jsonb_build_object('self',count(*) filter (where verified and confirmed_by=user_id),
      'operator',count(*) filter (where verified and confirmed_by<>user_id),'revoked',count(*) filter (where not verified))
      from festival_ops.review_identities where event_id=e),
    'removedStamps',(select coalesce(sum(reason::integer),0) from festival_ops.audit where event_id=e and action='own_club_stamp_remove'),
    'conflicts',coalesce((select jsonb_agg(jsonb_build_object('accountName',ua.name,'email',aa.email,
        'studentNumber',festival_ops.student_number_of(e,x.actor_id),
        'holderName',uh.name,'holderEmail',ah.email,'holderStudentNumber',festival_ops.student_number_of(e,x.reason::integer),
        'at',x.created_at) order by x.id desc)
      from (select * from festival_ops.audit where event_id=e and action='review_identity_self_conflict' order by id desc limit 20) x
      left join public.users ua on ua.id=x.actor_id left join auth.users aa on aa.id=ua.auth_user_id
      left join public.users uh on uh.id=x.reason::integer left join auth.users ah on ah.id=uh.auth_user_id),'[]'::jsonb),
    'removals',coalesce((select jsonb_agg(jsonb_build_object('accountName',ut.name,
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
      select a.name,s.sid student_number,(select count(*) from festival_ops.visits v where v.user_id=a.id and v.event_id=e.id) visits,
        (select coalesce(sum(delta),0) from festival_ops.ledger l where l.user_id=a.id and l.event_id=e.id) points
      from public.users a cross join lateral (select festival_ops.student_number_of(e.id,a.id) sid) s
      where a.auth_user_id is not null and (q='' or a.name ilike '%'||q||'%' or s.sid=q)
      order by s.sid nulls last,a.name limit 50 offset offn) x;
  elsif p_kind='visits' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select v.booth_key,v.method,v.reason,v.created_at,a.name,s.sid student_number from festival_ops.visits v join public.users a on a.id=v.user_id
      cross join lateral (select festival_ops.student_number_of(e.id,v.user_id) sid) s
      where v.event_id=e.id and (q='' or v.booth_key=q or s.sid=q or a.name ilike '%'||q||'%') order by v.created_at desc limit 50 offset offn) x;
  elsif p_kind='ledger' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select l.delta,l.reason,l.created_at,a.name,s.sid student_number from festival_ops.ledger l join public.users a on a.id=l.user_id
      cross join lateral (select festival_ops.student_number_of(e.id,l.user_id) sid) s
      where l.event_id=e.id and (q='' or s.sid=q or a.name ilike '%'||q||'%') order by l.id desc limit 50 offset offn) x;
  elsif p_kind='rules' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select r.*,(select count(*) from festival_ops.vouchers v where v.rule_id=r.id) issued
      from festival_ops.rules r where r.event_id=e.id order by r.target,r.id) x;
  elsif p_kind='vouchers' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select v.id,a.name,s.sid student_number,v.title,v.state,v.created_at,v.expires_at,v.redeemed_at
      from festival_ops.vouchers v join public.users a on a.id=v.user_id
      cross join lateral (select festival_ops.student_number_of(e.id,v.user_id) sid) s where v.event_id=e.id
      and (q='' or s.sid=q or a.name ilike '%'||q||'%' or v.id::text=q) order by v.created_at desc limit 50 offset offn) x;
  elsif p_kind='audit' then
    -- Account targets are shown by name and student number; no account number leaves the server.
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select au.created_at,au.action,case when pt.id is null then au.target end target,
        case when au.action='review_identity_self_conflict' then null else au.reason end reason,pa.name actor_name,festival_ops.student_number_of(e.id,au.actor_id) actor_student_number,
        pt.name target_name,case when pt.id is not null then festival_ops.student_number_of(e.id,pt.id) end target_student_number
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
    'items',coalesce((select jsonb_agg(jsonb_build_object('name',coalesce(pu.name,'참여자'),
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

revoke all on function festival_ops.resolve_student(uuid,text,text),festival_ops.require_operator(),
  festival_ops.guard_account_number_write() from public,anon,authenticated;
revoke all on function public.festival_student_lookup(jsonb),public.festival_ops_write_student(text,jsonb,uuid),
  public.festival_review_identity_student(text,jsonb) from public,anon,authenticated;
grant execute on function public.festival_student_lookup(jsonb),public.festival_ops_write_student(text,jsonb,uuid),
  public.festival_review_identity_student(text,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;

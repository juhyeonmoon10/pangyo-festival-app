-- 1.52 one point balance: 보유 포인트 (festival points) and 가상 포인트 (minigames) become public.users.money.
--   Every festival point entry (review reward, operator adjustment) still goes into festival_ops.ledger as the
--   record, and a trigger now moves public.users.money by the same amount (with a private.wallet_ledger row).
--   The three places that showed the festival_ops.ledger sum (my screen, participants, student lookup) show
--   users.money, and an operator's deduction is checked against users.money.
--   festival_ops.ledger was empty when this was written (review reward 0P), so no balance is carried over.
--   Resetting participation (festival_ops_reset) still clears the ledger rows but no longer changes points.
-- Rollback: points-unify-rollback.sql. Requested 2026-11-04.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function festival_ops.ledger_to_money() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_user public.users;
begin
  if new.delta = 0 then return new; end if;
  select * into v_user from public.users where id = new.user_id for update;
  if v_user.money::bigint + new.delta < 0 then raise exception using message = 'POINTS_INSUFFICIENT'; end if;
  update public.users set money = money + new.delta where id = new.user_id;
  insert into private.wallet_ledger(user_id, event_id, source_type, source_id, actor_user_id, delta, balance_before, balance_after)
    values (new.user_id, new.event_id::text, case when new.source_key like 'review:%' then 'reward' else 'admin_adjustment' end,
      left('festival:' || new.source_key, 200), new.actor_id, new.delta, v_user.money, v_user.money + new.delta);
  return new;
end $$;
revoke all on function festival_ops.ledger_to_money() from public, anon, authenticated;
create trigger ledger_to_money after insert on festival_ops.ledger for each row execute function festival_ops.ledger_to_money();

-- public.festival_ops_read(p_kind text, p_query jsonb)
CREATE OR REPLACE FUNCTION public.festival_ops_read(p_kind text, p_query jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'points',(select money from public.users where id=u),
      'visits',(select coalesce(jsonb_agg(to_jsonb(v) order by created_at),'[]') from festival_ops.visits v where event_id=e.id and user_id=u),
      'reviews',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from festival_ops.reviews r where event_id=e.id and user_id=u),
      'rules',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'target',r.target,'expires_at',r.expires_at)),'[]') from festival_ops.rules r where event_id=e.id and enabled and expires_at>now()),
      'vouchers',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'state',v.state,'expiresAt',v.expires_at,'redeemedAt',v.redeemed_at) order by created_at desc),'[]') from festival_ops.vouchers v where event_id=e.id and user_id=u));
  elsif p_kind='reviews' then
    return festival_ops.review_summary(e.id,u,p_query->>'booth');
  elsif p_kind='voucher_check' then
    select jsonb_build_object('id',v.id,'title',v.title,'participant',a.name,'state',v.state,
      'valid',v.state='available' and v.expires_at>now() and v.token_expires_at>now() and e.state='open') into result
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
        a.money points
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
end $function$;

-- public.festival_ops_write(p_action text, p_payload jsonb, p_request_id uuid)
CREATE OR REPLACE FUNCTION public.festival_ops_write(p_action text, p_payload jsonb, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare me jsonb; u integer; admin boolean; e festival_ops.events; b festival_ops.booths;
  old festival_ops.requests; fp bytea; result jsonb; target integer; vkey text; why text;
  delta integer; rate integer; content text; previous festival_ops.reviews; rule festival_ops.rules;
  v festival_ops.vouchers; vid uuid; token text; claim jsonb; changed integer; versionn integer;
begin
  if p_request_id is null or p_action is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>6000
    or p_action not in ('event_save','booth_save','claim','visit_approve','review_save','points_adjust','rule_save','voucher_issue','voucher_claim','voucher_qr','voucher_redeem','voucher_void') then raise exception 'INVALID_INPUT'; end if;
  -- One bounded operations write lock gives a consistent lock order with the legacy profile/claim
  -- functions. Load testing is required before raising the event capacity; never trust UI locks.
  perform pg_advisory_xact_lock(170926,1);
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  admin := coalesce((me->>'isAdmin')::boolean,false);
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if p_action not in ('claim','review_save','voucher_claim','voucher_qr') and not admin then raise exception 'ADMIN_REQUIRED'; end if;
  fp := extensions.digest(p_action||':'||p_payload::text,'sha256');
  select * into old from festival_ops.requests where actor_id=u and request_id=p_request_id;
  if found then
    if old.fingerprint<>fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  select * into e from festival_ops.events where current for update;
  why := nullif(btrim(p_payload->>'reason'),'');
  versionn := coalesce((p_payload->>'version')::integer,0);
  if p_action='event_save' then
    if length(btrim(coalesce(p_payload->>'name',''))) not between 1 and 100
      or p_payload->>'state' not in ('preparing','open','paused','closed')
      or coalesce((p_payload->>'reviewPoints')::integer,-1) not between 0 and 1000 then raise exception 'INVALID_INPUT'; end if;
    if e.id is null then
      if versionn<>0 then raise exception 'VERSION_CONFLICT'; end if;
      insert into festival_ops.events(name,state,review_points) values(btrim(p_payload->>'name'),p_payload->>'state',(p_payload->>'reviewPoints')::integer) returning * into e;
      insert into festival_ops.booths(event_id,key,legacy_key,name,location)
        select e.id,id::text,id,name,position from public.booths;
    else
      if e.version<>versionn then raise exception 'VERSION_CONFLICT'; end if;
      update festival_ops.events set name=btrim(p_payload->>'name'),state=p_payload->>'state',review_points=(p_payload->>'reviewPoints')::integer,version=version+1 where id=e.id returning * into e;
    end if;
    result := jsonb_build_object('event',to_jsonb(e));
  else
    if e.id is null then raise exception 'OPS_NOT_READY'; end if;
    if e.state<>'open' and p_action not in ('booth_save','rule_save','voucher_void') then raise exception 'EVENT_CLOSED'; end if;
    vkey := p_payload->>'booth';
    if p_action in ('booth_save','visit_approve','review_save') then
      select * into b from festival_ops.booths where event_id=e.id and booths.key=vkey;
    end if;
    if p_action='booth_save' then
      if vkey is null then vkey := 'custom-'||gen_random_uuid()::text;
      elsif b.key is null then raise exception 'NOT_FOUND'; end if;
      if b.key is not null and b.version<>versionn then raise exception 'VERSION_CONFLICT'; end if;
      if length(btrim(coalesce(p_payload->>'name',''))) not between 1 and 100
        or p_payload->>'status' not in ('open','paused','closed') or coalesce((p_payload->>'floor')::integer,0) not between 1 and 4
        or length(coalesce(p_payload->>'location',''))>200 or length(coalesce(p_payload->>'description',''))>2000 then raise exception 'INVALID_INPUT'; end if;
      insert into festival_ops.booths(event_id,key,name,location,description,floor,status)
        values(e.id,vkey,btrim(p_payload->>'name'),coalesce(p_payload->>'location',''),coalesce(p_payload->>'description',''),(p_payload->>'floor')::integer,p_payload->>'status')
        on conflict on constraint booths_pkey do update set name=excluded.name,location=excluded.location,description=excluded.description,floor=excluded.floor,status=excluded.status,version=booths.version+1;
      result := jsonb_build_object('booth',vkey);
    elsif p_action='claim' then
      claim := festival_nfc_private.claim(p_payload->>'token');
      vkey := claim->>'boothKey';
      select * into b from festival_ops.booths where event_id=e.id and legacy_key::text=vkey;
      if b.key is null then raise exception 'NOT_FOUND'; end if;
      if b.status<>'open' then raise exception 'BOOTH_CLOSED'; end if;
      insert into festival_ops.visits(event_id,user_id,booth_key,method,actor_id) values(e.id,u,b.key,'nfc',u) on conflict do nothing;
      get diagnostics changed=row_count;
      result := claim || jsonb_build_object('result',case when changed=0 then 'ALREADY_EARNED' else 'EARNED' end);
    elsif p_action='visit_approve' then
      if b.key is null then raise exception 'NOT_FOUND'; end if;
      if b.status<>'open' then raise exception 'BOOTH_CLOSED'; end if;
      target := (p_payload->>'userId')::integer;
      if not exists(select 1 from public.users where id=target and auth_user_id is not null) then raise exception 'NOT_FOUND'; end if;
      if coalesce(length(why),0) not between 3 and 300 then raise exception 'INVALID_INPUT'; end if;
      insert into festival_ops.visits(event_id,user_id,booth_key,method,actor_id,reason) values(e.id,target,vkey,'manual',u,why) on conflict do nothing;
      get diagnostics changed=row_count;
      result := jsonb_build_object('result',case when changed=0 then 'ALREADY_EARNED' else 'EARNED' end);
    elsif p_action='review_save' then
      if not exists(select 1 from festival_ops.visits where event_id=e.id and user_id=u and booth_key=vkey) then raise exception 'VISIT_REQUIRED'; end if;
      rate := (p_payload->>'rating')::integer; content := btrim(coalesce(p_payload->>'content',''));
      if rate is null or rate not between 1 and 5 or length(content)>500 then raise exception 'INVALID_INPUT'; end if;
      select * into previous from festival_ops.reviews where event_id=e.id and user_id=u and booth_key=vkey;
      if previous.rating is not null and (previous.rating<>rate or previous.content<>'') then raise exception 'ALREADY_REVIEWED'; end if;
      insert into festival_ops.reviews(event_id,user_id,booth_key,rating,content) values(e.id,u,vkey,rate,content)
        on conflict(event_id,user_id,booth_key) do update set content=excluded.content,updated_at=now();
      if content<>'' and e.review_points>0 then
        insert into festival_ops.ledger(event_id,user_id,delta,source_key,actor_id,reason) values(e.id,u,e.review_points,'review:'||vkey,u,'Written review reward') on conflict do nothing;
      end if;
      for rule in select r.* from festival_ops.rules r where r.event_id=e.id and r.enabled and r.expires_at>now()
        and r.target<=(select count(*) from festival_ops.reviews where event_id=e.id and user_id=u) order by r.id loop
        if (select count(*) from festival_ops.vouchers where rule_id=rule.id)<rule.stock then perform festival_ops.award(e.id,u,rule.id,u); end if;
      end loop;
      result := festival_ops.review_summary(e.id,u,vkey) || jsonb_build_object('result','SAVED');
    elsif p_action='points_adjust' then
      target := (p_payload->>'userId')::integer; delta := (p_payload->>'delta')::integer;
      if not exists(select 1 from public.users where id=target and auth_user_id is not null) then raise exception 'NOT_FOUND'; end if;
      if delta is null or delta=0 or delta not between -100000 and 100000 or coalesce(length(why),0) not between 3 and 300 then raise exception 'INVALID_INPUT'; end if;
      if (select money from public.users where id=target)+delta<0 then raise exception 'POINTS_INSUFFICIENT'; end if;
      insert into festival_ops.ledger(event_id,user_id,delta,source_key,actor_id,reason) values(e.id,target,delta,'adjust:'||p_request_id::text,u,why);
      result := jsonb_build_object('saved',true);
    elsif p_action='rule_save' then
      vid := (p_payload->>'id')::uuid;
      if vid is not null then
        select * into rule from festival_ops.rules where event_id=e.id and id=vid;
        if rule.id is null then raise exception 'NOT_FOUND'; end if;
        if rule.version<>versionn then raise exception 'VERSION_CONFLICT'; end if;
        if (p_payload->>'stock')::integer<(select count(*) from festival_ops.vouchers where rule_id=vid) then raise exception 'INVALID_INPUT'; end if;
      end if;
      if coalesce((p_payload->>'expiresAt')::timestamptz,now())<=now() then raise exception 'INVALID_INPUT'; end if;
      insert into festival_ops.rules(id,event_id,title,target,stock,enabled,expires_at)
        values(coalesce(vid,gen_random_uuid()),e.id,btrim(p_payload->>'title'),(p_payload->>'target')::integer,(p_payload->>'stock')::integer,(p_payload->>'enabled')::boolean,(p_payload->>'expiresAt')::timestamptz)
        on conflict(id) do update set title=excluded.title,target=excluded.target,stock=excluded.stock,enabled=excluded.enabled,expires_at=excluded.expires_at,version=rules.version+1 returning id into vid;
      result := jsonb_build_object('id',vid);
    elsif p_action in ('voucher_issue','voucher_claim') then
      target := case when p_action='voucher_claim' then u else (p_payload->>'userId')::integer end;
      if not exists(select 1 from public.users where id=target and auth_user_id is not null) then raise exception 'NOT_FOUND'; end if;
      if p_action='voucher_issue' and (coalesce(length(why),0) not between 3 and 300) then raise exception 'INVALID_INPUT'; end if;
      vid := (p_payload->>'ruleId')::uuid;
      if p_action='voucher_claim' and not exists(select 1 from festival_ops.rules r where r.id=vid and r.event_id=e.id
        and r.target<=(select count(*) from festival_ops.reviews where event_id=e.id and user_id=u)) then raise exception 'VISIT_REQUIRED'; end if;
      vid := festival_ops.award(e.id,target,vid,u); result := jsonb_build_object('id',vid);
    elsif p_action='voucher_qr' then
      select * into v from festival_ops.vouchers where event_id=e.id and id=(p_payload->>'id')::uuid and user_id=u for update;
      if v.id is null then raise exception 'NOT_FOUND'; end if;
      if v.state<>'available' then raise exception 'VOUCHER_USED'; end if;
      if v.expires_at<=now() then raise exception 'VOUCHER_EXPIRED'; end if;
      token := 'fv1.'||encode(extensions.gen_random_bytes(32),'hex');
      update festival_ops.vouchers set token_hash=extensions.digest(token,'sha256'),token_expires_at=least(now()+interval '90 seconds',expires_at) where id=v.id;
      result := jsonb_build_object('token',token,'expiresAt',least(now()+interval '90 seconds',v.expires_at));
    elsif p_action='voucher_redeem' then
      token := p_payload->>'token';
      if token is null or token !~ '^fv1\.[0-9a-f]{64}$' then raise exception 'VOUCHER_INVALID'; end if;
      select * into v from festival_ops.vouchers where event_id=e.id and token_hash=extensions.digest(token,'sha256') for update;
      if v.id is null then raise exception 'VOUCHER_INVALID'; end if;
      if v.state='used' then raise exception 'VOUCHER_USED'; end if;
      if v.state='void' then raise exception 'VOUCHER_VOID'; end if;
      if v.expires_at<=now() or v.token_expires_at<=now() then raise exception 'VOUCHER_EXPIRED'; end if;
      update festival_ops.vouchers set state='used',redeemed_at=now(),redeemed_by=u where id=v.id;
      result := jsonb_build_object('id',v.id,'title',v.title,'result','REDEEMED');
    elsif p_action='voucher_void' then
      if coalesce(length(why),0) not between 3 and 300 then raise exception 'INVALID_INPUT'; end if;
      select * into v from festival_ops.vouchers where event_id=e.id and id=(p_payload->>'id')::uuid for update;
      if v.id is null then raise exception 'NOT_FOUND'; end if;
      if v.state<>'available' then raise exception 'VOUCHER_USED'; end if;
      update festival_ops.vouchers set state='void',token_hash=null,token_expires_at=null where id=v.id;
      result := jsonb_build_object('saved',true);
    end if;
  end if;
  insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e.id,u,p_action,coalesce(target::text,vkey,vid::text,v.id::text),why);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $function$;

-- public.festival_student_lookup(p_payload jsonb)
CREATE OR REPLACE FUNCTION public.festival_student_lookup(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        'points',p.money)
        || (festival_ops.identity_state(e,p.id) - 'boothKeys') order by p.id=chosen desc,p.name)
      from public.users p join auth.users a on a.id=p.auth_user_id where festival_ops.student_number_of(e,p.id)=sid),'[]'::jsonb));
end $function$;

notify pgrst, 'reload schema';
commit;

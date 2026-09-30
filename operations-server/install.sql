-- Additive draft. Apply only after explicit approval and isolated verification.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create schema festival_ops;
revoke all on schema festival_ops from public, anon, authenticated;

create table festival_ops.events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  current boolean not null default true,
  state text not null default 'preparing' check (state in ('preparing','open','paused','closed')),
  review_points integer not null default 0 check (review_points between 0 and 1000),
  version integer not null default 1,
  created_at timestamptz not null default now()
);
create unique index one_current_event on festival_ops.events(current) where current;
create table festival_ops.booths (
  event_id uuid not null references festival_ops.events(id),
  key text not null check (length(key) between 1 and 120),
  legacy_key public.booth_enum,
  name text not null check (length(btrim(name)) between 1 and 100),
  location text not null default '' check (length(location) <= 200),
  description text not null default '' check (length(description) <= 2000),
  floor integer not null default 1 check (floor between 1 and 4),
  status text not null default 'paused' check (status in ('open','paused','closed')),
  version integer not null default 1,
  primary key(event_id,key), unique(event_id,legacy_key)
);
create table festival_ops.visits (
  event_id uuid not null,
  user_id integer not null references public.users(id),
  booth_key text not null,
  method text not null check (method in ('nfc','manual')),
  actor_id integer not null references public.users(id),
  reason text,
  created_at timestamptz not null default now(),
  primary key(event_id,user_id,booth_key),
  foreign key(event_id,booth_key) references festival_ops.booths(event_id,key),
  check (method <> 'manual' or length(btrim(reason)) between 3 and 300)
);
create index visits_booth_time on festival_ops.visits(event_id,booth_key,created_at desc);
create index visits_user on festival_ops.visits(user_id);
create table festival_ops.reviews (
  event_id uuid not null, user_id integer not null, booth_key text not null,
  rating integer not null check (rating between 1 and 5),
  content text not null default '' check (length(content) <= 500),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(event_id,user_id,booth_key),
  foreign key(event_id,user_id,booth_key) references festival_ops.visits(event_id,user_id,booth_key)
);
create index reviews_booth on festival_ops.reviews(event_id,booth_key,created_at desc);
create table festival_ops.ledger (
  id bigint generated always as identity primary key,
  event_id uuid not null references festival_ops.events(id),
  user_id integer not null references public.users(id),
  delta integer not null check (delta <> 0 and delta between -100000 and 100000),
  source_key text not null, actor_id integer not null references public.users(id),
  reason text not null check (length(btrim(reason)) between 3 and 300),
  created_at timestamptz not null default now(),
  unique(event_id,user_id,source_key)
);
create index ledger_user on festival_ops.ledger(user_id,event_id,id desc);
create table festival_ops.rules (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references festival_ops.events(id),
  title text not null check (length(btrim(title)) between 1 and 100),
  target integer not null check (target between 1 and 500),
  stock integer not null check (stock between 0 and 100000),
  enabled boolean not null default false,
  expires_at timestamptz not null,
  version integer not null default 1,
  unique(event_id,id)
);
create table festival_ops.vouchers (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null, rule_id uuid not null,
  user_id integer not null references public.users(id),
  title text not null, expires_at timestamptz not null,
  state text not null default 'available' check (state in ('available','used','void')),
  created_at timestamptz not null default now(),
  redeemed_at timestamptz, redeemed_by integer references public.users(id),
  token_hash bytea, token_expires_at timestamptz,
  unique(event_id,user_id,rule_id),
  foreign key(event_id,rule_id) references festival_ops.rules(event_id,id)
);
create index vouchers_rule on festival_ops.vouchers(rule_id,state);
create index vouchers_user on festival_ops.vouchers(user_id,event_id,created_at desc);
create unique index vouchers_token on festival_ops.vouchers(token_hash) where token_hash is not null;
create table festival_ops.requests (
  actor_id integer not null references public.users(id), request_id uuid not null,
  fingerprint bytea not null, response jsonb not null,
  created_at timestamptz not null default now(), primary key(actor_id,request_id)
);
create table festival_ops.audit (
  id bigint generated always as identity primary key,
  event_id uuid references festival_ops.events(id),
  actor_id integer not null references public.users(id),
  action text not null, target text, reason text,
  created_at timestamptz not null default now()
);
create index audit_event_time on festival_ops.audit(event_id,id desc);

-- New tables never accept direct browser reads or writes. Only guarded RPCs can use them.
do $$ declare t text; begin
  foreach t in array array['events','booths','visits','reviews','ledger','rules','vouchers','requests','audit'] loop
    execute format('alter table festival_ops.%I enable row level security',t);
    execute format('revoke all on festival_ops.%I from public,anon,authenticated',t);
  end loop;
end $$;
revoke all on all sequences in schema festival_ops from public,anon,authenticated;

create function festival_ops.review_summary(e uuid, u integer, b text) returns jsonb
language sql set search_path = '' as $$
 select jsonb_build_object('boothKey',b,'count',count(*),'average',round(avg(rating),1),
   'myRating',max(rating) filter(where user_id=u),'reviews',
   coalesce((select jsonb_agg(x.item order by x.ts desc) from (
     select r.created_at ts, jsonb_build_object('rating',r.rating,'content',nullif(r.content,''),
       'createdAt',r.created_at,'mine',r.user_id=u,'author','참여자') item
     from festival_ops.reviews r where r.event_id=e and r.booth_key=b
     order by r.created_at desc limit 50) x),'[]'::jsonb))
 from festival_ops.reviews where event_id=e and booth_key=b;
$$;

create function public.festival_ops_read(p_kind text,p_query jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
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
  q := left(coalesce(p_query->>'search',''),100);
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
      select a.id,a.name,(select count(*) from festival_ops.visits v where v.user_id=a.id and v.event_id=e.id) visits,
        (select coalesce(sum(delta),0) from festival_ops.ledger l where l.user_id=a.id and l.event_id=e.id) points
      from public.users a where a.auth_user_id is not null and (q='' or a.name ilike '%'||q||'%' or a.id::text=q)
      order by a.id limit 50 offset offn) x;
  elsif p_kind='visits' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select v.*,a.name from festival_ops.visits v join public.users a on a.id=v.user_id
      where v.event_id=e.id and (q='' or v.booth_key=q or v.user_id::text=q) order by v.created_at desc limit 50 offset offn) x;
  elsif p_kind='ledger' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select l.*,a.name from festival_ops.ledger l join public.users a on a.id=l.user_id
      where l.event_id=e.id and (q='' or l.user_id::text=q) order by l.id desc limit 50 offset offn) x;
  elsif p_kind='rules' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select r.*,(select count(*) from festival_ops.vouchers v where v.rule_id=r.id) issued
      from festival_ops.rules r where r.event_id=e.id order by r.target,r.id) x;
  elsif p_kind='vouchers' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select v.id,v.user_id,a.name,v.title,v.state,v.created_at,v.expires_at,v.redeemed_at
      from festival_ops.vouchers v join public.users a on a.id=v.user_id where v.event_id=e.id
      and (q='' or v.user_id::text=q or v.id::text=q) order by v.created_at desc limit 50 offset offn) x;
  elsif p_kind='audit' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
      select * from festival_ops.audit where event_id=e.id order by id desc limit 50 offset offn) x;
  end if;
  return jsonb_build_object('ready',true,'event',to_jsonb(e),'items',result,'offset',offn);
end $$;

create function festival_ops.award(e uuid,u integer,r uuid,a integer) returns uuid
language plpgsql set search_path = '' as $$
declare rule festival_ops.rules; v uuid;
begin
  select id into v from festival_ops.vouchers where event_id=e and user_id=u and rule_id=r;
  if v is not null then return v; end if;
  select * into rule from festival_ops.rules where event_id=e and id=r for update;
  if rule.id is null or not rule.enabled or rule.expires_at<=now() then raise exception 'NOT_FOUND'; end if;
  if (select count(*) from festival_ops.vouchers where rule_id=r)>=rule.stock then raise exception 'OUT_OF_STOCK'; end if;
  insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at) values(e,r,u,rule.title,rule.expires_at) returning id into v;
  insert into festival_ops.audit(event_id,actor_id,action,target) values(e,a,'voucher_issue',v::text);
  return v;
end $$;

create function public.festival_ops_write(p_action text,p_payload jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
      if target=u then raise exception 'SELF_ADJUSTMENT'; end if;
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
      if target=u then raise exception 'SELF_ADJUSTMENT'; end if;
      if not exists(select 1 from public.users where id=target and auth_user_id is not null) then raise exception 'NOT_FOUND'; end if;
      if delta is null or delta=0 or delta not between -100000 and 100000 or coalesce(length(why),0) not between 3 and 300 then raise exception 'INVALID_INPUT'; end if;
      if (select coalesce(sum(l.delta),0) from festival_ops.ledger l where event_id=e.id and user_id=target)+delta<0 then raise exception 'POINTS_INSUFFICIENT'; end if;
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
      if p_action='voucher_issue' and (target=u or coalesce(length(why),0) not between 3 and 300) then raise exception 'INVALID_INPUT'; end if;
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
      if v.user_id=u then raise exception 'SELF_REDEMPTION'; end if;
      if v.state='used' then raise exception 'VOUCHER_USED'; end if;
      if v.state='void' then raise exception 'VOUCHER_VOID'; end if;
      if v.expires_at<=now() or v.token_expires_at<=now() then raise exception 'VOUCHER_EXPIRED'; end if;
      update festival_ops.vouchers set state='used',redeemed_at=now(),redeemed_by=u where id=v.id;
      result := jsonb_build_object('id',v.id,'title',v.title,'result','REDEEMED');
    elsif p_action='voucher_void' then
      if coalesce(length(why),0) not between 3 and 300 then raise exception 'INVALID_INPUT'; end if;
      select * into v from festival_ops.vouchers where event_id=e.id and id=(p_payload->>'id')::uuid for update;
      if v.id is null then raise exception 'NOT_FOUND'; end if;
      if v.user_id=u then raise exception 'SELF_ADJUSTMENT'; end if;
      if v.state<>'available' then raise exception 'VOUCHER_USED'; end if;
      update festival_ops.vouchers set state='void',token_hash=null,token_expires_at=null where id=v.id;
      result := jsonb_build_object('saved',true);
    end if;
  end if;
  insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e.id,u,p_action,coalesce(target::text,vkey,vid::text,v.id::text),why);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;
revoke all on all functions in schema festival_ops from public,anon,authenticated;
revoke all on function public.festival_ops_read(text,jsonb), public.festival_ops_write(text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.festival_ops_read(text,jsonb), public.festival_ops_write(text,jsonb,uuid) to authenticated;
notify pgrst,'reload schema';
commit;

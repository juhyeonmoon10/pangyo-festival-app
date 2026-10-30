-- Approved 2026-10-30: (1) an operator may redeem an own voucher; (2) booth review summaries
-- include the exact 1-5 star distribution of every review, not only the latest 50 shown.
-- Apply after voucher-short-code.sql. No table or data change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create or replace function festival_ops.review_summary(e uuid,u integer,b text) returns jsonb
language sql set search_path = '' as $$
 select jsonb_build_object('boothKey',b,'count',count(*),'average',round(avg(rating),1),
   'reviewPolicy',festival_ops.review_policy(e,u,b),
   'distribution',jsonb_build_object('5',count(*) filter(where rating=5),'4',count(*) filter(where rating=4),
     '3',count(*) filter(where rating=3),'2',count(*) filter(where rating=2),'1',count(*) filter(where rating=1)),
   'myRating',max(rating) filter(where user_id=u),'reviews',
   coalesce((select jsonb_agg(x.item order by x.ts desc) from (
     select r.created_at ts,jsonb_build_object('rating',r.rating,'content',nullif(r.content,''),
       'createdAt',r.created_at,'mine',r.user_id=u,'author',coalesce(r.author_name,'참여자')) item
     from festival_ops.reviews r where r.event_id=e and r.booth_key=b
     order by r.created_at desc limit 50) x),'[]'::jsonb))
 from festival_ops.reviews where event_id=e and booth_key=b;
$$;

-- Operator: check or redeem by code. Accepts the previous, current and next 30-second step.
-- An operator may now confirm an own voucher; every redemption keeps its actor in the audit log.
create or replace function public.festival_voucher_redeem(p_action text,p_payload jsonb,p_request_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e festival_ops.events; code text; s bigint; v festival_ops.vouchers; matches integer;
  old festival_ops.requests; fp bytea; result jsonb; owner_name text;
begin
  if p_action is null or p_action not in ('check','redeem') or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or length(p_payload::text)>200 or (p_action='redeem' and p_request_id is null) then raise exception 'INVALID_INPUT'; end if;
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  code:=upper(regexp_replace(coalesce(p_payload->>'code',''),'[\s-]','','g'));
  if code !~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$' then raise exception 'VOUCHER_INVALID'; end if;
  if p_action='redeem' then
    perform pg_catalog.pg_advisory_xact_lock(170926,1);
    fp:=extensions.digest('voucher_code_redeem:'||code,'sha256');
    select * into old from festival_ops.requests where actor_id=u and request_id=p_request_id;
    if found then
      if old.fingerprint<>fp then raise exception 'REQUEST_CONFLICT'; end if;
      return old.response;
    end if;
  end if;
  select * into e from festival_ops.events where current;
  if e.id is null then raise exception 'OPS_NOT_READY'; end if;
  s:=festival_ops.voucher_step();
  select count(*) into matches from festival_ops.vouchers x where x.event_id=e.id and x.code_secret is not null
    and exists(select 1 from generate_series(-1,1) d where festival_ops.voucher_code(x.code_secret,s+d)=code);
  -- A 40-bit collision between live vouchers is treated as invalid rather than guessed.
  if matches<>1 then raise exception 'VOUCHER_INVALID'; end if;
  select * into v from festival_ops.vouchers x where x.event_id=e.id and x.code_secret is not null
    and exists(select 1 from generate_series(-1,1) d where festival_ops.voucher_code(x.code_secret,s+d)=code) for update;
  select name into owner_name from public.users where id=v.user_id;
  if p_action='check' then
    return jsonb_build_object('valid',v.state='available' and v.expires_at>now() and e.state='open',
      'state',case when v.state<>'available' then v.state when v.expires_at<=now() then 'expired' else 'available' end,
      'title',v.title,'participant',owner_name,'own',v.user_id=u,'eventOpen',e.state='open');
  end if;
  if v.state='used' then raise exception 'VOUCHER_USED'; end if;
  if v.state='void' then raise exception 'VOUCHER_VOID'; end if;
  if v.expires_at<=now() then raise exception 'VOUCHER_EXPIRED'; end if;
  if e.state<>'open' then raise exception 'EVENT_CLOSED'; end if;
  update festival_ops.vouchers set state='used',redeemed_at=now(),redeemed_by=u where id=v.id;
  result:=jsonb_build_object('id',v.id,'title',v.title,'participant',owner_name,'result','REDEEMED','own',v.user_id=u);
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(e.id,u,'voucher_redeem',v.id::text,case when v.user_id=u then 'Own voucher' end);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;

notify pgrst,'reload schema';
commit;

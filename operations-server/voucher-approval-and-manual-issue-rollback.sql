-- Rollback for voucher-approval-and-manual-issue.sql: one manual voucher per student and rule again,
-- stock checked again, and the approval result without studentNumber/redeemedAt.
-- Vouchers issued so far stay. If a student already holds two manual vouchers of one rule, the old
-- unique index cannot be rebuilt: void or remove the extra ones first (this script then fails safely).
begin;
select pg_catalog.pg_advisory_xact_lock(170926,1);
CREATE OR REPLACE FUNCTION festival_ops.award(e uuid, u integer, r uuid, a integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare rule festival_ops.rules; v uuid; first_stage integer;
  manual boolean := coalesce(current_setting('festival.manual_voucher', true), '') = 'on';
begin
  select * into rule from festival_ops.rules where event_id=e and id=r for update;
  if rule.reward_kind is not null and not manual then
    -- Automatic/old/manual generic claim paths can only deliver the SECOND benefit.
    -- Only reward_choose is allowed to create the first-choice record.
    for first_stage in select x.reward_stage from festival_ops.vouchers x join festival_ops.rules r on r.id=x.rule_id
      where x.event_id=e and x.user_id=u and x.reward_stage=3 and r.reward_kind<>rule.reward_kind loop
      v:=festival_ops.award_choice(e,u,rule.reward_kind,a,false,first_stage);
    end loop;
    return v;
  end if;
  select id into v from festival_ops.vouchers where event_id=e and user_id=u and rule_id=r and reward_stage is null;
  if v is not null then
    if manual then raise exception 'VOUCHER_ALREADY_ISSUED'; end if;
    return v;
  end if;
  if rule.id is null or not rule.enabled or rule.expires_at<=now() then raise exception 'NOT_FOUND'; end if;
  if (select count(*) from festival_ops.vouchers where rule_id=r)>=rule.stock then raise exception 'OUT_OF_STOCK'; end if;
  insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at) values(e,r,u,rule.title,rule.expires_at) returning id into v;
  insert into festival_ops.audit(event_id,actor_id,action,target) values(e,a,'voucher_issue',v::text);
  return v;
end $function$;

create or replace function public.festival_voucher_redeem(p_action text,p_payload jsonb,p_request_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; admin boolean; kinds text[]; kind text; e festival_ops.events; code text; s bigint;
  v festival_ops.vouchers; matches integer; old festival_ops.requests; fp bytea; result jsonb; owner_name text;
begin
  if p_action is null or p_action not in ('status','check','redeem') or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or length(p_payload::text)>200 or (p_action='redeem' and p_request_id is null) then raise exception 'INVALID_INPUT'; end if;
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  admin:=coalesce((me->>'isAdmin')::boolean,false);
  select * into e from festival_ops.events where current;
  if not admin then
    kinds:=case when coalesce((me->>'needsProfile')::boolean,true) or e.id is null then '{}'::text[] else festival_ops.voucher_kinds(e.id,u) end;
  end if;
  if p_action='status' then
    return jsonb_build_object('isAdmin',admin,'kinds',to_jsonb(case when admin then array['food','photo'] else kinds end));
  end if;
  if not admin and cardinality(kinds)=0 then raise exception 'VOUCHER_MANAGER_REQUIRED'; end if;
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
    select * into e from festival_ops.events where current;
  end if;
  if e.id is null then raise exception 'OPS_NOT_READY'; end if;
  s:=festival_ops.voucher_step();
  select count(*) into matches from festival_ops.vouchers x where x.event_id=e.id and x.code_secret is not null
    and exists(select 1 from generate_series(-1,1) d where festival_ops.voucher_code(x.code_secret,s+d)=code);
  -- A 40-bit collision between live vouchers is treated as invalid rather than guessed.
  if matches<>1 then raise exception 'VOUCHER_INVALID'; end if;
  select * into v from festival_ops.vouchers x where x.event_id=e.id and x.code_secret is not null
    and exists(select 1 from generate_series(-1,1) d where festival_ops.voucher_code(x.code_secret,s+d)=code) for update;
  select r.reward_kind into kind from festival_ops.rules r where r.id=v.rule_id;
  -- A manager learns nothing about a voucher outside their kinds, and never confirms their own.
  if not admin then
    if kind is null or not kind=any(kinds) then raise exception 'VOUCHER_KIND_NOT_ALLOWED'; end if;
    if v.user_id=u then raise exception 'SELF_REDEMPTION'; end if;
  end if;
  select name into owner_name from public.users where id=v.user_id;
  if p_action='check' then
    return jsonb_build_object('valid',v.state='available' and v.expires_at>now() and e.state='open',
      'state',case when v.state<>'available' then v.state when v.expires_at<=now() then 'expired' else 'available' end,
      'title',v.title,'kind',kind,'participant',owner_name,'own',v.user_id=u,'eventOpen',e.state='open');
  end if;
  if v.state='used' then raise exception 'VOUCHER_USED'; end if;
  if v.state='void' then raise exception 'VOUCHER_VOID'; end if;
  if v.expires_at<=now() then raise exception 'VOUCHER_EXPIRED'; end if;
  if e.state<>'open' then raise exception 'EVENT_CLOSED'; end if;
  update festival_ops.vouchers set state='used',redeemed_at=now(),redeemed_by=u where id=v.id;
  result:=jsonb_build_object('id',v.id,'title',v.title,'kind',kind,'participant',owner_name,'result','REDEEMED','own',v.user_id=u);
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(e.id,u,case when admin then 'voucher_redeem' else 'voucher_manager_redeem' end,v.id::text,
      case when v.user_id=u then 'Own voucher' when not admin then kind end);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;
revoke all on function public.festival_voucher_redeem(text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.festival_voucher_redeem(text,jsonb,uuid) to authenticated;

drop index if exists festival_ops.legacy_voucher_per_rule;
create unique index legacy_voucher_per_rule on festival_ops.vouchers(event_id,user_id,rule_id) where reward_stage is null;
alter table festival_ops.vouchers drop column if exists manual_issue;
notify pgrst,'reload schema';
commit;

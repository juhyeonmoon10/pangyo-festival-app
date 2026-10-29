-- Approved 2026-10-30: existing tables only; visit-based recurring rewards.
-- No stock/expiry has been agreed. Installation disables legacy issuance and does
-- not create enabled benefit rules. Operators must explicitly configure/enable.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);
alter table festival_ops.rules add column reward_kind text check(reward_kind in ('photo','food'));
create unique index reward_kind_per_event on festival_ops.rules(event_id,reward_kind) where reward_kind is not null;
alter table festival_ops.rules add constraint reward_rule_fixed_target check(reward_kind is null or target=3);
alter table festival_ops.vouchers add column reward_stage integer check(reward_stage>0 and reward_stage%3=0);
-- Preserve old one-per-rule uniqueness only for untyped historical vouchers.
alter table festival_ops.vouchers drop constraint vouchers_event_id_user_id_rule_id_key;
create unique index legacy_voucher_per_rule on festival_ops.vouchers(event_id,user_id,rule_id) where reward_stage is null;
create unique index reward_stage_per_user on festival_ops.vouchers(event_id,user_id,reward_stage) where reward_stage is not null;

create function festival_ops.reward_target(e uuid,u integer) returns integer
language sql set search_path='' as $$
 select min(g)::integer from generate_series(3,((select count(*)::integer from festival_ops.visits where event_id=e and user_id=u)/6)*6+3,6) g
 where not exists(select 1 from festival_ops.vouchers where event_id=e and user_id=u and reward_stage=g)
    or not exists(select 1 from festival_ops.vouchers where event_id=e and user_id=u and reward_stage=g+3);
$$;

create function festival_ops.reward_status(e uuid,u integer,admin boolean default false) returns jsonb
language sql set search_path='' as $$
 with stage as (select festival_ops.reward_target(e,u) target)
 select jsonb_build_object('version',2,'eventId',e,'firstTarget',stage.target,'secondTarget',stage.target+3,
   'issuedCount',(select count(*) from festival_ops.vouchers where event_id=e and user_id=u and reward_stage is not null),
   'ready',(select count(*)=2 and coalesce(bool_and(enabled and expires_at>now()),false) from festival_ops.rules where event_id=e and reward_kind is not null),
   'count',(select count(*) from festival_ops.visits where event_id=e and user_id=u),
   'firstChoice',(select r.reward_kind from festival_ops.vouchers v join festival_ops.rules r on r.id=v.rule_id where v.event_id=e and v.user_id=u and v.reward_stage=stage.target),
   'secondIssued',exists(select 1 from festival_ops.vouchers where event_id=e and user_id=u and reward_stage=stage.target+3),
   'canChoose',(select count(*)=2 and coalesce(bool_and(enabled and expires_at>now()),false) from festival_ops.rules where event_id=e and reward_kind is not null) and exists(select 1 from festival_ops.events where id=e and current and state='open') and (select count(*)>=stage.target from festival_ops.visits where event_id=e and user_id=u),
   'options',coalesce((select jsonb_agg(jsonb_build_object('kind',r.reward_kind,'title',r.title,'ruleId',r.id,
     'available',r.enabled and r.expires_at>now() and (select state='open' from festival_ops.events where id=e)
       and (select count(*) from festival_ops.vouchers where rule_id=r.id)<r.stock)
       || case when admin then jsonb_build_object('stock',r.stock,'version',r.version,'expiresAt',r.expires_at) else '{}'::jsonb end
     order by r.reward_kind desc) from festival_ops.rules r where r.event_id=e and r.reward_kind is not null),'[]'::jsonb)) from stage;
$$;

create function public.festival_reward_read() returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; e uuid;
begin
  me:=festival_nfc_private.current_profile();
  select id into e from festival_ops.events where current;
  return festival_ops.reward_status(e,(me->>'id')::integer,coalesce((me->>'isAdmin')::boolean,false));
end $$;

create function festival_ops.award_choice(e uuid,u integer,kind text,a integer,first_allowed boolean default false,first_target integer default 3) returns uuid
language plpgsql set search_path='' as $$
declare rule festival_ops.rules; first_kind text; n integer; stage integer; v uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  if first_target is null or first_target<3 or first_target%6<>3 then return null; end if;
  if not exists(select 1 from festival_ops.events where id=e and current and state='open') then return null; end if;
  select * into rule from festival_ops.rules where event_id=e and reward_kind=kind for update;
  if rule.id is null then return null; end if;
  select r.reward_kind into first_kind from festival_ops.vouchers x join festival_ops.rules r on r.id=x.rule_id
    where x.event_id=e and x.user_id=u and x.reward_stage=first_target;
  select count(*) into n from festival_ops.visits where event_id=e and user_id=u;
  if first_kind is null then
    if not first_allowed or n<first_target or festival_ops.reward_target(e,u)<>first_target then return null; end if;
    stage:=first_target;
  else
    if first_kind=kind then
      select id into v from festival_ops.vouchers where event_id=e and user_id=u and reward_stage=first_target;
      return v;
    end if;
    if n<first_target+3 then return null; end if;
    stage:=first_target+3;
  end if;
  select id into v from festival_ops.vouchers where event_id=e and user_id=u and reward_stage=stage;
  if v is not null then return v; end if;
  if (select count(*) from festival_ops.rules where event_id=e and reward_kind is not null and enabled and expires_at>now())<>2 then return null; end if;
  if not rule.enabled or rule.expires_at<=now() or (select count(*) from festival_ops.vouchers where rule_id=rule.id)>=rule.stock then return null; end if;
  insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at,reward_stage)
    values(e,rule.id,u,rule.title,rule.expires_at,stage) returning id into v;
  insert into festival_ops.audit(event_id,actor_id,action,target) values(e,a,'reward_issue_'||stage::text,v::text);
  return v;
end $$;

create or replace function festival_ops.award(e uuid,u integer,r uuid,a integer) returns uuid
language plpgsql set search_path='' as $$
declare rule festival_ops.rules; v uuid; first_stage integer;
begin
  select * into rule from festival_ops.rules where event_id=e and id=r for update;
  if rule.reward_kind is not null then
    -- Automatic/old/manual generic claim paths can only deliver the SECOND benefit.
    -- Only reward_choose is allowed to create the first-choice record.
    for first_stage in select x.reward_stage from festival_ops.vouchers x join festival_ops.rules r on r.id=x.rule_id
      where x.event_id=e and x.user_id=u and x.reward_stage%6=3 and r.reward_kind<>rule.reward_kind loop
      v:=festival_ops.award_choice(e,u,rule.reward_kind,a,false,first_stage);
    end loop;
    return v;
  end if;
  select id into v from festival_ops.vouchers where event_id=e and user_id=u and rule_id=r and reward_stage is null;
  if v is not null then return v; end if;
  if rule.id is null or not rule.enabled or rule.expires_at<=now() then raise exception 'NOT_FOUND'; end if;
  if (select count(*) from festival_ops.vouchers where rule_id=r)>=rule.stock then raise exception 'OUT_OF_STOCK'; end if;
  insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at) values(e,r,u,rule.title,rule.expires_at) returning id into v;
  insert into festival_ops.audit(event_id,actor_id,action,target) values(e,a,'voucher_issue',v::text);
  return v;
end $$;

create function public.festival_reward_write(p_action text,p_payload jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; admin boolean; e uuid; old festival_ops.requests; fp bytea; result jsonb;
  kind text; first_kind text; first_id uuid; first_target integer; n integer; rule festival_ops.rules; stock integer; expected integer; expiry timestamptz;
begin
  if p_action is null or p_action not in ('reward_choose','reward_config') or p_request_id is null
    or p_payload is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>2000 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me:=festival_nfc_private.current_profile();u:=(me->>'id')::integer;admin:=coalesce((me->>'isAdmin')::boolean,false);
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if p_action='reward_config' and not admin then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current for update;
  if e is null or (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
  fp:=extensions.digest(p_action||':'||p_payload::text,'sha256');
  select * into old from festival_ops.requests where actor_id=u and request_id=p_request_id;
  if found then
    if old.fingerprint<>fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  if p_action='reward_config' then
    if exists(select 1 from festival_ops.vouchers v join festival_ops.rules r on r.id=v.rule_id where v.event_id=e and r.reward_kind is null) then
      raise exception 'REWARD_MIGRATION_REQUIRED'; end if;
    expiry:=(p_payload->>'expiresAt')::timestamptz;
    if expiry is null or expiry<=now() then raise exception 'INVALID_INPUT'; end if;
    foreach kind in array array['photo','food'] loop
      select * into rule from festival_ops.rules where event_id=e and reward_kind=kind for update;
      stock:=(p_payload->>(kind||'Stock'))::integer;expected:=(p_payload->>(kind||'Version'))::integer;
      if expected is distinct from coalesce(rule.version,0) then raise exception 'VERSION_CONFLICT'; end if;
      if stock is null or stock not between 0 and 100000 or stock<(select count(*) from festival_ops.vouchers where rule_id=rule.id) then raise exception 'INVALID_INPUT'; end if;
      insert into festival_ops.rules(id,event_id,title,target,stock,enabled,expires_at,reward_kind)
        values(coalesce(rule.id,gen_random_uuid()),e,case kind when 'photo' then '포토부스 이용권' else '푸드트럭 교환권' end,3,stock,coalesce((p_payload->>'enabled')::boolean,false),expiry,kind)
      on conflict(id) do update set stock=excluded.stock,expires_at=excluded.expires_at,enabled=excluded.enabled,version=festival_ops.rules.version+1;
    end loop;
    update festival_ops.rules set enabled=false,version=version+1 where event_id=e and reward_kind is null and enabled;
  else
    if not exists(select 1 from festival_ops.events where id=e and state='open') then raise exception 'EVENT_CLOSED'; end if;
    kind:=p_payload->>'kind';
    if kind is null or kind not in ('photo','food') then raise exception 'INVALID_INPUT'; end if;
    first_target:=(p_payload->>'firstTarget')::integer;
    if first_target is null or first_target<3 or first_target%6<>3 or first_target>2147483644 then raise exception 'INVALID_INPUT'; end if;
    if (select count(*) from festival_ops.rules where event_id=e and reward_kind is not null and enabled and expires_at>now())<>2 then raise exception 'REWARD_NOT_READY'; end if;
    select count(*) into n from festival_ops.visits where event_id=e and user_id=u;
    if n<first_target then raise exception 'VISIT_REQUIRED'; end if;
    select r.reward_kind into first_kind from festival_ops.vouchers v join festival_ops.rules r on r.id=v.rule_id
      where v.event_id=e and v.user_id=u and v.reward_stage=first_target;
    if first_kind is not null and first_kind<>kind then raise exception 'REWARD_CHOICE_LOCKED'; end if;
    if first_kind is null and festival_ops.reward_target(e,u)<>first_target then raise exception 'REWARD_ORDER_REQUIRED'; end if;
    first_id:=festival_ops.award_choice(e,u,kind,u,true,first_target);
    if first_id is null then raise exception 'OUT_OF_STOCK'; end if;
    if n>=first_target+3 then perform festival_ops.award_choice(e,u,case kind when 'photo' then 'food' else 'photo' end,u,false,first_target); end if;
  end if;
  result:=festival_ops.reward_status(e,u,admin);
  insert into festival_ops.audit(event_id,actor_id,action,target) values(e,u,p_action,kind);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;
revoke all on function festival_ops.reward_status(uuid,integer,boolean),festival_ops.reward_target(uuid,integer),festival_ops.award_choice(uuid,integer,text,integer,boolean,integer) from public,anon,authenticated;
revoke all on function public.festival_reward_read(),public.festival_reward_write(text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.festival_reward_read(),public.festival_reward_write(text,jsonb,uuid) to authenticated;

-- Both NFC and manual approvals insert into the same unique visit ledger.
create function festival_ops.reward_after_visit() returns trigger
language plpgsql set search_path='' as $$
declare r uuid;
begin
  for r in select id from festival_ops.rules where event_id=new.event_id and reward_kind is not null and enabled loop
    perform festival_ops.award(new.event_id,new.user_id,r,new.actor_id);
  end loop;
  return new;
end $$;
create trigger reward_after_visit after insert on festival_ops.visits
for each row execute function festival_ops.reward_after_visit();
revoke all on function festival_ops.reward_after_visit() from public,anon,authenticated;

-- Preserve historical vouchers, ledger, visits and reviews. Stop old issuance.
update festival_ops.rules set enabled=false,version=version+1
where enabled and event_id in (select id from festival_ops.events where current);

notify pgrst,'reload schema';
commit;

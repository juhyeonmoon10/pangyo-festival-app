-- LOCAL DRAFT ONLY. Do not run on the shared Supabase project without a new, separate approval.
--
-- Policy (user-confirmed 2026-10-28): a voucher is granted at every 3 completed stamps
-- (3, 6, 9, 12, ...). At EVERY stage the student explicitly chooses one of the two kinds
-- (photo booth / food truck). The same kind may be chosen at several stages.
-- A completed stamp keeps its existing meaning: one review row per verified visit.
--
-- This file is an ALTERNATIVE to operations-server/reward-choice.draft.sql (v1: 3 choose / 6 opposite, max 2;
-- v2 by another worker 2026-10-27 16:14 UTC: choose at 3/9/15, opposite at 6/12/18). Same columns/indexes.
-- Apply this file INSTEAD of that one, never both. It refuses to run if that draft was applied.
--
-- Changes to existing private objects (operations-server/install.sql is already applied):
--   1. festival_ops.rules    + reward_kind column, one typed rule per kind per event, target fixed to 3.
--   2. festival_ops.vouchers + reward_stage column (3, 6, 9, ...).
--   3. festival_ops.vouchers: the table-level unique(event_id,user_id,rule_id) constraint is replaced by
--        - a partial unique index with the same columns for UNTYPED vouchers (old behaviour unchanged), and
--        - a partial unique index (event_id,user_id,reward_stage) for typed vouchers.
--      Without step 3 a second photo voucher (e.g. stage 3 and stage 9) would violate the old constraint.
--   4. festival_ops.award() replaced: typed rules are never issued automatically, by voucher_claim
--      or by manual voucher_issue. Only festival_reward_write('reward_choose') creates them.
-- No new table. No row is deleted, converted or re-dated. Used/expired/voided vouchers keep their stage.
--
-- Rollback (before any typed voucher exists): see the ROLLBACK block at the end of this file.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$
begin
  if exists(select 1 from information_schema.columns where table_schema='festival_ops' and table_name='rules' and column_name='reward_kind')
    or exists(select 1 from information_schema.columns where table_schema='festival_ops' and table_name='vouchers' and column_name='reward_stage') then
    raise exception 'REWARD_DRAFT_ALREADY_APPLIED: a reward draft was applied before; write a dedicated migration instead';
  end if;
end $$;

alter table festival_ops.rules add column reward_kind text check(reward_kind in ('photo','food'));
create unique index reward_kind_per_event on festival_ops.rules(event_id,reward_kind) where reward_kind is not null;
alter table festival_ops.rules add constraint reward_rule_fixed_target check(reward_kind is null or target=3);

alter table festival_ops.vouchers add column reward_stage integer check(reward_stage is null or (reward_stage>=3 and reward_stage%3=0));
create unique index reward_stage_per_user on festival_ops.vouchers(event_id,user_id,reward_stage) where reward_stage is not null;
create unique index vouchers_untyped_once on festival_ops.vouchers(event_id,user_id,rule_id) where reward_stage is null;
create index vouchers_rule_count on festival_ops.vouchers(rule_id);

-- Drop exactly the original unique(event_id,user_id,rule_id). Abort if it cannot be identified.
do $$
declare names text[];
begin
  select array_agg(c.conname) into names
    from pg_catalog.pg_constraint c
   where c.conrelid='festival_ops.vouchers'::regclass and c.contype='u'
     and (select array_agg(a.attname::text order by a.attname) from pg_catalog.pg_attribute a
           where a.attrelid=c.conrelid and a.attnum=any(c.conkey)) = array['event_id','rule_id','user_id'];
  if coalesce(array_length(names,1),0)<>1 then raise exception 'VOUCHER_UNIQUE_CONSTRAINT_NOT_FOUND'; end if;
  execute format('alter table festival_ops.vouchers drop constraint %I',names[1]);
end $$;

-- Lowest stage (multiple of 3) that has no typed voucher yet for this user/event.
create function festival_ops.reward_next_stage(e uuid,u integer) returns integer
language sql stable set search_path='' as $$
  select min(s) from pg_catalog.generate_series(3,
      greatest(3,(select coalesce(max(reward_stage),0)+3 from festival_ops.vouchers where event_id=e and user_id=u)),3) s
   where not exists(select 1 from festival_ops.vouchers v where v.event_id=e and v.user_id=u and v.reward_stage=s);
$$;

create function festival_ops.reward_status(e uuid,u integer,admin boolean default false) returns jsonb
language sql set search_path='' as $$
 with c as (select count(*)::integer n from festival_ops.reviews where event_id=e and user_id=u),
      nx as (select festival_ops.reward_next_stage(e,u) s),
      ev as (select coalesce((select state='open' and current from festival_ops.events where id=e),false) open)
 select jsonb_build_object('version',3,'policy','choice-every-3','step',3,'eventId',e,
   'ready',(select count(*)=2 from festival_ops.rules where event_id=e and reward_kind is not null),
   'count',c.n,
   'nextStage',nx.s,
   'pendingStages',(select count(*) from pg_catalog.generate_series(3,greatest(c.n,0),3) s
       where not exists(select 1 from festival_ops.vouchers v where v.event_id=e and v.user_id=u and v.reward_stage=s))::integer,
   'canChoose',ev.open and c.n>=nx.s,
   'claimed',coalesce((select jsonb_agg(jsonb_build_object('stage',v.reward_stage,'kind',r.reward_kind,'voucherId',v.id,'state',v.state)
       order by v.reward_stage) from festival_ops.vouchers v join festival_ops.rules r on r.id=v.rule_id
       where v.event_id=e and v.user_id=u and v.reward_stage is not null),'[]'::jsonb),
   'options',coalesce((select jsonb_agg(jsonb_build_object('kind',r.reward_kind,'title',r.title,'ruleId',r.id,
     'available',r.enabled and r.expires_at>now() and ev.open
       and (select count(*) from festival_ops.vouchers where rule_id=r.id)<r.stock)
       || case when admin then jsonb_build_object('stock',r.stock,'version',r.version,'expiresAt',r.expires_at,
            'issued',(select count(*) from festival_ops.vouchers where rule_id=r.id)) else '{}'::jsonb end
     order by r.reward_kind desc) from festival_ops.rules r where r.event_id=e and r.reward_kind is not null),'[]'::jsonb))
 from c,nx,ev;
$$;

create function public.festival_reward_read() returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; e uuid;
begin
  me:=festival_nfc_private.current_profile();
  select id into e from festival_ops.events where current;
  return festival_ops.reward_status(e,(me->>'id')::integer,coalesce((me->>'isAdmin')::boolean,false));
end $$;

-- Single issuing path for typed vouchers. Caller must hold the operations advisory lock.
-- Returns the voucher id, or raises. An already claimed stage with the SAME kind is returned
-- as-is (lost response / double tap with a new request id); a different kind is rejected.
create function festival_ops.award_stage(e uuid,u integer,kind text,stage integer,a integer) returns uuid
language plpgsql set search_path='' as $$
declare rule festival_ops.rules; n integer; nxt integer; v uuid; claimed_kind text;
begin
  if stage is null or stage<3 or stage%3<>0 then raise exception 'INVALID_INPUT'; end if;
  select v2.id,r2.reward_kind into v,claimed_kind from festival_ops.vouchers v2 join festival_ops.rules r2 on r2.id=v2.rule_id
   where v2.event_id=e and v2.user_id=u and v2.reward_stage=stage;
  if v is not null then
    if claimed_kind=kind then return v; end if;
    raise exception 'REWARD_CHOICE_LOCKED';
  end if;
  select count(*) into n from festival_ops.reviews where event_id=e and user_id=u;
  if n<stage then raise exception 'VISIT_REQUIRED'; end if;
  nxt:=festival_ops.reward_next_stage(e,u);
  if stage<>nxt then raise exception 'REWARD_STAGE_ORDER'; end if;
  select * into rule from festival_ops.rules where event_id=e and reward_kind=kind for update;
  if rule.id is null then raise exception 'REWARD_NOT_READY'; end if;
  if not rule.enabled or rule.expires_at<=now() or (select count(*) from festival_ops.vouchers where rule_id=rule.id)>=rule.stock then
    raise exception 'OUT_OF_STOCK'; end if;
  insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at,reward_stage)
    values(e,rule.id,u,rule.title,rule.expires_at,stage) returning id into v;
  insert into festival_ops.audit(event_id,actor_id,action,target) values(e,a,'reward_issue_'||stage::text,v::text);
  return v;
end $$;

create or replace function festival_ops.award(e uuid,u integer,r uuid,a integer) returns uuid
language plpgsql set search_path='' as $$
declare rule festival_ops.rules; v uuid;
begin
  select * into rule from festival_ops.rules where event_id=e and id=r for update;
  -- Typed rules need an explicit student choice per stage: no automatic, generic-claim or manual issue.
  if rule.reward_kind is not null then return null; end if;
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
  kind text; stage integer; rule festival_ops.rules; stock integer; expected integer; expiry timestamptz;
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
        values(coalesce(rule.id,gen_random_uuid()),e,case kind when 'photo' then '포토부스 이용권' else '푸드트럭 교환권' end,3,stock,true,expiry,kind)
      on conflict(id) do update set stock=excluded.stock,expires_at=excluded.expires_at,enabled=true,version=festival_ops.rules.version+1;
    end loop;
    update festival_ops.rules set enabled=false,version=version+1 where event_id=e and reward_kind is null and enabled;
  else
    if not exists(select 1 from festival_ops.events where id=e and state='open') then raise exception 'EVENT_CLOSED'; end if;
    kind:=p_payload->>'kind';
    if kind is null or kind not in ('photo','food') then raise exception 'INVALID_INPUT'; end if;
    if jsonb_typeof(p_payload->'stage') is distinct from 'number' then raise exception 'INVALID_INPUT'; end if;
    stage:=(p_payload->>'stage')::integer;
    if (select count(*) from festival_ops.rules where event_id=e and reward_kind is not null)<>2 then raise exception 'REWARD_NOT_READY'; end if;
    perform festival_ops.award_stage(e,u,kind,stage,u);
  end if;
  result:=festival_ops.reward_status(e,u,admin);
  insert into festival_ops.audit(event_id,actor_id,action,target) values(e,u,p_action,coalesce(kind,'')||coalesce(':'||stage::text,''));
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;
revoke all on function festival_ops.reward_status(uuid,integer,boolean),festival_ops.reward_next_stage(uuid,integer),
  festival_ops.award_stage(uuid,integer,text,integer,integer) from public,anon,authenticated;
revoke all on function public.festival_reward_read(),public.festival_reward_write(text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.festival_reward_read(),public.festival_reward_write(text,jsonb,uuid) to authenticated;
notify pgrst,'reload schema';
commit;

-- ROLLBACK (only while no typed voucher exists; otherwise needs a reviewed data plan):
-- begin;
--   do $$ begin if exists(select 1 from festival_ops.vouchers where reward_stage is not null) then raise exception 'TYPED_VOUCHERS_EXIST'; end if; end $$;
--   drop function public.festival_reward_write(text,jsonb,uuid), public.festival_reward_read(),
--     festival_ops.award_stage(uuid,integer,text,integer,integer), festival_ops.reward_status(uuid,integer,boolean),
--     festival_ops.reward_next_stage(uuid,integer);
--   -- restore festival_ops.award() body from operations-server/install.sql
--   delete from festival_ops.rules where reward_kind is not null;  -- only safe because no voucher references them
--   drop index festival_ops.vouchers_untyped_once; drop index festival_ops.reward_stage_per_user; drop index festival_ops.vouchers_rule_count;
--   alter table festival_ops.vouchers drop column reward_stage;
--   alter table festival_ops.vouchers add constraint vouchers_event_id_user_id_rule_id_key unique(event_id,user_id,rule_id);
--   alter table festival_ops.rules drop constraint reward_rule_fixed_target; drop index festival_ops.reward_kind_per_event;
--   alter table festival_ops.rules drop column reward_kind;
-- commit;

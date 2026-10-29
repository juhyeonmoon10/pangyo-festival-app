-- Only before any recurring voucher has been issued. Otherwise disable, do not drop.
begin;
set local lock_timeout='5s';
select pg_catalog.pg_advisory_xact_lock(170926,1);
do $$ begin
 if exists(select 1 from festival_ops.vouchers where reward_stage is not null) then
   raise exception 'REWARD_ROLLBACK_REQUIRES_RECORD_MIGRATION';
 end if;
end $$;
drop trigger reward_after_visit on festival_ops.visits;
drop function festival_ops.reward_after_visit();
drop function public.festival_reward_write(text,jsonb,uuid);
drop function public.festival_reward_read();
CREATE OR REPLACE FUNCTION festival_ops.award(e uuid, u integer, r uuid, a integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$
;
drop function festival_ops.award_choice(uuid,integer,text,integer,boolean,integer);
drop function festival_ops.reward_status(uuid,integer,boolean);
drop function festival_ops.reward_target(uuid,integer);
delete from festival_ops.rules where reward_kind is not null;
alter table festival_ops.rules drop column reward_kind;
alter table festival_ops.vouchers drop column reward_stage;
alter table festival_ops.vouchers add constraint vouchers_event_id_user_id_rule_id_key unique(event_id,user_id,rule_id);
-- Keep legacy issuance disabled. Reactivation is a separate operator decision.
notify pgrst,'reload schema';
commit;

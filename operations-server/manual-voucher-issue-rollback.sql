-- Rollback of manual-voucher-issue.sql: award() and festival_ops_write_student as before.
-- Vouchers issued by hand meanwhile stay with their students.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

CREATE OR REPLACE FUNCTION festival_ops.award(e uuid, u integer, r uuid, a integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare rule festival_ops.rules; v uuid; first_stage integer;
begin
  select * into rule from festival_ops.rules where event_id=e and id=r for update;
  if rule.reward_kind is not null then
    -- Automatic/old/manual generic claim paths can only deliver the SECOND benefit.
    -- Only reward_choose is allowed to create the first-choice record.
    for first_stage in select x.reward_stage from festival_ops.vouchers x join festival_ops.rules r on r.id=x.rule_id
      where x.event_id=e and x.user_id=u and x.reward_stage=3 and r.reward_kind<>rule.reward_kind loop
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
end $function$;

create or replace function public.festival_ops_write_student(p_action text,p_payload jsonb,p_request_id uuid) returns jsonb
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

notify pgrst,'reload schema';
commit;

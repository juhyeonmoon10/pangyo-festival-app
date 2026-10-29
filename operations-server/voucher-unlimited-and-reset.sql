-- Approved 2026-10-30: unlimited voucher stock/deadline and an operator-only participation reset.
-- Apply after reward-fixed-milestones.sql. Rule stock NULL means no issuance limit; a deadline of
-- 'infinity' means no expiry. No table is added. The reset keeps operator flags (users.admin),
-- accounts, booth setup, voucher rules, the official roster, NFC tags and the audit history.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

alter table festival_ops.rules alter column stock drop not null;

CREATE OR REPLACE FUNCTION festival_ops.reward_status(e uuid, u integer, admin boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
 with stage as (select festival_ops.reward_target(e,u) target)
 select jsonb_build_object('version',2,'eventId',e,'firstTarget',stage.target,'secondTarget',stage.target+3,
   'issuedCount',(select count(*) from festival_ops.vouchers where event_id=e and user_id=u and reward_stage in (3,6)),
   'ready',(select count(*)=2 and coalesce(bool_and(enabled and expires_at>now()),false) from festival_ops.rules where event_id=e and reward_kind is not null),
   'count',(select count(*) from festival_ops.visits where event_id=e and user_id=u),
   'firstChoice',(select r.reward_kind from festival_ops.vouchers v join festival_ops.rules r on r.id=v.rule_id where v.event_id=e and v.user_id=u and v.reward_stage=stage.target),
   'secondIssued',exists(select 1 from festival_ops.vouchers where event_id=e and user_id=u and reward_stage=stage.target+3),
   'canChoose',not exists(select 1 from festival_ops.vouchers where event_id=e and user_id=u and reward_stage=3) and (select count(*)=2 and coalesce(bool_and(enabled and expires_at>now()),false) from festival_ops.rules where event_id=e and reward_kind is not null) and exists(select 1 from festival_ops.events where id=e and current and state='open') and (select count(*)>=stage.target from festival_ops.visits where event_id=e and user_id=u),
   'options',coalesce((select jsonb_agg(jsonb_build_object('kind',r.reward_kind,'title',r.title,'ruleId',r.id,
     'available',coalesce(r.enabled and r.expires_at>now() and (select state='open' from festival_ops.events where id=e)
       and (r.stock is null or (select count(*) from festival_ops.vouchers where rule_id=r.id)<r.stock),false))
       || case when admin then jsonb_build_object('stock',r.stock,'version',r.version,'expiresAt',r.expires_at,
         'issued',(select count(*) from festival_ops.vouchers where rule_id=r.id)) else '{}'::jsonb end
     order by r.reward_kind desc) from festival_ops.rules r where r.event_id=e and r.reward_kind is not null),'[]'::jsonb)) from stage;
$function$
;

CREATE OR REPLACE FUNCTION public.festival_reward_write(p_action text, p_payload jsonb, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- 'infinity' is the explicit "no deadline" value.
    expiry:=(p_payload->>'expiresAt')::timestamptz;
    if expiry is null or expiry<=now() then raise exception 'INVALID_INPUT'; end if;
    foreach kind in array array['photo','food'] loop
      select * into rule from festival_ops.rules where event_id=e and reward_kind=kind for update;
      -- A JSON null stock is the explicit "no limit" value; a missing key is rejected.
      if not (p_payload ? (kind||'Stock')) then raise exception 'INVALID_INPUT'; end if;
      stock:=(p_payload->>(kind||'Stock'))::integer;expected:=(p_payload->>(kind||'Version'))::integer;
      if expected is distinct from coalesce(rule.version,0) then raise exception 'VERSION_CONFLICT'; end if;
      if stock not between 0 and 100000 or stock<(select count(*) from festival_ops.vouchers where rule_id=rule.id) then raise exception 'INVALID_INPUT'; end if;
      insert into festival_ops.rules(id,event_id,title,target,stock,enabled,expires_at,reward_kind)
        values(coalesce(rule.id,gen_random_uuid()),e,case kind when 'photo' then '포토부스 이용권' else '푸드트럭 교환권' end,3,stock,coalesce((p_payload->>'enabled')::boolean,false),expiry,kind)
      on conflict(id) do update set stock=excluded.stock,expires_at=excluded.expires_at,enabled=excluded.enabled,version=festival_ops.rules.version+1;
      -- Already issued vouchers follow a changed deadline so one setting governs every coupon.
      update festival_ops.vouchers set expires_at=expiry
        where rule_id=coalesce(rule.id,(select id from festival_ops.rules where event_id=e and reward_kind=kind)) and state='available';
    end loop;
    update festival_ops.rules set enabled=false,version=version+1 where event_id=e and reward_kind is null and enabled;
  else
    if not exists(select 1 from festival_ops.events where id=e and state='open') then raise exception 'EVENT_CLOSED'; end if;
    kind:=p_payload->>'kind';
    if kind is null or kind not in ('photo','food') then raise exception 'INVALID_INPUT'; end if;
    first_target:=(p_payload->>'firstTarget')::integer;
    if first_target is distinct from 3 then raise exception 'INVALID_INPUT'; end if;
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
end $function$
;

-- Clears every participant record for a fresh festival start. Keeps users.admin and accounts.
create function public.festival_ops_reset(p_payload jsonb, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; old festival_ops.requests; fp bytea; result jsonb; identities boolean;
  c_vouchers integer; c_ledger integer; c_reviews integer; c_visits integer; c_identities integer:=0;
  c_ratings integer; c_stamps integer; c_requests integer;
begin
  if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>500 then raise exception 'INVALID_INPUT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current for update;
  if e is null or (p_payload->>'eventId')::uuid is distinct from e then raise exception 'VERSION_CONFLICT'; end if;
  if p_payload->>'confirm' is distinct from '초기화' then raise exception 'RESET_CONFIRM_REQUIRED'; end if;
  if jsonb_typeof(p_payload->'identities') is distinct from 'boolean' then raise exception 'INVALID_INPUT'; end if;
  identities:=(p_payload->>'identities')::boolean;
  fp:=extensions.digest('participation_reset:'||p_payload::text,'sha256');
  select * into old from festival_ops.requests where actor_id=u and request_id=p_request_id;
  if found then
    if old.fingerprint<>fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  -- Children before parents: reviews reference visits.
  delete from festival_ops.vouchers where event_id=e; get diagnostics c_vouchers=row_count;
  delete from festival_ops.ledger where event_id=e; get diagnostics c_ledger=row_count;
  delete from festival_ops.reviews where event_id=e; get diagnostics c_reviews=row_count;
  delete from festival_ops.visits where event_id=e; get diagnostics c_visits=row_count;
  if identities then delete from festival_ops.review_identities where event_id=e; get diagnostics c_identities=row_count; end if;
  -- Legacy stamp and rating records shown by the same app. The rating trigger resets booth averages.
  delete from public.booth_ratings; get diagnostics c_ratings=row_count;
  update public.booths set rating=0 where rating<>0;
  update public.users set completed_booths='{}',completed_quests='{}'
    where cardinality(completed_booths)>0 or cardinality(completed_quests)>0;
  get diagnostics c_stamps=row_count;
  -- Cached responses would otherwise replay deleted records.
  delete from festival_ops.requests; get diagnostics c_requests=row_count;
  result:=jsonb_build_object('reset',true,'vouchers',c_vouchers,'points',c_ledger,'reviews',c_reviews,'visits',c_visits,
    'identities',c_identities,'ratings',c_ratings,'stampAccounts',c_stamps);
  insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e,u,'participation_reset',null,result::text);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;
revoke all on function public.festival_ops_reset(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.festival_ops_reset(jsonb,uuid) to authenticated;

notify pgrst,'reload schema';
commit;

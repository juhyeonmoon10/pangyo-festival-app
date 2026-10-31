-- Approved 2026-10-31 (user request): 권한 관리 gains a second role, 바우처 담당자 (voucher manager).
-- Apply after booth-managers.sql and review-distribution-self-redeem.sql.
-- * Only an operator grants it, per voucher kind: 푸드트럭 바우처 담당자 (food) or 포토부스 바우처
--   담당자 (photo). Like 부스 담당자, the student's identity must be verified (소속 확인); the right
--   lapses while that verification is revoked.
-- * A manager only checks and redeems voucher codes (사용 승인), and only vouchers of a granted kind.
--   The kind is the voucher rule's reward_kind; a voucher without one stays operator-only.
-- * A manager cannot redeem an own voucher. Operators keep full access, as before.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create table if not exists festival_ops.voucher_managers(
  event_id uuid not null,
  user_id integer not null references public.users(id),
  reward_kind text not null check (reward_kind in ('food','photo')),
  granted_by integer,
  granted_at timestamptz not null default now(),
  primary key(event_id, user_id, reward_kind)
);
alter table festival_ops.voucher_managers enable row level security;
revoke all on festival_ops.voucher_managers from public, anon, authenticated;

-- Voucher kinds a student may redeem now: granted kinds while their identity stays verified.
create or replace function festival_ops.voucher_kinds(e uuid, u integer) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(m.reward_kind order by m.reward_kind), '{}'::text[]) from festival_ops.voucher_managers m
    join festival_ops.review_identities i on i.event_id = m.event_id and i.user_id = m.user_id and i.verified
    where m.event_id = e and m.user_id = u
$$;
revoke all on function festival_ops.voucher_kinds(uuid, integer) from public, anon, authenticated;

-- Check or redeem by code (operators and voucher managers), and 'status': the kinds this account may redeem.
-- Accepts the previous, current and next 30-second step. Every redemption keeps its actor in the audit log.
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

-- Operators: list, candidates, grant, revoke. Students are named by 학번 (and Google email when shared).
create or replace function public.festival_voucher_manager_admin(p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e uuid; target integer; acct jsonb; ident festival_ops.review_identities; kind text; u integer;
begin
  if p_action is null or p_action not in ('list','candidates','grant','revoke')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or p_payload ? 'userId' or length(p_payload::text) > 2000 then
    raise exception 'INVALID_INPUT';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  e := festival_ops.require_operator();
  u := (festival_nfc_private.current_profile()->>'id')::integer;

  if p_action = 'list' then
    return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('name', coalesce(p.name, '참여자'),
        'studentNumber', festival_ops.student_number_of(e, m.user_id), 'email', a.email, 'kind', m.reward_kind,
        'grantedAt', m.granted_at, 'grantedByName', g.name,
        'active', exists(select 1 from festival_ops.review_identities i where i.event_id = e and i.user_id = m.user_id and i.verified))
        order by m.reward_kind, p.name)
      from festival_ops.voucher_managers m join public.users p on p.id = m.user_id join auth.users a on a.id = p.auth_user_id
      left join public.users g on g.id = m.granted_by
      where m.event_id = e), '[]'::jsonb));
  end if;

  acct := p_payload->'account';
  if jsonb_typeof(acct) is distinct from 'object' then raise exception 'INVALID_INPUT'; end if;
  target := festival_ops.resolve_student(e, btrim(coalesce(acct->>'studentNumber', '')), nullif(btrim(acct->>'email'), ''));
  select * into ident from festival_ops.review_identities where event_id = e and user_id = target;

  if p_action = 'candidates' then
    return jsonb_build_object('name', (select coalesce(name, '참여자') from public.users where id = target),
      'studentNumber', festival_ops.student_number_of(e, target), 'verified', coalesce(ident.verified, false),
      'realName', case when ident.verified then ident.real_name end,
      'kinds', coalesce((select jsonb_agg(m.reward_kind order by m.reward_kind) from festival_ops.voucher_managers m
        where m.event_id = e and m.user_id = target), '[]'::jsonb));
  end if;

  kind := p_payload->>'kind';
  if kind is null or kind not in ('food','photo') then raise exception 'INVALID_INPUT'; end if;
  if p_action = 'grant' then
    if not coalesce(ident.verified, false) then raise exception 'VOUCHER_MANAGER_NOT_VERIFIED'; end if;
    insert into festival_ops.voucher_managers(event_id, user_id, reward_kind, granted_by) values(e, target, kind, u)
      on conflict (event_id, user_id, reward_kind) do update set granted_by = excluded.granted_by, granted_at = now();
    insert into festival_ops.audit(event_id, actor_id, action, target, reason) values(e, u, 'voucher_manager_grant', target::text, kind);
  else
    delete from festival_ops.voucher_managers where event_id = e and user_id = target and reward_kind = kind;
    if found then
      insert into festival_ops.audit(event_id, actor_id, action, target, reason) values(e, u, 'voucher_manager_revoke', target::text, kind);
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.festival_voucher_manager_admin(text, jsonb) from public, anon, authenticated;
grant execute on function public.festival_voucher_manager_admin(text, jsonb) to authenticated;

notify pgrst,'reload schema';
commit;

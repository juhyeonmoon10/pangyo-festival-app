-- Approved 2026-10-30: 8-character rotating voucher codes for QR and manual entry.
-- Apply after voucher-unlimited-and-reset.sql. Each voucher gets a private random secret; the code
-- for 30-second step s is HMAC-SHA256(secret, s) encoded as 8 characters of an unambiguous
-- 32-letter alphabet (40 bits). Redemption accepts the previous, current and next step.
-- The QR payload is the same 8-character code, so a failed camera falls back to typing it.
-- The legacy voucher_qr/voucher_redeem actions of festival_ops_write are left unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

alter table festival_ops.vouchers add column code_secret bytea check (code_secret is null or length(code_secret)=20);

create function festival_ops.voucher_step(t timestamptz default now()) returns bigint
language sql stable set search_path='' as $$ select floor(extract(epoch from t)/30)::bigint $$;

create function festival_ops.voucher_code(secret bytea,step bigint) returns text
language plpgsql immutable set search_path='' as $$
declare alphabet constant text:='23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; mac bytea; bits bigint:=0; code text:=''; i integer;
begin
  mac:=extensions.hmac(convert_to(step::text,'UTF8'),secret,'sha256');
  for i in 0..4 loop bits:=(bits<<8) | get_byte(mac,i); end loop;
  for i in reverse 7..0 loop code:=code||substr(alphabet,((bits>>(i*5)) & 31)::integer+1,1); end loop;
  return code;
end $$;

-- Student: the current code of an own, available voucher. Creates the secret on first use.
create function public.festival_voucher_code(p_voucher uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; v festival_ops.vouchers; s bigint;
begin
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  select * into v from festival_ops.vouchers where event_id=e and id=p_voucher and user_id=u for update;
  if v.id is null then raise exception 'NOT_FOUND'; end if;
  if v.state='used' then raise exception 'VOUCHER_USED'; end if;
  if v.state='void' then raise exception 'VOUCHER_VOID'; end if;
  if v.expires_at<=now() then raise exception 'VOUCHER_EXPIRED'; end if;
  if v.code_secret is null then
    update festival_ops.vouchers set code_secret=extensions.gen_random_bytes(20) where id=v.id returning * into v;
  end if;
  s:=festival_ops.voucher_step();
  return jsonb_build_object('id',v.id,'code',festival_ops.voucher_code(v.code_secret,s),'stepSeconds',30,
    'validUntil',to_timestamp((s+1)*30),'serverTime',now());
end $$;

-- Operator: check or redeem by code. Accepts the previous, current and next 30-second step.
create function public.festival_voucher_redeem(p_action text,p_payload jsonb,p_request_id uuid default null) returns jsonb
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
    return jsonb_build_object('valid',v.state='available' and v.expires_at>now() and v.user_id<>u and e.state='open',
      'state',case when v.state<>'available' then v.state when v.expires_at<=now() then 'expired' else 'available' end,
      'title',v.title,'participant',owner_name,'own',v.user_id=u,'eventOpen',e.state='open');
  end if;
  if v.user_id=u then raise exception 'SELF_REDEMPTION'; end if;
  if v.state='used' then raise exception 'VOUCHER_USED'; end if;
  if v.state='void' then raise exception 'VOUCHER_VOID'; end if;
  if v.expires_at<=now() then raise exception 'VOUCHER_EXPIRED'; end if;
  if e.state<>'open' then raise exception 'EVENT_CLOSED'; end if;
  update festival_ops.vouchers set state='used',redeemed_at=now(),redeemed_by=u where id=v.id;
  result:=jsonb_build_object('id',v.id,'title',v.title,'participant',owner_name,'result','REDEEMED');
  insert into festival_ops.audit(event_id,actor_id,action,target) values(e.id,u,'voucher_redeem',v.id::text);
  insert into festival_ops.requests(actor_id,request_id,fingerprint,response) values(u,p_request_id,fp,result);
  return result;
end $$;

revoke all on function festival_ops.voucher_step(timestamptz),festival_ops.voucher_code(bytea,bigint) from public,anon,authenticated;
revoke all on function public.festival_voucher_code(uuid),public.festival_voucher_redeem(text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.festival_voucher_code(uuid),public.festival_voucher_redeem(text,jsonb,uuid) to authenticated;
notify pgrst,'reload schema';
commit;

-- Approved 2026-10-30: NFC stamp rate limit and suspicious participant detection.
-- Apply after nfc-tag-registry.sql. The operator sets "at most N new booth stamps by NFC in M minutes"
-- (default 5 in 10 minutes). claim() refuses the next new booth with CLAIM_RATE_LIMITED; a booth the
-- participant already earned can always be re-scanned. Copied links cannot be told apart from real
-- taps with these cards, so this limits and surfaces bulk claiming instead of preventing it.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create table festival_ops.claim_guard(
  event_id uuid primary key references festival_ops.events(id) on delete cascade,
  enabled boolean not null default true,
  window_minutes integer not null default 10 check (window_minutes between 1 and 180),
  max_claims integer not null default 5 check (max_claims between 1 and 100),
  version integer not null default 1,
  updated_by integer,
  updated_at timestamptz not null default now()
);
alter table festival_ops.claim_guard enable row level security;
revoke all on festival_ops.claim_guard from public, anon, authenticated;

-- A festival without a saved setting uses the defaults (enabled, 5 in 10 minutes, version 0).
create function festival_ops.claim_guard_of(e uuid) returns festival_ops.claim_guard
language plpgsql stable set search_path='' as $$
declare g festival_ops.claim_guard;
begin
  select * into g from festival_ops.claim_guard where event_id=e;
  if g.event_id is null and e is not null then
    g.event_id:=e; g.enabled:=true; g.window_minutes:=10; g.max_claims:=5; g.version:=0;
  end if;
  return g;
end $$;
revoke all on function festival_ops.claim_guard_of(uuid) from public, anon, authenticated;

create or replace function festival_nfc_private.claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb;
  config jsonb;
  payload jsonb;
  encoded text;
  expected text;
  booth public.booth_enum;
  profile public.users%rowtype;
  duplicate boolean;
  tag_id text;
  stopped boolean;
  guard festival_ops.claim_guard;
  recent integer;
begin
  me := festival_nfc_private.current_profile();
  if (me->>'needsProfile')::boolean then
    raise exception using errcode = '42501', message = 'PROFILE_REQUIRED';
  end if;
  select decrypted_secret::jsonb into config from vault.decrypted_secrets where name = 'pangyo_festival_nfc_v1';
  if config is null or coalesce((config->>'enabled')::boolean, false) is not true then
    raise exception using errcode = '42501', message = 'NFC_DISABLED';
  end if;
  if p_token is null or length(p_token) > 1024
    or p_token !~ '^nf1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
  end if;
  encoded := split_part(p_token, '.', 2);
  expected := encode(extensions.hmac(convert_to('nf1.' || encoded, 'UTF8'), decode(config->>'key', 'hex'), 'sha256'), 'hex');
  if split_part(p_token, '.', 3) <> expected then
    raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
  end if;
  begin
    payload := convert_from(decode(rpad(translate(encoded, '-_', '+/'), ((length(encoded)+3)/4)*4, '='), 'base64'), 'UTF8')::jsonb;
    booth := (payload->>'booth')::public.booth_enum;
    if payload->>'epoch' is distinct from config->>'epoch' then
      raise exception 'NFC_TAG_EXPIRED';
    end if;
    -- Only an explicitly signed permanent payload bypasses the clock check.
    if payload->>'lifetime' = 'permanent' then
      if (payload->'expires') is distinct from 'null'::jsonb
        or coalesce(payload->>'nonce', '') !~ '^[0-9a-f]{32}$' then
        raise exception 'NFC_TAG_EXPIRED';
      end if;
    elsif payload ? 'lifetime' or payload->>'expires' is null
      or payload->>'expires' !~ '^[0-9]{1,12}$'
      or (payload->>'expires')::bigint <= extract(epoch from now()) then
      raise exception 'NFC_TAG_EXPIRED';
    end if;
  exception when others then
    raise exception using errcode = '22023', message = 'NFC_TAG_EXPIRED';
  end;
  if booth is null or not exists(select 1 from public.booths where id = booth) then
    raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
  end if;
  -- A tag issued before the registry appears in the operator list on its first scan.
  tag_id := festival_nfc_private.tag_register(encoded, payload, 'discovered', null);
  if tag_id is not null then
    select revoked_at is not null into stopped from festival_nfc_private.tags where id = tag_id for update;
    if stopped then
      raise exception using errcode = '22023', message = 'NFC_TAG_EXPIRED';
    end if;
  end if;
  -- Rate limit: a new booth beyond the operator's "N stamps in M minutes" is refused.
  -- Re-scanning an already earned booth is never limited.
  guard := festival_ops.claim_guard_of((select id from festival_ops.events where current));
  if guard.enabled and guard.event_id is not null and not exists(select 1 from festival_ops.visits v
      join festival_ops.booths b on b.event_id = v.event_id and b.key = v.booth_key
      where v.event_id = guard.event_id and v.user_id = (me->>'id')::integer and b.legacy_key = booth) then
    select count(*) into recent from festival_ops.visits
      where event_id = guard.event_id and user_id = (me->>'id')::integer and method = 'nfc'
        and created_at > now() - make_interval(mins => guard.window_minutes);
    if recent >= guard.max_claims then
      raise exception using errcode = '42501', message = 'CLAIM_RATE_LIMITED';
    end if;
  end if;
  select * into profile from public.users where id = (me->>'id')::integer and auth_user_id = auth.uid() for update;
  if not found then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;
  duplicate := coalesce(booth = any(profile.completed_booths), false);
  if not duplicate then
    update public.users set completed_booths = array_append(completed_booths, booth)
      where id = profile.id returning * into profile;
  end if;
  if tag_id is not null then
    update festival_nfc_private.tags set use_count = use_count + 1, last_used_at = now() where id = tag_id;
  end if;
  return jsonb_build_object('result', case when duplicate then 'ALREADY_EARNED' else 'EARNED' end,
    'boothKey', booth, 'completedBooths', to_jsonb(profile.completed_booths), 'checkedAt', now());
end $$;


-- Operator: read the setting with participants who reached the limit, or save the setting.
create function public.festival_claim_guard(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; g festival_ops.claim_guard; win integer; maxc integer;
begin
  if p_action is null or p_action not in ('read','save') or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or length(p_payload::text)>500 then raise exception 'INVALID_INPUT'; end if;
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  if p_action='save' then
    perform pg_catalog.pg_advisory_xact_lock(170926,1);
    g:=festival_ops.claim_guard_of(e);
    if (p_payload->>'version')::integer is distinct from g.version then raise exception 'VERSION_CONFLICT'; end if;
    if jsonb_typeof(p_payload->'enabled') is distinct from 'boolean' then raise exception 'INVALID_INPUT'; end if;
    win:=(p_payload->>'windowMinutes')::integer; maxc:=(p_payload->>'maxClaims')::integer;
    if win is null or win not between 1 and 180 or maxc is null or maxc not between 1 and 100 then raise exception 'INVALID_INPUT'; end if;
    insert into festival_ops.claim_guard(event_id,enabled,window_minutes,max_claims,version,updated_by,updated_at)
      values(e,(p_payload->>'enabled')::boolean,win,maxc,g.version+1,u,now())
    on conflict(event_id) do update set enabled=excluded.enabled,window_minutes=excluded.window_minutes,
      max_claims=excluded.max_claims,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
    insert into festival_ops.audit(event_id,actor_id,action,target,reason)
      values(e,u,'claim_guard_save',null,format('%s, %s분에 최대 %s개',case when (p_payload->>'enabled')::boolean then '사용' else '사용 안 함' end,win,maxc));
  end if;
  g:=festival_ops.claim_guard_of(e);
  -- A participant is listed when some M-minute span holds at least N NFC stamps (the limit was reached).
  return jsonb_build_object('enabled',g.enabled,'windowMinutes',g.window_minutes,'maxClaims',g.max_claims,'version',g.version,
    'items',coalesce((select jsonb_agg(jsonb_build_object('userId',x.user_id,'name',coalesce(pu.name,'참여자'),'peak',x.peak,
        'nfc',x.nfc,'manual',x.manual,'lastAt',x.last_at,'peakAt',x.peak_at) order by x.peak desc,x.last_at desc)
      from (select w.user_id,max(w.n) peak,
          (array_agg(w.created_at order by w.n desc,w.created_at desc))[1] peak_at,
          (select count(*) from festival_ops.visits where event_id=e and user_id=w.user_id and method='nfc') nfc,
          (select count(*) from festival_ops.visits where event_id=e and user_id=w.user_id and method<>'nfc') manual,
          max(w.created_at) last_at
        from (select a.user_id,a.created_at,(select count(*) from festival_ops.visits b where b.event_id=e and b.user_id=a.user_id
            and b.method='nfc' and b.created_at>a.created_at-make_interval(mins=>g.window_minutes) and b.created_at<=a.created_at) n
          from festival_ops.visits a where a.event_id=e and a.method='nfc') w
        group by w.user_id having max(w.n)>=g.max_claims order by max(w.n) desc limit 200) x
      left join public.users pu on pu.id=x.user_id),'[]'::jsonb));
end $$;
revoke all on function public.festival_claim_guard(text,jsonb) from public,anon,authenticated;
grant execute on function public.festival_claim_guard(text,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;

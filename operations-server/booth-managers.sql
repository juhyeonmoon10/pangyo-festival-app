-- Approved 2026-10-31 (user request): a third role, 부스 담당자 (booth manager).
-- Apply after sun-nfc.sql.
-- * Only an operator grants it, and only to a student whose own club is verified (소속 확인), for a
--   booth of that club. The right lapses when the verification is revoked or no longer lists the booth.
-- * A manager edits their booth's introduction (description), program and status.
-- * When the operator allowed it at grant time, a manager approves a manual stamp for their booth
--   only, naming the student by 학번. Own-club, event and booth rules stay as for operators.
-- * Operators keep full access and may use the same screen for any booth.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

-- Program shown on the booth page: title, description, hours, duration, participation, materials.
alter table festival_ops.booths add column if not exists program jsonb not null default '{}'::jsonb;
alter table festival_ops.booths drop constraint if exists booths_program_shape;
alter table festival_ops.booths add constraint booths_program_shape
  check (jsonb_typeof(program) = 'object' and length(program::text) <= 4000);

create table if not exists festival_ops.booth_managers(
  event_id uuid not null,
  user_id integer not null references public.users(id),
  booth_key text not null,
  can_approve boolean not null default false,
  granted_by integer,
  granted_at timestamptz not null default now(),
  primary key(event_id, user_id, booth_key),
  foreign key(event_id, booth_key) references festival_ops.booths(event_id, key) on delete cascade
);
alter table festival_ops.booth_managers enable row level security;
revoke all on festival_ops.booth_managers from public, anon, authenticated;

-- Booths a person may manage now. Operators: every booth, approval included. Managers: granted
-- booths that their verified club membership still lists.
create or replace function festival_ops.managed_booths(e uuid, u integer, is_admin boolean)
returns table(booth_key text, can_approve boolean) language sql stable set search_path = '' as $$
  select b.key, true from festival_ops.booths b where is_admin and b.event_id = e
  union all
  select m.booth_key, m.can_approve from festival_ops.booth_managers m
    join festival_ops.review_identities i on i.event_id = m.event_id and i.user_id = m.user_id and i.verified
    where not is_admin and m.event_id = e and m.user_id = u and m.booth_key = any(i.booth_keys)
$$;
revoke all on function festival_ops.managed_booths(uuid, integer, boolean) from public, anon, authenticated;

-- Program fields are plain text with fixed limits; unknown keys are refused.
create or replace function festival_ops.booth_program(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; limits constant jsonb := '{"title":80,"description":1000,"hours":100,"duration":100,"participation":300,"materials":200}';
  out jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return out; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'INVALID_INPUT'; end if;
  for k in select jsonb_object_keys(p) loop
    if not limits ? k or jsonb_typeof(p->k) <> 'string' or length(p->>k) > (limits->>k)::integer then raise exception 'INVALID_INPUT'; end if;
    if btrim(p->>k) <> '' then out := out || jsonb_build_object(k, btrim(p->>k)); end if;
  end loop;
  return out;
end $$;
revoke all on function festival_ops.booth_program(jsonb) from public, anon, authenticated;

-- Accounts holding a 학번, with an opaque reference that tells them apart without showing the email.
create or replace function festival_ops.student_accounts(e uuid, sid text)
returns table(user_id integer, name text, ref text, masked text, held boolean) language sql stable set search_path = '' as $$
  select p.id, coalesce(p.name, '참여자'),
    left(encode(extensions.digest(lower(a.email) || ':' || e::text, 'sha256'), 'hex'), 16),
    regexp_replace(lower(a.email), '^(.{1,2})[^@]*(@.*)$', '\1***\2'),
    exists(select 1 from festival_ops.review_identities i where i.event_id = e and i.user_id = p.id and i.verified and i.student_number = sid)
  from public.users p join auth.users a on a.id = p.auth_user_id
  where sid ~ '^[1-3][0-9]{4}$' and festival_ops.student_number_of(e, p.id) = sid
$$;
revoke all on function festival_ops.student_accounts(uuid, text) from public, anon, authenticated;

-- Booth manager actions: status, save, lookup, visit_approve.
create or replace function public.festival_booth_manager(p_action text, p_payload jsonb, p_request_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me jsonb; u integer; admin boolean; e festival_ops.events; b festival_ops.booths; allowed boolean; approve boolean;
  sid text; target integer; why text; changed integer; old festival_ops.requests; fp bytea; result jsonb; n integer;
begin
  if p_action is null or p_action not in ('status','save','lookup','visit_approve')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 6000 then
    raise exception 'INVALID_INPUT';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean, true) then raise exception 'PROFILE_REQUIRED'; end if;
  admin := coalesce((me->>'isAdmin')::boolean, false);
  select * into e from festival_ops.events where current;
  if e.id is null then
    if p_action = 'status' then return jsonb_build_object('isAdmin', admin, 'items', '[]'::jsonb); end if;
    raise exception 'OPS_NOT_READY';
  end if;

  if p_action = 'status' then
    return jsonb_build_object('isAdmin', admin, 'items', coalesce((select jsonb_agg(jsonb_build_object(
        'key', x.key, 'name', x.name, 'location', x.location, 'floor', x.floor, 'status', x.status,
        'description', x.description, 'program', x.program, 'version', x.version, 'canApprove', m.can_approve)
        order by x.floor, x.name)
      from festival_ops.managed_booths(e.id, u, admin) m join festival_ops.booths x on x.event_id = e.id and x.key = m.booth_key), '[]'::jsonb));
  end if;

  select m.can_approve into approve from festival_ops.managed_booths(e.id, u, admin) m where m.booth_key = p_payload->>'booth';
  if approve is null then raise exception 'BOOTH_MANAGER_REQUIRED'; end if;
  select * into b from festival_ops.booths where event_id = e.id and key = p_payload->>'booth' for update;

  if p_action = 'save' then
    if (p_payload->>'version')::integer is distinct from b.version then raise exception 'VERSION_CONFLICT'; end if;
    if p_payload->>'status' not in ('open','paused','closed') or length(coalesce(p_payload->>'description', '')) > 2000 then
      raise exception 'INVALID_INPUT';
    end if;
    update festival_ops.booths set status = p_payload->>'status', description = btrim(coalesce(p_payload->>'description', '')),
      program = festival_ops.booth_program(p_payload->'program'), version = version + 1
      where event_id = e.id and key = b.key returning * into b;
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values(e.id, u, case when admin then 'booth_info_save' else 'booth_manager_save' end, b.key, b.status);
    return jsonb_build_object('key', b.key, 'name', b.name, 'location', b.location, 'floor', b.floor, 'status', b.status,
      'description', b.description, 'program', b.program, 'version', b.version, 'canApprove', approve);
  end if;

  -- Manual stamps: only with approval allowed for this booth.
  if not approve then raise exception 'BOOTH_APPROVAL_NOT_ALLOWED'; end if;
  sid := btrim(coalesce(p_payload->>'studentNumber', ''));
  if sid !~ '^[1-3][0-9]{4}$' then raise exception 'INVALID_INPUT'; end if;

  if p_action = 'lookup' then
    select count(*) into n from festival_ops.student_accounts(e.id, sid);
    if n = 0 then raise exception 'STUDENT_NOT_FOUND'; end if;
    return jsonb_build_object('studentNumber', sid, 'accounts', (select jsonb_agg(jsonb_build_object('name', s.name, 'ref', s.ref,
        'email', case when n > 1 then s.masked end, 'selected', n = 1 or (s.held and (select count(*) from festival_ops.student_accounts(e.id, sid) h where h.held) = 1),
        'visited', exists(select 1 from festival_ops.visits v where v.event_id = e.id and v.user_id = s.user_id and v.booth_key = b.key),
        'ownClub', b.key = any(festival_ops.own_booths(e.id, s.user_id))) order by s.name)
      from festival_ops.student_accounts(e.id, sid) s));
  end if;

  if p_request_id is null then raise exception 'INVALID_INPUT'; end if;
  fp := extensions.digest('booth_manager_visit:' || p_payload::text, 'sha256');
  select * into old from festival_ops.requests where actor_id = u and request_id = p_request_id;
  if found then
    if old.fingerprint <> fp then raise exception 'REQUEST_CONFLICT'; end if;
    return old.response;
  end if;
  if e.state <> 'open' then raise exception 'EVENT_CLOSED'; end if;
  if b.status <> 'open' then raise exception 'BOOTH_CLOSED'; end if;
  why := btrim(coalesce(p_payload->>'reason', ''));
  if length(why) not between 3 and 300 then raise exception 'INVALID_INPUT'; end if;
  if nullif(p_payload->>'ref', '') is not null then
    select s.user_id into target from festival_ops.student_accounts(e.id, sid) s where s.ref = p_payload->>'ref';
    if target is null then raise exception 'STUDENT_NOT_FOUND'; end if;
  else
    target := festival_ops.resolve_student(e.id, sid, null);
  end if;
  if b.key = any(festival_ops.own_booths(e.id, target)) then raise exception 'OWN_CLUB_STAMP'; end if;
  insert into festival_ops.visits(event_id, user_id, booth_key, method, actor_id, reason)
    values(e.id, target, b.key, 'manual', u, why) on conflict do nothing;
  get diagnostics changed = row_count;
  -- The audit target is the account number, like other participant records; the reason names the booth.
  insert into festival_ops.audit(event_id, actor_id, action, target, reason)
    values(e.id, u, 'booth_manager_visit', target::text, b.key || ' · ' || why);
  result := jsonb_build_object('result', case when changed = 0 then 'ALREADY_EARNED' else 'EARNED' end, 'booth', b.key);
  insert into festival_ops.requests(actor_id, request_id, fingerprint, response) values(u, p_request_id, fp, result);
  return result;
end $$;
revoke all on function public.festival_booth_manager(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.festival_booth_manager(text, jsonb, uuid) to authenticated;

-- Operators: list, candidates, grant, revoke. Students are named by 학번 (and Google email when shared).
create or replace function public.festival_booth_manager_admin(p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e uuid; target integer; acct jsonb; ident festival_ops.review_identities; key text; u integer; approve boolean;
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
        'studentNumber', festival_ops.student_number_of(e, m.user_id), 'email', a.email, 'booth', m.booth_key, 'boothName', b.name,
        'canApprove', m.can_approve, 'grantedAt', m.granted_at, 'grantedByName', g.name,
        'active', exists(select 1 from festival_ops.review_identities i where i.event_id = e and i.user_id = m.user_id
          and i.verified and m.booth_key = any(i.booth_keys))) order by b.name, p.name)
      from festival_ops.booth_managers m join public.users p on p.id = m.user_id join auth.users a on a.id = p.auth_user_id
      join festival_ops.booths b on b.event_id = m.event_id and b.key = m.booth_key left join public.users g on g.id = m.granted_by
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
      'booths', coalesce((select jsonb_agg(jsonb_build_object('key', b.key, 'name', b.name,
          'managed', m.user_id is not null, 'canApprove', coalesce(m.can_approve, false)) order by b.name)
        from festival_ops.booths b left join festival_ops.booth_managers m on m.event_id = e and m.user_id = target and m.booth_key = b.key
        where b.event_id = e and ident.verified and b.key = any(ident.booth_keys)), '[]'::jsonb));
  end if;

  key := p_payload->>'booth';
  if not exists(select 1 from festival_ops.booths where event_id = e and booths.key = p_payload->>'booth') then raise exception 'NOT_FOUND'; end if;
  if p_action = 'grant' then
    if jsonb_typeof(p_payload->'canApprove') is distinct from 'boolean' then raise exception 'INVALID_INPUT'; end if;
    if not coalesce(ident.verified, false) or not key = any(ident.booth_keys) then raise exception 'BOOTH_MANAGER_NOT_VERIFIED'; end if;
    approve := (p_payload->>'canApprove')::boolean;
    insert into festival_ops.booth_managers(event_id, user_id, booth_key, can_approve, granted_by)
      values(e, target, key, approve, u)
      on conflict (event_id, user_id, booth_key) do update set can_approve = excluded.can_approve, granted_by = excluded.granted_by, granted_at = now();
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values(e, u, 'booth_manager_grant', target::text, key || ' · ' || case when approve then '수동 승인 허용' else '수동 승인 불가' end);
  else
    delete from festival_ops.booth_managers where event_id = e and user_id = target and booth_key = key;
    if found then
      insert into festival_ops.audit(event_id, actor_id, action, target, reason) values(e, u, 'booth_manager_revoke', target::text, key);
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.festival_booth_manager_admin(text, jsonb) from public, anon, authenticated;
grant execute on function public.festival_booth_manager_admin(text, jsonb) to authenticated;

notify pgrst,'reload schema';
commit;

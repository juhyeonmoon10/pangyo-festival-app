-- Approved 2026-11-04 (user request): booth waiting lists, booth posters, no operating hours (1.59).
-- Apply after booth-profile.sql and account-delete.sql. Push delivery (pg_net, pg_cron, VAPID keys) is wired
-- by waiting-push.sql on Supabase only; without it notifications stay queued in festival_ops.push_outbox.
-- * 웨이팅: a booth manager (or an operator) turns it on per booth and allows online and/or on-site QR
--   registration. Signed-in students wait at any number of booths, one entry per booth. Numbers start at 1
--   per booth every day (Asia/Seoul). Expected wait = teams ahead × booths.duration_minutes.
-- * Every time the teams ahead of a student shrink, and when they are called, marked no-show or cancelled
--   by the booth, a push is queued (festival_ops.push_outbox).
-- * 예상 소요시간: booths.duration_minutes replaces the free-text program.duration ("5분 이내" → 5).
-- * Operating hours are removed: program.hours is deleted from every booth and no longer accepted.
-- * Posters: up to 5 per booth. booths.posters lists the reduced copies in the public 'festival-booths'
--   bucket; the untouched originals (up to 20 MB) sit in the private 'festival-booth-posters' bucket,
--   readable only by the uploader and operators (관리 마법사 → 부스 포스터 원본).
-- Rollback: waiting-rollback.sql.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

-- Booth info ------------------------------------------------------------------------------------------
alter table festival_ops.booths add column if not exists duration_minutes smallint;
alter table festival_ops.booths add column if not exists posters jsonb not null default '[]'::jsonb;
alter table festival_ops.booths drop constraint if exists booths_duration_range;
alter table festival_ops.booths add constraint booths_duration_range check (duration_minutes between 1 and 240);
alter table festival_ops.booths drop constraint if exists booths_posters_shape;
alter table festival_ops.booths add constraint booths_posters_shape
  check (jsonb_typeof(posters) = 'array' and jsonb_array_length(posters) <= 5);

-- "1시간 30분" → 90, "5분 이내" → 5, "10" → 10; anything else stays empty.
create or replace function festival_ops.duration_minutes_from(t text) returns smallint
language sql immutable set search_path = '' as $$
  select case when m between 1 and 240 then m::smallint end from (select
    case when t ~ '[0-9]+\s*(시간|분)' then coalesce((substring(t from '([0-9]{1,3})\s*시간'))::integer * 60, 0)
      + coalesce((substring(t from '([0-9]{1,3})\s*분'))::integer, 0)
    when btrim(t) ~ '^[0-9]{1,3}$' then btrim(t)::integer end m) x $$;

update festival_ops.booths set duration_minutes = coalesce(duration_minutes, festival_ops.duration_minutes_from(program->>'duration'))
  where program ? 'duration';
update festival_ops.booths set program = program - 'hours' - 'duration' where program ?| array['hours','duration'];

-- Hours and the old duration text are dropped silently, so a page opened before this change still saves.
create or replace function festival_ops.booth_program(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; limits constant jsonb := '{"title":80,"description":1000,"participation":300,"materials":200}';
  out jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return out; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'INVALID_INPUT'; end if;
  for k in select jsonb_object_keys(p) loop
    if k in ('hours','duration') then continue; end if;
    if not limits ? k or jsonb_typeof(p->k) <> 'string' or length(p->>k) > (limits->>k)::integer then raise exception 'INVALID_INPUT'; end if;
    if btrim(p->>k) <> '' then out := out || jsonb_build_object(k, btrim(p->>k)); end if;
  end loop;
  return out;
end $$;

-- Poster originals: never in the public catalog (to_jsonb of booths), only for the uploader and operators.
create table if not exists festival_ops.booth_poster_files (
  image text primary key,
  event_id uuid not null,
  booth_key text not null,
  original text not null unique,
  name text not null,
  size bigint,
  mime text,
  uploaded_by integer not null,
  created_at timestamptz not null default now(),
  constraint booth_poster_files_image check (image ~ '^booths/[0-9a-f]{32}\.(jpg|png|webp)$'),
  constraint booth_poster_files_original check (original ~ '^posters/[0-9a-f]{32}\.(jpg|png|webp|heic|heif)$'),
  constraint booth_poster_files_name check (length(name) between 1 and 200)
);
create index if not exists booth_poster_files_booth on festival_ops.booth_poster_files(event_id, booth_key);
alter table festival_ops.booth_poster_files enable row level security;
revoke all on festival_ops.booth_poster_files from public, anon, authenticated;

-- Waiting ---------------------------------------------------------------------------------------------
create table if not exists festival_ops.waiting_settings (
  event_id uuid not null,
  booth_key text not null,
  enabled boolean not null default false,
  online boolean not null default true,
  qr boolean not null default true,
  paused boolean not null default false,
  max_party smallint not null default 4 check (max_party between 1 and 50),
  auto_noshow boolean not null default false,
  noshow_minutes smallint not null default 5 check (noshow_minutes between 1 and 60),
  postpone_mode text not null default 'count' check (postpone_mode in ('count','last')),
  postpone_max_teams smallint not null default 3 check (postpone_max_teams between 1 and 50),
  postpone_limit smallint check (postpone_limit between 1 and 20),
  qr_mode text not null default 'fixed' check (qr_mode in ('fixed','rotating')),
  qr_period smallint not null default 30 check (qr_period between 15 and 300),
  qr_secret bytea not null default extensions.gen_random_bytes(32),
  qr_version integer not null default 1,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (event_id, booth_key)
);

create table if not exists festival_ops.waiting_counters (
  event_id uuid not null, booth_key text not null, day date not null, last_number integer not null default 0,
  primary key (event_id, booth_key, day)
);

create table if not exists festival_ops.waiting_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  booth_key text not null,
  day date not null,
  number integer not null,
  user_id integer,
  name text not null,
  student_number text,
  party smallint not null check (party between 1 and 50),
  source text not null check (source in ('online','qr','walkin')),
  status text not null default 'waiting' check (status in ('waiting','called','entered','noshow','cancelled')),
  ord bigint not null,
  postponed smallint not null default 0,
  notified_ahead integer,
  cancel_reason text check (length(cancel_reason) <= 200),
  ended_by text check (ended_by in ('user','manager','auto')),
  created_at timestamptz not null default now(),
  called_at timestamptz,
  finished_at timestamptz,
  unique (event_id, booth_key, day, number),
  check ((user_id is null) = (source = 'walkin'))
);
create unique index if not exists waiting_entries_one_active on festival_ops.waiting_entries(event_id, booth_key, user_id)
  where status in ('waiting','called') and user_id is not null;
create index if not exists waiting_entries_queue on festival_ops.waiting_entries(event_id, booth_key, ord) where status in ('waiting','called');
create index if not exists waiting_entries_user on festival_ops.waiting_entries(user_id, created_at desc);

-- Push: one row per browser subscription; queued messages per account, fanned out at delivery.
create table if not exists festival_ops.push_subscriptions (
  endpoint text primary key check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  user_id integer not null,
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists push_subscriptions_user on festival_ops.push_subscriptions(user_id);

create table if not exists festival_ops.push_outbox (
  id bigint generated always as identity primary key,
  user_id integer not null,
  entry_id uuid,
  kind text not null,
  title text not null,
  body text not null,
  url text not null,
  tag text not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts smallint not null default 0,
  sent_at timestamptz,
  result text
);
create index if not exists push_outbox_unsent on festival_ops.push_outbox(created_at) where sent_at is null;

-- VAPID public key the browsers subscribe with (waiting-push.sql fills it; the private key stays in Vault).
create table if not exists festival_ops.push_config (
  id boolean primary key default true check (id),
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{80,100}$'),
  hook_url text not null default ''
);

do $$
declare t text;
begin
  foreach t in array array['waiting_settings','waiting_counters','waiting_entries','push_subscriptions','push_outbox','push_config'] loop
    execute format('alter table festival_ops.%I enable row level security', t);
    execute format('revoke all on festival_ops.%I from public, anon, authenticated', t);
  end loop;
end $$;

create or replace function festival_ops.kst_day() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'Asia/Seoul')::date $$;

-- Delivery is asked for once per transaction; pg_net sends it after commit (waiting-push.sql).
create or replace function festival_ops.push_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare url text;
begin
  if current_setting('festival.push_kicked', true) = '1' then return; end if;
  perform set_config('festival.push_kicked', '1', true);
  select hook_url into url from festival_ops.push_config;
  if coalesce(url, '') = '' or to_regprocedure('festival_ops.push_send_hook()') is null then return; end if;
  execute 'select festival_ops.push_send_hook()';
end $$;

create or replace function festival_ops.push_enqueue(p_user integer, p_entry uuid, p_kind text, p_title text, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null then return; end if;
  insert into festival_ops.push_outbox(user_id, entry_id, kind, title, body, url, tag)
    values(p_user, p_entry, p_kind, left(p_title, 120), left(p_body, 300), '/waiting/' || p_entry, 'waiting-' || p_entry);
  perform festival_ops.push_kick();
end $$;

create or replace function festival_ops.waiting_wait_text(ahead integer, minutes smallint) returns text
language sql immutable set search_path = '' as $$
  select case when ahead <= 0 then '곧 입장' when minutes is null then '안내 없음' else '약 ' || (ahead * minutes) || '분' end $$;

-- After any change at a booth: students whose teams ahead went down get a push with the new numbers.
create or replace function festival_ops.waiting_sync(p_event uuid, p_booth text) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; total integer; minutes smallint; booth_name text;
begin
  select count(*) into total from festival_ops.waiting_entries where event_id = p_event and booth_key = p_booth and status in ('waiting','called');
  select duration_minutes, name into minutes, booth_name from festival_ops.booths where event_id = p_event and key = p_booth;
  for r in select * from (select w.id, w.user_id, w.number, w.status, w.notified_ahead,
        (row_number() over (order by w.ord))::integer - 1 ahead
      from festival_ops.waiting_entries w where w.event_id = p_event and w.booth_key = p_booth and w.status in ('waiting','called')) q
      where q.status = 'waiting' and q.notified_ahead is distinct from q.ahead loop
    if r.notified_ahead is not null and r.ahead < r.notified_ahead then
      perform festival_ops.push_enqueue(r.user_id, r.id, 'ahead', booth_name || ' 웨이팅 순서 안내',
        '대기번호 ' || r.number || '번 · 현재 대기순번 ' || (r.ahead + 1) || '번째 · 현재 대기 ' || total || '팀 · 예상 대기시간 '
        || festival_ops.waiting_wait_text(r.ahead, minutes));
    end if;
    update festival_ops.waiting_entries set notified_ahead = r.ahead where id = r.id;
  end loop;
end $$;

-- What a student sees about their own entry.
create or replace function festival_ops.waiting_entry_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', w.id, 'booth', w.booth_key, 'boothName', b.name, 'number', w.number, 'party', w.party,
    'status', w.status, 'source', w.source, 'createdAt', w.created_at, 'calledAt', w.called_at, 'finishedAt', w.finished_at,
    'cancelReason', w.cancel_reason, 'endedBy', w.ended_by, 'postponed', w.postponed,
    'position', q.ahead + 1, 'ahead', q.ahead, 'behind', q.total - q.ahead - 1, 'total', q.total,
    'durationMinutes', b.duration_minutes, 'estimateMinutes', case when q.ahead is not null and b.duration_minutes is not null then q.ahead * b.duration_minutes end,
    'noshowAt', case when w.status = 'called' and s.auto_noshow then w.called_at + make_interval(mins => s.noshow_minutes) end,
    'postpone', jsonb_build_object('mode', coalesce(s.postpone_mode, 'count'), 'maxTeams', coalesce(s.postpone_max_teams, 3),
      'limit', s.postpone_limit, 'left', case when s.postpone_limit is not null then greatest(0, s.postpone_limit - w.postponed) end,
      'allowed', w.status = 'waiting' and q.ahead <= 3 and q.total - q.ahead - 1 > 0
        and (s.postpone_limit is null or w.postponed < s.postpone_limit)))
  from festival_ops.waiting_entries w
  join festival_ops.booths b on b.event_id = w.event_id and b.key = w.booth_key
  left join festival_ops.waiting_settings s on s.event_id = w.event_id and s.booth_key = w.booth_key
  left join lateral (select (select count(*) from festival_ops.waiting_entries x where x.event_id = w.event_id and x.booth_key = w.booth_key
        and x.status in ('waiting','called') and x.ord < w.ord)::integer ahead,
      (select count(*) from festival_ops.waiting_entries x where x.event_id = w.event_id and x.booth_key = w.booth_key
        and x.status in ('waiting','called'))::integer total
    where w.status in ('waiting','called')) q on true
  where w.id = p_id $$;

-- Called teams that did not come in time are marked no-show where the booth turned that on.
create or replace function festival_ops.waiting_tick(p_event uuid, p_booth text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n integer := 0; booths text[] := '{}';
begin
  for r in select w.id, w.user_id, w.number, w.booth_key, b.name booth_name from festival_ops.waiting_entries w
      join festival_ops.waiting_settings s on s.event_id = w.event_id and s.booth_key = w.booth_key and s.auto_noshow
      join festival_ops.booths b on b.event_id = w.event_id and b.key = w.booth_key
      where w.event_id = p_event and (p_booth is null or w.booth_key = p_booth) and w.status = 'called'
        and w.called_at + make_interval(mins => s.noshow_minutes) <= now()
      for update of w skip locked loop
    update festival_ops.waiting_entries set status = 'noshow', ended_by = 'auto', finished_at = now() where id = r.id;
    perform festival_ops.push_enqueue(r.user_id, r.id, 'noshow', r.booth_name || ' 웨이팅이 취소됐어요',
      '호출 후 정해진 시간 안에 오지 않아 노쇼로 처리됐어요. 대기번호 ' || r.number || '번');
    if not r.booth_key = any(booths) then booths := booths || r.booth_key; end if;
    n := n + 1;
  end loop;
  for r in select unnest(booths) k loop perform festival_ops.waiting_sync(p_event, r.k); end loop;
  return n;
end $$;

-- QR tokens. Fixed: valid until 재발급 (qr_version). Rotating: one per window of qr_period seconds, accepted
-- for one more window plus 90 seconds so a scan that first goes through Google sign-in still works.
create or replace function festival_ops.waiting_qr_token(s festival_ops.waiting_settings, p_at bigint default null) returns text
language sql stable set search_path = '' as $$
  select case when s.qr_mode = 'fixed'
    then 'f' || s.qr_version || '.' || left(encode(extensions.hmac(convert_to('fixed:' || s.booth_key || ':' || s.qr_version, 'UTF8'), s.qr_secret, 'sha256'), 'hex'), 24)
    else 'r' || w || '.' || left(encode(extensions.hmac(convert_to('rot:' || s.booth_key || ':' || s.qr_version || ':' || w, 'UTF8'), s.qr_secret, 'sha256'), 'hex'), 24)
  end from (select coalesce(p_at, (floor(extract(epoch from now()) / s.qr_period) * s.qr_period)::bigint) w) x $$;

create or replace function festival_ops.waiting_qr_valid(s festival_ops.waiting_settings, p_token text) returns boolean
language plpgsql stable set search_path = '' as $$
declare w bigint; now_s bigint := floor(extract(epoch from now()))::bigint;
begin
  if p_token is null or length(p_token) > 60 then return false; end if;
  if s.qr_mode = 'fixed' then return p_token = festival_ops.waiting_qr_token(s); end if;
  if p_token !~ '^r[0-9]{1,12}\.[0-9a-f]{24}$' then return false; end if;
  w := substring(p_token from '^r([0-9]+)\.')::bigint;
  if w % s.qr_period <> 0 or w > now_s + 5 or w < now_s - 2 * s.qr_period - 90 then return false; end if;
  return p_token = festival_ops.waiting_qr_token(s, w);
end $$;

create or replace function festival_ops.waiting_settings_json(s festival_ops.waiting_settings) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('enabled', s.enabled, 'online', s.online, 'qr', s.qr, 'paused', s.paused, 'maxParty', s.max_party,
    'autoNoshow', s.auto_noshow, 'noshowMinutes', s.noshow_minutes, 'postponeMode', s.postpone_mode,
    'postponeMaxTeams', s.postpone_max_teams, 'postponeLimit', s.postpone_limit, 'qrMode', s.qr_mode, 'qrPeriod', s.qr_period,
    'version', s.version) $$;

create or replace function festival_ops.waiting_settings_for(p_event uuid, p_booth text) returns festival_ops.waiting_settings
language plpgsql stable set search_path = '' as $$
declare s festival_ops.waiting_settings;
begin
  select * into s from festival_ops.waiting_settings where event_id = p_event and booth_key = p_booth;
  if not found then
    s.event_id := p_event; s.booth_key := p_booth; s.enabled := false; s.online := true; s.qr := true; s.paused := false;
    s.max_party := 4; s.auto_noshow := false; s.noshow_minutes := 5; s.postpone_mode := 'count'; s.postpone_max_teams := 3;
    s.qr_mode := 'fixed'; s.qr_period := 30; s.qr_version := 1; s.version := 0;
  end if;
  return s;
end $$;

-- Queue position of a new team: after everyone active at the booth.
create or replace function festival_ops.waiting_add(p_event uuid, p_booth text, p_user integer, p_name text, p_sid text, p_party integer, p_source text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare d date := festival_ops.kst_day(); n integer; o bigint; eid uuid; ahead integer;
begin
  insert into festival_ops.waiting_counters(event_id, booth_key, day, last_number) values(p_event, p_booth, d, 1)
    on conflict (event_id, booth_key, day) do update set last_number = festival_ops.waiting_counters.last_number + 1 returning last_number into n;
  select coalesce(max(ord), 0) + 1 into o from festival_ops.waiting_entries where event_id = p_event and booth_key = p_booth;
  select count(*) into ahead from festival_ops.waiting_entries where event_id = p_event and booth_key = p_booth and status in ('waiting','called');
  insert into festival_ops.waiting_entries(event_id, booth_key, day, number, user_id, name, student_number, party, source, ord, notified_ahead)
    values(p_event, p_booth, d, n, p_user, p_name, nullif(p_sid, ''), p_party, p_source, o, ahead) returning waiting_entries.id into eid;
  return eid;
end $$;

-- Students ---------------------------------------------------------------------------------------------
create or replace function public.festival_waiting(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb; u integer; e festival_ops.events; b festival_ops.booths; s festival_ops.waiting_settings; w festival_ops.waiting_entries;
  pty integer; total integer; eid uuid; src text; ahead integer; behind integer; teams integer; ids uuid[]; ords bigint[]; i integer;
begin
  if p_action is null or p_action not in ('booth','join','mine','entry','cancel','postpone','push_key','push_subscribe','push_unsubscribe')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 4000 then
    raise exception 'INVALID_INPUT';
  end if;
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean, true) then raise exception 'PROFILE_REQUIRED'; end if;

  if p_action = 'push_key' then
    return jsonb_build_object('publicKey', (select public_key from festival_ops.push_config));
  elsif p_action = 'push_subscribe' then
    if coalesce(jsonb_typeof(p_payload->'endpoint'), '') <> 'string' or coalesce(jsonb_typeof(p_payload->'p256dh'), '') <> 'string' or coalesce(jsonb_typeof(p_payload->'auth'), '') <> 'string' then
      raise exception 'INVALID_INPUT';
    end if;
    -- A shared phone moves to whoever subscribed last.
    insert into festival_ops.push_subscriptions(endpoint, user_id, p256dh, auth) values(p_payload->>'endpoint', u, p_payload->>'p256dh', p_payload->>'auth')
      on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
    return jsonb_build_object('subscribed', true);
  elsif p_action = 'push_unsubscribe' then
    delete from festival_ops.push_subscriptions where endpoint = p_payload->>'endpoint' and user_id = u;
    return jsonb_build_object('subscribed', false);
  end if;

  select * into e from festival_ops.events where current;
  if e.id is null then
    if p_action = 'mine' then return jsonb_build_object('items', '[]'::jsonb); end if;
    raise exception 'OPS_NOT_READY';
  end if;

  if p_action = 'mine' then
    return jsonb_build_object('items', coalesce((select jsonb_agg(festival_ops.waiting_entry_json(x.id) order by x.active desc, x.created_at desc)
      from (select w2.id, w2.created_at, w2.status in ('waiting','called') active from festival_ops.waiting_entries w2
        where w2.event_id = e.id and w2.user_id = u and (w2.status in ('waiting','called') or w2.finished_at > now() - interval '12 hours')
        order by active desc, w2.created_at desc limit 20) x), '[]'::jsonb));
  end if;

  if p_action in ('entry','cancel','postpone') then
    if coalesce(p_payload->>'id', '') !~ '^[0-9a-f-]{36}$' then raise exception 'INVALID_INPUT'; end if;
    select booth_key into b.key from festival_ops.waiting_entries where waiting_entries.id = (p_payload->>'id')::uuid and user_id = u and event_id = e.id;
    if b.key is null then raise exception 'WAITING_NOT_FOUND'; end if;
    if p_action = 'entry' then return festival_ops.waiting_entry_json((p_payload->>'id')::uuid); end if;
    perform pg_catalog.pg_advisory_xact_lock(170927, hashtext(b.key));
    select * into w from festival_ops.waiting_entries where waiting_entries.id = (p_payload->>'id')::uuid for update;
    if w.status not in ('waiting','called') then raise exception 'WAITING_FINISHED'; end if;
    if p_action = 'cancel' then
      update festival_ops.waiting_entries set status = 'cancelled', ended_by = 'user', finished_at = now() where waiting_entries.id = w.id;
      perform festival_ops.waiting_sync(e.id, w.booth_key);
      return festival_ops.waiting_entry_json(w.id);
    end if;
    -- 순서 미루기: only while waiting and at most 3 teams ahead.
    s := festival_ops.waiting_settings_for(e.id, w.booth_key);
    select array_agg(x.id order by x.ord), array_agg(x.ord order by x.ord) into ids, ords
      from festival_ops.waiting_entries x where x.event_id = e.id and x.booth_key = w.booth_key and x.status in ('waiting','called');
    ahead := array_position(ids, w.id) - 1; total := cardinality(ids); behind := total - ahead - 1;
    if w.status <> 'waiting' or ahead > 3 then raise exception 'WAITING_POSTPONE_NOT_YET'; end if;
    if behind < 1 then raise exception 'WAITING_POSTPONE_LAST'; end if;
    if s.postpone_limit is not null and w.postponed >= s.postpone_limit then raise exception 'WAITING_POSTPONE_LIMIT'; end if;
    if s.postpone_mode = 'last' then teams := behind;
    else
      teams := case when coalesce(jsonb_typeof(p_payload->'teams'), '') = 'number' and p_payload->>'teams' ~ '^[0-9]{1,2}$' then (p_payload->>'teams')::integer end;
      if teams is null or teams < 1 or teams > s.postpone_max_teams then raise exception 'INVALID_INPUT'; end if;
      teams := least(teams, behind);
    end if;
    -- The teams passed over take one step forward; this entry takes the last of their places.
    for i in 1..teams loop
      update festival_ops.waiting_entries set ord = ords[ahead + i] where waiting_entries.id = ids[ahead + 1 + i];
    end loop;
    update festival_ops.waiting_entries set ord = ords[ahead + 1 + teams], postponed = postponed + 1, notified_ahead = ahead + teams where waiting_entries.id = w.id;
    perform festival_ops.waiting_sync(e.id, w.booth_key);
    return jsonb_build_object('from', ahead + 1, 'to', ahead + 1 + teams, 'entry', festival_ops.waiting_entry_json(w.id));
  end if;

  if coalesce(p_payload->>'booth', '') = '' then raise exception 'INVALID_INPUT'; end if;
  select * into b from festival_ops.booths where event_id = e.id and key = p_payload->>'booth';
  if b.key is null then raise exception 'NOT_FOUND'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170927, hashtext(b.key));
  perform festival_ops.waiting_tick(e.id, b.key);
  s := festival_ops.waiting_settings_for(e.id, b.key);
  select count(*) into total from festival_ops.waiting_entries where event_id = e.id and booth_key = b.key and status in ('waiting','called');
  select x.id into eid from festival_ops.waiting_entries x where x.event_id = e.id and x.booth_key = b.key and x.user_id = u and x.status in ('waiting','called');

  if p_action = 'booth' then
    return jsonb_build_object('booth', b.key, 'enabled', s.enabled, 'online', s.online, 'qr', s.qr, 'paused', s.paused,
      'accepting', s.enabled and not s.paused, 'maxParty', s.max_party, 'durationMinutes', b.duration_minutes, 'total', total,
      'estimateMinutes', case when b.duration_minutes is not null then total * b.duration_minutes end,
      'mine', case when eid is not null then festival_ops.waiting_entry_json(eid) end);
  end if;

  -- join
  if eid is not null then return festival_ops.waiting_entry_json(eid) || jsonb_build_object('already', true); end if;
  if not s.enabled then raise exception 'WAITING_DISABLED'; end if;
  if s.paused then raise exception 'WAITING_PAUSED'; end if;
  if p_payload ? 'qr' then
    if not s.qr then raise exception 'WAITING_QR_DISABLED'; end if;
    if coalesce(jsonb_typeof(p_payload->'qr'), '') <> 'string' or not festival_ops.waiting_qr_valid(s, p_payload->>'qr') then raise exception 'WAITING_QR_INVALID'; end if;
    src := 'qr';
  else
    if not s.online then raise exception 'WAITING_ONLINE_DISABLED'; end if;
    src := 'online';
  end if;
  pty := case when coalesce(jsonb_typeof(p_payload->'party'), '') = 'number' and p_payload->>'party' ~ '^[0-9]{1,2}$' then (p_payload->>'party')::integer end;
  if pty is null or pty < 1 then raise exception 'INVALID_INPUT'; end if;
  if pty > s.max_party then raise exception 'WAITING_PARTY_LIMIT'; end if;
  eid := festival_ops.waiting_add(e.id, b.key, u, me->>'name', me->>'studentNumber', pty, src);
  return festival_ops.waiting_entry_json(eid);
end $$;
revoke all on function public.festival_waiting(text, jsonb) from public, anon, authenticated;
grant execute on function public.festival_waiting(text, jsonb) to authenticated;

-- Booth managers and operators -------------------------------------------------------------------------
create or replace function public.festival_waiting_manage(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb; u integer; admin boolean; e festival_ops.events; b festival_ops.booths; s festival_ops.waiting_settings; w festival_ops.waiting_entries;
  booth text; why text; pty integer; nm text; mins smallint; eid uuid; t text;
begin
  if p_action is null or p_action not in ('board','settings','pause','call','enter','noshow','cancel','walkin','qr','qr_reissue')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 4000 then
    raise exception 'INVALID_INPUT';
  end if;
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean, true) then raise exception 'PROFILE_REQUIRED'; end if;
  admin := coalesce((me->>'isAdmin')::boolean, false);
  select * into e from festival_ops.events where current;
  if e.id is null then raise exception 'OPS_NOT_READY'; end if;

  if p_action in ('call','enter','noshow','cancel') then
    if coalesce(p_payload->>'id', '') !~ '^[0-9a-f-]{36}$' then raise exception 'INVALID_INPUT'; end if;
    select booth_key into booth from festival_ops.waiting_entries where id = (p_payload->>'id')::uuid and event_id = e.id;
    if booth is null then raise exception 'WAITING_NOT_FOUND'; end if;
  else
    booth := p_payload->>'booth';
  end if;
  if not exists(select 1 from festival_ops.managed_booths(e.id, u, admin) m where m.booth_key = booth) then raise exception 'BOOTH_MANAGER_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(170927, hashtext(booth));
  select * into b from festival_ops.booths where event_id = e.id and key = booth;
  perform festival_ops.waiting_tick(e.id, booth);
  s := festival_ops.waiting_settings_for(e.id, booth);

  if p_action = 'board' then
    return jsonb_build_object('booth', jsonb_build_object('key', b.key, 'name', b.name, 'durationMinutes', b.duration_minutes, 'version', b.version),
      'settings', festival_ops.waiting_settings_json(s), 'serverTime', now(),
      'active', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'number', x.number, 'name', x.name, 'studentNumber', x.student_number,
          'party', x.party, 'status', x.status, 'source', x.source, 'createdAt', x.created_at, 'calledAt', x.called_at, 'postponed', x.postponed,
          'noshowAt', case when x.status = 'called' and s.auto_noshow then x.called_at + make_interval(mins => s.noshow_minutes) end) order by x.ord)
        from festival_ops.waiting_entries x where x.event_id = e.id and x.booth_key = booth and x.status in ('waiting','called')), '[]'::jsonb),
      'done', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'number', x.number, 'name', x.name, 'studentNumber', x.student_number,
          'party', x.party, 'status', x.status, 'source', x.source, 'createdAt', x.created_at, 'finishedAt', x.finished_at,
          'endedBy', x.ended_by, 'cancelReason', x.cancel_reason) order by x.finished_at desc)
        from (select * from festival_ops.waiting_entries y where y.event_id = e.id and y.booth_key = booth and y.status not in ('waiting','called')
          and y.day = festival_ops.kst_day() order by y.finished_at desc limit 200) x), '[]'::jsonb),
      'counts', (select jsonb_build_object('waiting', count(*) filter (where status = 'waiting'), 'called', count(*) filter (where status = 'called'),
          'entered', count(*) filter (where status = 'entered' and day = festival_ops.kst_day()),
          'noshow', count(*) filter (where status = 'noshow' and day = festival_ops.kst_day()),
          'cancelled', count(*) filter (where status = 'cancelled' and day = festival_ops.kst_day()),
          'people', coalesce(sum(party) filter (where status in ('waiting','called')), 0))
        from festival_ops.waiting_entries where event_id = e.id and booth_key = booth));
  end if;

  if p_action in ('settings','pause') then
    if p_action = 'settings' then
      if (p_payload->>'version')::integer is distinct from s.version then raise exception 'VERSION_CONFLICT'; end if;
      if exists(select 1 from unnest(array['enabled','online','qr','autoNoshow']) k where coalesce(jsonb_typeof(p_payload->k), '') <> 'boolean')
        or exists(select 1 from unnest(array['maxParty','noshowMinutes','postponeMaxTeams','qrPeriod']) k where coalesce(jsonb_typeof(p_payload->k), '') <> 'number' or p_payload->>k !~ '^[0-9]{1,3}$')
        or p_payload->>'postponeMode' not in ('count','last') or p_payload->>'qrMode' not in ('fixed','rotating')
        or not (coalesce(jsonb_typeof(p_payload->'postponeLimit'), '') = 'null' or (coalesce(jsonb_typeof(p_payload->'postponeLimit'), '') = 'number' and p_payload->>'postponeLimit' ~ '^[0-9]{1,2}$'))
        or not (coalesce(jsonb_typeof(p_payload->'durationMinutes'), '') = 'null' or (coalesce(jsonb_typeof(p_payload->'durationMinutes'), '') = 'number' and p_payload->>'durationMinutes' ~ '^[0-9]{1,3}$')) then
        raise exception 'INVALID_INPUT';
      end if;
      insert into festival_ops.waiting_settings(event_id, booth_key, enabled, online, qr, max_party, auto_noshow, noshow_minutes,
          postpone_mode, postpone_max_teams, postpone_limit, qr_mode, qr_period)
        values(e.id, booth, (p_payload->>'enabled')::boolean, (p_payload->>'online')::boolean, (p_payload->>'qr')::boolean,
          (p_payload->>'maxParty')::integer, (p_payload->>'autoNoshow')::boolean, (p_payload->>'noshowMinutes')::integer,
          p_payload->>'postponeMode', (p_payload->>'postponeMaxTeams')::integer, (p_payload->>'postponeLimit')::integer,
          p_payload->>'qrMode', (p_payload->>'qrPeriod')::integer)
        on conflict (event_id, booth_key) do update set enabled = excluded.enabled, online = excluded.online, qr = excluded.qr,
          max_party = excluded.max_party, auto_noshow = excluded.auto_noshow, noshow_minutes = excluded.noshow_minutes,
          postpone_mode = excluded.postpone_mode, postpone_max_teams = excluded.postpone_max_teams, postpone_limit = excluded.postpone_limit,
          qr_mode = excluded.qr_mode, qr_period = excluded.qr_period, version = festival_ops.waiting_settings.version + 1, updated_at = now();
      mins := (p_payload->>'durationMinutes')::smallint;
      if mins is not null and mins not between 1 and 240 then raise exception 'INVALID_INPUT'; end if;
      if mins is distinct from b.duration_minutes then
        update festival_ops.booths set duration_minutes = mins, version = version + 1 where event_id = e.id and key = booth;
      end if;
      t := 'waiting_settings_save';
    else
      if coalesce(jsonb_typeof(p_payload->'paused'), '') <> 'boolean' then raise exception 'INVALID_INPUT'; end if;
      insert into festival_ops.waiting_settings(event_id, booth_key, paused) values(e.id, booth, (p_payload->>'paused')::boolean)
        on conflict (event_id, booth_key) do update set paused = excluded.paused, version = festival_ops.waiting_settings.version + 1, updated_at = now();
      t := 'waiting_pause';
    end if;
    s := festival_ops.waiting_settings_for(e.id, booth);
    insert into festival_ops.audit(event_id, actor_id, action, target, reason) values(e.id, u, t, booth,
      case when s.enabled then '사용' else '사용 안 함' end || case when s.paused then ' · 일시 중단' else '' end
      || ' · 온라인 ' || case when s.online then '켜짐' else '꺼짐' end || ' · 현장 QR ' || case when s.qr then '켜짐' else '꺼짐' end);
    return jsonb_build_object('settings', festival_ops.waiting_settings_json(s), 'durationMinutes', (select duration_minutes from festival_ops.booths where event_id = e.id and key = booth));
  end if;

  if p_action in ('qr','qr_reissue') then
    if p_action = 'qr_reissue' then
      insert into festival_ops.waiting_settings(event_id, booth_key) values(e.id, booth) on conflict do nothing;
      update festival_ops.waiting_settings set qr_version = qr_version + 1, qr_secret = extensions.gen_random_bytes(32), updated_at = now()
        where event_id = e.id and booth_key = booth;
      s := festival_ops.waiting_settings_for(e.id, booth);
      insert into festival_ops.audit(event_id, actor_id, action, target, reason) values(e.id, u, 'waiting_qr_reissue', booth, 'QR ' || s.qr_version || '번째');
    elsif s.version = 0 then
      -- The secret must exist before a QR is shown.
      insert into festival_ops.waiting_settings(event_id, booth_key) values(e.id, booth) on conflict do nothing;
      s := festival_ops.waiting_settings_for(e.id, booth);
    end if;
    return jsonb_build_object('mode', s.qr_mode, 'token', festival_ops.waiting_qr_token(s), 'version', s.qr_version, 'period', s.qr_period,
      'expiresAt', case when s.qr_mode = 'rotating' then to_timestamp((floor(extract(epoch from now()) / s.qr_period) + 1) * s.qr_period) end,
      'serverTime', now(), 'enabled', s.enabled, 'qr', s.qr);
  end if;

  if p_action = 'walkin' then
    nm := btrim(coalesce(p_payload->>'name', ''));
    pty := case when coalesce(jsonb_typeof(p_payload->'party'), '') = 'number' and p_payload->>'party' ~ '^[0-9]{1,2}$' then (p_payload->>'party')::integer end;
    if length(nm) not between 1 and 30 or nm ~ '[[:cntrl:]]' or pty is null or pty < 1 then raise exception 'INVALID_INPUT'; end if;
    if pty > s.max_party then raise exception 'WAITING_PARTY_LIMIT'; end if;
    eid := festival_ops.waiting_add(e.id, booth, null, nm, null, pty, 'walkin');
    insert into festival_ops.audit(event_id, actor_id, action, target, reason) values(e.id, u, 'waiting_walkin', booth, nm || ' · ' || pty || '명');
    return jsonb_build_object('id', eid, 'number', (select number from festival_ops.waiting_entries where waiting_entries.id = eid));
  end if;

  select * into w from festival_ops.waiting_entries where waiting_entries.id = (p_payload->>'id')::uuid for update;
  if p_action = 'call' then
    if w.status <> 'waiting' then raise exception 'WAITING_FINISHED'; end if;
    update festival_ops.waiting_entries set status = 'called', called_at = now() where waiting_entries.id = w.id;
    perform festival_ops.push_enqueue(w.user_id, w.id, 'called', b.name || ' 입장할 차례예요',
      '대기번호 ' || w.number || '번 · 지금 부스로 와 주세요.'
      || case when s.auto_noshow then ' ' || s.noshow_minutes || '분 안에 오지 않으면 웨이팅이 취소돼요.' else '' end);
  elsif p_action = 'enter' then
    if w.status not in ('waiting','called') then raise exception 'WAITING_FINISHED'; end if;
    update festival_ops.waiting_entries set status = 'entered', ended_by = 'manager', finished_at = now() where waiting_entries.id = w.id;
  elsif p_action = 'noshow' then
    if w.status not in ('waiting','called') then raise exception 'WAITING_FINISHED'; end if;
    update festival_ops.waiting_entries set status = 'noshow', ended_by = 'manager', finished_at = now() where waiting_entries.id = w.id;
    perform festival_ops.push_enqueue(w.user_id, w.id, 'noshow', b.name || ' 웨이팅이 취소됐어요',
      '호출에 응답이 없어 노쇼로 처리됐어요. 대기번호 ' || w.number || '번');
    insert into festival_ops.audit(event_id, actor_id, action, target, reason) values(e.id, u, 'waiting_noshow', booth, w.number || '번');
  else
    why := btrim(coalesce(p_payload->>'reason', ''));
    if length(why) not between 1 and 200 or why ~ '[[:cntrl:]]' then raise exception 'INVALID_INPUT'; end if;
    if w.status not in ('waiting','called') then raise exception 'WAITING_FINISHED'; end if;
    update festival_ops.waiting_entries set status = 'cancelled', ended_by = 'manager', cancel_reason = why, finished_at = now() where waiting_entries.id = w.id;
    perform festival_ops.push_enqueue(w.user_id, w.id, 'cancelled', b.name || ' 웨이팅이 취소됐어요', '취소 사유: ' || why);
    insert into festival_ops.audit(event_id, actor_id, action, target, reason) values(e.id, u, 'waiting_cancel', booth, w.number || '번 · ' || why);
  end if;
  perform festival_ops.waiting_sync(e.id, booth);
  return jsonb_build_object('id', w.id, 'status', (select status from festival_ops.waiting_entries where waiting_entries.id = w.id));
end $$;
revoke all on function public.festival_waiting_manage(text, jsonb) from public, anon, authenticated;
grant execute on function public.festival_waiting_manage(text, jsonb) to authenticated;

-- Booth manager save: + durationMinutes and posters; operating hours are gone ---------------------------
create or replace function festival_ops.booth_manager_item(b festival_ops.booths, approve boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('key', b.key, 'name', b.name, 'location', b.location, 'floor', b.floor, 'room', b.room, 'image', b.image,
    'status', b.status, 'description', b.description, 'program', b.program, 'version', b.version, 'canApprove', approve,
    'durationMinutes', b.duration_minutes,
    'posters', coalesce((select jsonb_agg(jsonb_build_object('image', p.value, 'name', f.name, 'size', f.size) order by p.ordinality)
      from jsonb_array_elements_text(b.posters) with ordinality p left join festival_ops.booth_poster_files f on f.image = p.value), '[]'::jsonb)) $$;

create or replace function public.festival_booth_manager(p_action text, p_payload jsonb, p_request_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me jsonb; u integer; admin boolean; e festival_ops.events; b festival_ops.booths; approve boolean;
  sid text; target integer; why text; changed integer; old festival_ops.requests; fp bytea; result jsonb; n integer;
  loc text; fl integer; rm text; img text; mins smallint; plist jsonb; item jsonb; removed text[] := '{}'; osize bigint; omime text;
begin
  if p_action is null or p_action not in ('status','save','lookup','visit_approve')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 8000 then
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
    return jsonb_build_object('isAdmin', admin, 'items', coalesce((select jsonb_agg(festival_ops.booth_manager_item(x, m.can_approve)
        || jsonb_build_object('waiting', (select s.enabled from festival_ops.waiting_settings s where s.event_id = e.id and s.booth_key = x.key))
        order by x.floor, x.name)
      from festival_ops.managed_booths(e.id, u, admin) m join festival_ops.booths x on x.event_id = e.id and x.key = m.booth_key), '[]'::jsonb));
  end if;

  select m.can_approve into approve from festival_ops.managed_booths(e.id, u, admin) m where m.booth_key = p_payload->>'booth';
  if approve is null then raise exception 'BOOTH_MANAGER_REQUIRED'; end if;
  select * into b from festival_ops.booths where event_id = e.id and key = p_payload->>'booth' for update;

  if p_action = 'save' then
    if (p_payload->>'version')::integer is distinct from b.version then raise exception 'VERSION_CONFLICT'; end if;
    if p_payload->>'status' not in ('open','paused','closed') or length(coalesce(p_payload->>'description', '')) > 2000
      or (p_payload ? 'floor' and (coalesce(jsonb_typeof(p_payload->'floor'), '') <> 'number' or p_payload->>'floor' !~ '^[1-4]$'))
      or exists(select 1 from unnest(array['location','room','image']) k where p_payload ? k and coalesce(jsonb_typeof(p_payload->k), '') <> 'string')
      or (p_payload ? 'durationMinutes' and not (coalesce(jsonb_typeof(p_payload->'durationMinutes'), '') = 'null'
        or (coalesce(jsonb_typeof(p_payload->'durationMinutes'), '') = 'number' and p_payload->>'durationMinutes' ~ '^[0-9]{1,3}$')))
      or (p_payload ? 'posters' and case when jsonb_typeof(p_payload->'posters') = 'array' then jsonb_array_length(p_payload->'posters') > 5 else true end) then
      raise exception 'INVALID_INPUT';
    end if;
    loc := case when p_payload ? 'location' then btrim(p_payload->>'location') else b.location end;
    rm := case when p_payload ? 'room' then btrim(p_payload->>'room') else b.room end;
    img := case when p_payload ? 'image' then p_payload->>'image' else b.image end;
    fl := case when p_payload ? 'floor' then (p_payload->>'floor')::integer else b.floor end;
    mins := case when p_payload ? 'durationMinutes' then (p_payload->>'durationMinutes')::smallint else b.duration_minutes end;
    if length(loc) > 200 or length(rm) > 40 or loc ~ '[[:cntrl:]]' or rm ~ '[[:cntrl:]]' or fl not between 1 and 4
      or (img <> '' and img !~ '^booths/[0-9a-f]{32}\.(jpg|png|webp)$') or mins not between 1 and 240 then
      raise exception 'INVALID_INPUT';
    end if;
    if img <> '' and img <> b.image and to_regclass('storage.objects') is not null then
      if not exists(select 1 from storage.objects o where o.bucket_id = 'festival-booths' and o.name = img
        and (admin or o.owner_id = (select auth.uid())::text)) then
        raise exception 'BOOTH_IMAGE_NOT_FOUND';
      end if;
    end if;

    -- Posters: [{image, original, name}] in display order. A poster already on the booth only needs its image.
    plist := b.posters;
    if p_payload ? 'posters' then
      plist := '[]'::jsonb;
      for item in select value from jsonb_array_elements(p_payload->'posters') loop
        if jsonb_typeof(item) <> 'object' or coalesce(jsonb_typeof(item->'image'), '') <> 'string' or item->>'image' !~ '^booths/[0-9a-f]{32}\.(jpg|png|webp)$'
          or plist ? (item->>'image') or item->>'image' = img then
          raise exception 'INVALID_INPUT';
        end if;
        if not b.posters ? (item->>'image') then
          if coalesce(jsonb_typeof(item->'original'), '') <> 'string' or item->>'original' !~ '^posters/[0-9a-f]{32}\.(jpg|png|webp|heic|heif)$'
            or coalesce(jsonb_typeof(item->'name'), '') <> 'string' or length(btrim(item->>'name')) not between 1 and 200 or item->>'name' ~ '[[:cntrl:]]' then
            raise exception 'INVALID_INPUT';
          end if;
          if to_regclass('storage.objects') is not null then
            if not exists(select 1 from storage.objects o where o.bucket_id = 'festival-booths' and o.name = item->>'image'
                and (admin or o.owner_id = (select auth.uid())::text)) then raise exception 'BOOTH_IMAGE_NOT_FOUND'; end if;
            select (o.metadata->>'size')::bigint, o.metadata->>'mimetype' into osize, omime from storage.objects o where o.bucket_id = 'festival-booth-posters' and o.name = item->>'original'
              and (admin or o.owner_id = (select auth.uid())::text);
            if not found then raise exception 'BOOTH_IMAGE_NOT_FOUND'; end if;
          end if;
          insert into festival_ops.booth_poster_files(image, event_id, booth_key, original, name, size, mime, uploaded_by)
            values(item->>'image', e.id, b.key, item->>'original', btrim(item->>'name'),
              osize, omime, u);
        end if;
        plist := plist || to_jsonb(item->>'image');
      end loop;
      select coalesce(array_agg(f.original), '{}') into removed from festival_ops.booth_poster_files f
        where f.event_id = e.id and f.booth_key = b.key and not plist ? f.image;
      delete from festival_ops.booth_poster_files f where f.event_id = e.id and f.booth_key = b.key and not plist ? f.image;
    end if;

    update festival_ops.booths set status = p_payload->>'status', description = btrim(coalesce(p_payload->>'description', '')),
      program = festival_ops.booth_program(p_payload->'program'), location = loc, floor = fl, room = rm, image = img,
      duration_minutes = mins, posters = plist, version = version + 1
      where event_id = e.id and key = b.key returning * into b;
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values(e.id, u, case when admin then 'booth_info_save' else 'booth_manager_save' end, b.key,
        b.status || ' · ' || b.floor || '층' || case when b.room <> '' then ' ' || b.room else '' end
        || ' · 포스터 ' || jsonb_array_length(b.posters) || '장');
    -- removedPosters: originals taken off the booth, for the client to delete from Storage.
    return festival_ops.booth_manager_item(b, approve) || jsonb_build_object('removedPosters', to_jsonb(removed));
  end if;

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
  insert into festival_ops.audit(event_id, actor_id, action, target, reason)
    values(e.id, u, 'booth_manager_visit', target::text, b.key || ' · ' || why);
  result := jsonb_build_object('result', case when changed = 0 then 'ALREADY_EARNED' else 'EARNED' end, 'booth', b.key);
  insert into festival_ops.requests(actor_id, request_id, fingerprint, response) values(u, p_request_id, fp, result);
  return result;
end $$;
revoke all on function public.festival_booth_manager(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.festival_booth_manager(text, jsonb, uuid) to authenticated;

-- 관리 마법사 → 부스 포스터 원본 (operators): every booth's posters with the original's path and file name.
create or replace function public.festival_booth_posters_admin() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb; e festival_ops.events;
begin
  me := festival_nfc_private.current_profile();
  if not coalesce((me->>'isAdmin')::boolean, false) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into e from festival_ops.events where current;
  if e.id is null then return jsonb_build_object('items', '[]'::jsonb); end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('key', b.key, 'name', b.name, 'posters',
      (select coalesce(jsonb_agg(jsonb_build_object('image', p.value, 'original', f.original, 'name', f.name, 'size', f.size, 'mime', f.mime,
        'uploadedAt', f.created_at) order by p.ordinality), '[]'::jsonb)
        from jsonb_array_elements_text(b.posters) with ordinality p left join festival_ops.booth_poster_files f on f.image = p.value))
      order by b.floor, b.name) from festival_ops.booths b where b.event_id = e.id and jsonb_array_length(b.posters) > 0), '[]'::jsonb));
end $$;
revoke all on function public.festival_booth_posters_admin() from public, anon, authenticated;
grant execute on function public.festival_booth_posters_admin() to authenticated;

-- Account deletion also removes the account's waiting entries and push subscriptions.
do $$
declare d text; patched text;
begin
  if to_regprocedure('public.festival_account_delete(jsonb,uuid)') is null then return; end if;
  d := pg_get_functiondef('public.festival_account_delete(jsonb,uuid)'::regprocedure);
  if d ~ 'festival_ops\.waiting_entries' then return; end if;
  patched := regexp_replace(d, '(delete from festival_ops\.requests where actor_id=target;)',
    E'\\1\n  delete from festival_ops.waiting_entries where user_id=target;\n  delete from festival_ops.push_subscriptions where user_id=target;\n  delete from festival_ops.push_outbox where user_id=target;');
  if patched = d then raise exception 'ACCOUNT_DELETE_PATCH_FAILED'; end if;
  execute patched;
end $$;

-- Storage: poster originals (private, up to 20 MB). Isolated test databases skip this part.
do $$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    values('festival-booth-posters', 'festival-booth-posters', false, 20971520, array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
    on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  execute 'drop policy if exists festival_booth_posters_insert on storage.objects';
  execute 'drop policy if exists festival_booth_posters_select on storage.objects';
  execute 'drop policy if exists festival_booth_posters_delete on storage.objects';
  execute $p$create policy festival_booth_posters_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'festival-booth-posters' and name ~ '^posters/[0-9a-f]{32}\.(jpg|png|webp|heic|heif)$' and public.festival_can_upload_booth_image())$p$;
  execute $p$create policy festival_booth_posters_select on storage.objects for select to authenticated
    using (bucket_id = 'festival-booth-posters' and (owner_id = (select auth.uid())::text or public.festival_is_operator()))$p$;
  execute $p$create policy festival_booth_posters_delete on storage.objects for delete to authenticated
    using (bucket_id = 'festival-booth-posters' and (owner_id = (select auth.uid())::text or public.festival_is_operator()))$p$;
end $$;

notify pgrst,'reload schema';
commit;

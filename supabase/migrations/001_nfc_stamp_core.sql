begin;

create extension if not exists pgcrypto with schema extensions;
create schema if not exists festival;

create table if not exists festival.events (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft', 'rehearsal', 'active', 'paused', 'closed')),
  emergency_mode boolean not null default false,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(slug) between 2 and 80),
  check (char_length(name) between 1 and 120),
  check (ends_at > starts_at)
);

create table if not exists festival.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(display_name) between 1 and 80)
);

create table if not exists festival.event_memberships (
  event_id uuid not null references festival.events(id) on delete cascade,
  user_id uuid not null references festival.profiles(id) on delete cascade,
  role text not null default 'student'
    check (role in ('student', 'operator', 'supervisor', 'admin')),
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table if not exists festival.booths (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id uuid not null references festival.events(id) on delete cascade,
  code text not null,
  name text not null,
  floor smallint not null check (floor between 1 and 4),
  room text not null,
  status text not null default 'preparing'
    check (status in ('preparing', 'open', 'crowded', 'paused', 'closed')),
  opens_at timestamptz,
  closes_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, code),
  unique (event_id, id),
  check (char_length(code) between 1 and 40),
  check (char_length(name) between 1 and 120),
  check (char_length(room) between 1 and 80),
  check (closes_at is null or opens_at is null or closes_at > opens_at)
);

create table if not exists festival.nfc_tags (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id uuid not null,
  booth_id uuid not null,
  tag_code text not null,
  token_digest bytea not null unique,
  version integer not null default 1 check (version > 0),
  active boolean not null default true,
  activated_at timestamptz not null default now(),
  expires_at timestamptz,
  rotated_at timestamptz,
  disabled_reason text,
  created_by uuid references festival.profiles(id),
  created_at timestamptz not null default now(),
  unique (event_id, tag_code),
  unique (event_id, booth_id, id),
  constraint nfc_tags_booth_fk
    foreign key (event_id, booth_id)
    references festival.booths(event_id, id)
    on delete cascade,
  check (char_length(tag_code) between 1 and 80),
  check (octet_length(token_digest) = 32),
  check (expires_at is null or expires_at > activated_at),
  check (disabled_reason is null or char_length(disabled_reason) between 1 and 300)
);

create unique index if not exists nfc_tags_one_active_per_booth
  on festival.nfc_tags(event_id, booth_id)
  where active;

create table if not exists festival.stamps (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id uuid not null,
  user_id uuid not null,
  booth_id uuid not null,
  method text not null check (method in ('nfc', 'manual')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  source_tag_id uuid,
  approved_by uuid references festival.profiles(id),
  approval_reason text,
  earned_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references festival.profiles(id),
  revocation_reason text,
  created_at timestamptz not null default now(),
  constraint stamps_membership_fk
    foreign key (event_id, user_id)
    references festival.event_memberships(event_id, user_id),
  constraint stamps_booth_fk
    foreign key (event_id, booth_id)
    references festival.booths(event_id, id),
  constraint stamps_source_tag_fk
    foreign key (event_id, booth_id, source_tag_id)
    references festival.nfc_tags(event_id, booth_id, id),
  check (
    (method = 'nfc' and source_tag_id is not null and approved_by is null and approval_reason is null)
    or
    (method = 'manual' and source_tag_id is null and approved_by is not null
      and char_length(trim(approval_reason)) between 10 and 300)
  ),
  check (
    (status = 'active' and revoked_at is null and revoked_by is null and revocation_reason is null)
    or
    (status = 'revoked' and revoked_at is not null and revoked_by is not null
      and char_length(trim(revocation_reason)) between 10 and 300)
  )
);

create unique index if not exists stamps_one_active_visit
  on festival.stamps(event_id, user_id, booth_id)
  where status = 'active';

create index if not exists stamps_user_event_earned_at
  on festival.stamps(user_id, event_id, earned_at desc);

create table if not exists festival.stamp_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id uuid,
  user_id uuid,
  booth_id uuid,
  tag_id uuid,
  result_code text not null,
  request_id uuid not null,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  check (char_length(result_code) between 2 and 80)
);

create index if not exists stamp_attempts_request_id
  on festival.stamp_attempts(request_id);

create index if not exists stamp_attempts_actor_created_at
  on festival.stamp_attempts(user_id, created_at desc);

create table if not exists festival.idempotency_records (
  actor_id uuid not null,
  scope text not null,
  idempotency_key uuid not null,
  request_digest bytea not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (actor_id, scope, idempotency_key),
  check (octet_length(request_digest) = 32),
  check (char_length(scope) between 2 and 80),
  check ((response_status is null) = (response_body is null)),
  check (response_status is null or response_status between 100 and 599),
  check (expires_at > created_at)
);

create index if not exists idempotency_records_expires_at
  on festival.idempotency_records(expires_at);

create table if not exists festival.audit_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id uuid not null references festival.events(id),
  actor_id uuid not null references festival.profiles(id),
  action text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (char_length(action) between 2 and 120),
  check (char_length(target_type) between 2 and 80)
);

create index if not exists audit_logs_event_created_at
  on festival.audit_logs(event_id, created_at desc);

alter table festival.events enable row level security;
alter table festival.profiles enable row level security;
alter table festival.event_memberships enable row level security;
alter table festival.booths enable row level security;
alter table festival.nfc_tags enable row level security;
alter table festival.stamps enable row level security;
alter table festival.stamp_attempts enable row level security;
alter table festival.idempotency_records enable row level security;
alter table festival.audit_logs enable row level security;

revoke all on schema festival from anon, authenticated;
revoke all on all tables in schema festival from anon, authenticated;
revoke all on all sequences in schema festival from anon, authenticated;

create or replace function public.claim_nfc_stamp(
  p_event_id uuid,
  p_actor_id uuid,
  p_token_digest_hex text,
  p_idempotency_key uuid,
  p_request_digest_hex text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_scope text := 'stamp:nfc';
  v_token_digest bytea;
  v_request_digest bytea;
  v_existing_digest bytea;
  v_existing_status integer;
  v_existing_body jsonb;
  v_event_status text;
  v_emergency_mode boolean;
  v_event_starts_at timestamptz;
  v_event_ends_at timestamptz;
  v_membership_active boolean;
  v_membership_expires_at timestamptz;
  v_tag_id uuid;
  v_tag_active boolean;
  v_tag_activated_at timestamptz;
  v_tag_expires_at timestamptz;
  v_booth_id uuid;
  v_booth_status text;
  v_booth_opens_at timestamptz;
  v_booth_closes_at timestamptz;
  v_stamp_id uuid;
  v_stamp_method text;
  v_earned_at timestamptz;
  v_created boolean := false;
  v_status integer;
  v_code text;
  v_message text;
  v_retryable boolean := false;
  v_result text;
  v_body jsonb;
begin
  if p_event_id is null or p_actor_id is null or p_idempotency_key is null or p_request_id is null
    or p_token_digest_hex !~ '^[0-9a-fA-F]{64}$'
    or p_request_digest_hex !~ '^[0-9a-fA-F]{64}$' then
    v_body := jsonb_build_object(
      'error', jsonb_build_object(
        'code', 'REQUEST_INVALID',
        'message', 'The stamp request is invalid.',
        'retryable', false
      ),
      'meta', jsonb_build_object('requestId', p_request_id)
    );
    return jsonb_build_object('status', 400, 'body', v_body, 'replayed', false);
  end if;

  v_token_digest := decode(lower(p_token_digest_hex), 'hex');
  v_request_digest := decode(lower(p_request_digest_hex), 'hex');

  delete from festival.idempotency_records
  where actor_id = p_actor_id
    and scope = v_scope
    and idempotency_key = p_idempotency_key
    and expires_at <= v_now;

  insert into festival.idempotency_records (
    actor_id,
    scope,
    idempotency_key,
    request_digest,
    created_at,
    expires_at
  ) values (
    p_actor_id,
    v_scope,
    p_idempotency_key,
    v_request_digest,
    v_now,
    v_now + interval '24 hours'
  )
  on conflict (actor_id, scope, idempotency_key) do nothing;

  select request_digest, response_status, response_body
    into v_existing_digest, v_existing_status, v_existing_body
  from festival.idempotency_records
  where actor_id = p_actor_id
    and scope = v_scope
    and idempotency_key = p_idempotency_key
  for update;

  if v_existing_digest <> v_request_digest then
    insert into festival.stamp_attempts (
      event_id, user_id, result_code, request_id, idempotency_key, created_at
    ) values (
      p_event_id, p_actor_id, 'IDEMPOTENCY_KEY_REUSED', p_request_id, p_idempotency_key, v_now
    );

    v_body := jsonb_build_object(
      'error', jsonb_build_object(
        'code', 'IDEMPOTENCY_KEY_REUSED',
        'message', 'The idempotency key was already used for another request.',
        'retryable', false
      ),
      'meta', jsonb_build_object('requestId', p_request_id)
    );
    return jsonb_build_object('status', 409, 'body', v_body, 'replayed', false);
  end if;

  if v_existing_body is not null then
    return jsonb_build_object(
      'status', v_existing_status,
      'body', v_existing_body,
      'replayed', true
    );
  end if;

  select status, emergency_mode, starts_at, ends_at
    into v_event_status, v_emergency_mode, v_event_starts_at, v_event_ends_at
  from festival.events
  where id = p_event_id;

  if not found then
    v_status := 404;
    v_code := 'EVENT_NOT_FOUND';
    v_message := 'The event could not be found.';
  elsif v_emergency_mode then
    v_status := 503;
    v_code := 'EMERGENCY_MODE';
    v_message := 'Stamp claims are paused in emergency mode.';
    v_retryable := true;
  elsif v_event_status <> 'active' or v_now < v_event_starts_at or v_now >= v_event_ends_at then
    v_status := 422;
    v_code := 'EVENT_NOT_ACTIVE';
    v_message := 'The event is not accepting stamp claims.';
  end if;

  if v_code is null then
    select active, expires_at
      into v_membership_active, v_membership_expires_at
    from festival.event_memberships
    where event_id = p_event_id and user_id = p_actor_id;

    if not found or not v_membership_active
      or (v_membership_expires_at is not null and v_membership_expires_at <= v_now) then
      v_status := 403;
      v_code := 'EVENT_ACCESS_DENIED';
      v_message := 'The user cannot access this event.';
    end if;
  end if;

  if v_code is null then
    select
      tag.id,
      tag.booth_id,
      tag.active,
      tag.activated_at,
      tag.expires_at,
      booth.status,
      booth.opens_at,
      booth.closes_at
    into
      v_tag_id,
      v_booth_id,
      v_tag_active,
      v_tag_activated_at,
      v_tag_expires_at,
      v_booth_status,
      v_booth_opens_at,
      v_booth_closes_at
    from festival.nfc_tags tag
    join festival.booths booth
      on booth.event_id = tag.event_id and booth.id = tag.booth_id
    where tag.event_id = p_event_id and tag.token_digest = v_token_digest
    limit 1;

    if not found then
      v_status := 422;
      v_code := 'NFC_TAG_INVALID';
      v_message := 'The NFC tag is not registered for this event.';
    elsif not v_tag_active then
      v_status := 422;
      v_code := 'NFC_TAG_DISABLED';
      v_message := 'The NFC tag is disabled.';
    elsif v_tag_activated_at > v_now or (v_tag_expires_at is not null and v_tag_expires_at <= v_now) then
      v_status := 422;
      v_code := 'NFC_TAG_EXPIRED';
      v_message := 'The NFC tag is outside its validity period.';
    elsif v_booth_status not in ('open', 'crowded')
      or (v_booth_opens_at is not null and v_now < v_booth_opens_at)
      or (v_booth_closes_at is not null and v_now >= v_booth_closes_at) then
      v_status := 422;
      v_code := 'BOOTH_NOT_OPEN';
      v_message := 'The booth is not accepting visits.';
    end if;
  end if;

  if v_code is null then
    insert into festival.stamps (
      event_id,
      user_id,
      booth_id,
      method,
      status,
      source_tag_id,
      earned_at,
      created_at
    ) values (
      p_event_id,
      p_actor_id,
      v_booth_id,
      'nfc',
      'active',
      v_tag_id,
      v_now,
      v_now
    )
    on conflict (event_id, user_id, booth_id) where (status = 'active')
    do nothing
    returning id, method, earned_at
      into v_stamp_id, v_stamp_method, v_earned_at;

    v_created := found;

    if not v_created then
      select id, method, earned_at
        into v_stamp_id, v_stamp_method, v_earned_at
      from festival.stamps
      where event_id = p_event_id
        and user_id = p_actor_id
        and booth_id = v_booth_id
        and status = 'active';
    end if;

    if v_created then
      v_status := 201;
      v_result := 'EARNED';

      insert into festival.audit_logs (
        event_id,
        actor_id,
        action,
        target_type,
        target_id,
        metadata,
        created_at
      ) values (
        p_event_id,
        p_actor_id,
        'stamp.nfc.earned',
        'stamp',
        v_stamp_id,
        jsonb_build_object('boothId', v_booth_id, 'tagId', v_tag_id, 'requestId', p_request_id),
        v_now
      );
    else
      v_status := 200;
      v_result := 'ALREADY_EARNED';
    end if;

    v_body := jsonb_build_object(
      'data', jsonb_build_object(
        'result', v_result,
        'stamp', jsonb_build_object(
          'id', v_stamp_id,
          'boothId', v_booth_id,
          'method', v_stamp_method,
          'earnedAt', v_earned_at
        )
      ),
      'meta', jsonb_build_object('requestId', p_request_id)
    );
  else
    v_body := jsonb_build_object(
      'error', jsonb_build_object(
        'code', v_code,
        'message', v_message,
        'retryable', v_retryable
      ),
      'meta', jsonb_build_object('requestId', p_request_id)
    );
  end if;

  insert into festival.stamp_attempts (
    event_id,
    user_id,
    booth_id,
    tag_id,
    result_code,
    request_id,
    idempotency_key,
    created_at
  ) values (
    p_event_id,
    p_actor_id,
    v_booth_id,
    v_tag_id,
    coalesce(v_result, v_code),
    p_request_id,
    p_idempotency_key,
    v_now
  );

  update festival.idempotency_records
  set response_status = v_status,
      response_body = v_body
  where actor_id = p_actor_id
    and scope = v_scope
    and idempotency_key = p_idempotency_key;

  return jsonb_build_object(
    'status', v_status,
    'body', v_body,
    'replayed', false
  );
end;
$$;

revoke all on function public.claim_nfc_stamp(uuid, uuid, text, uuid, text, uuid) from public;
revoke all on function public.claim_nfc_stamp(uuid, uuid, text, uuid, text, uuid) from anon;
revoke all on function public.claim_nfc_stamp(uuid, uuid, text, uuid, text, uuid) from authenticated;
grant execute on function public.claim_nfc_stamp(uuid, uuid, text, uuid, text, uuid) to service_role;

commit;

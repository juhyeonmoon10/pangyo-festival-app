-- Approved 2026-11-04 (user request): push delivery for 웨이팅 (1.59). Supabase only; apply after waiting.sql.
-- * pg_net posts to the Edge Function 'waiting-push' after a transaction that queued a message commits.
-- * The function claims queued messages with festival_push_claim, encrypts them (RFC 8291) for every
--   subscription of the account, sends them, and reports back with festival_push_report.
-- * pg_cron runs festival_ops.waiting_tick_all every 30 seconds: automatic no-shows and retries.
-- Secrets live in Vault and are never in Git: 'festival_push_hook' (random text the Edge Function must
-- present) and 'festival_vapid_private' ({"publicKey","privateKey","subject"}, the VAPID key pair).
-- festival_ops.push_config holds the public key and the Edge Function address.
-- Rollback: waiting-push-rollback.sql.
create extension if not exists pg_net with schema extensions;

create or replace function festival_ops.push_hook_secret() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'festival_push_hook' $$;
revoke all on function festival_ops.push_hook_secret() from public, anon, authenticated;

create or replace function festival_ops.push_send_hook() returns void
language plpgsql security definer set search_path = '' as $$
declare url text; hook text := festival_ops.push_hook_secret();
begin
  select hook_url into url from festival_ops.push_config;
  if coalesce(url, '') = '' or hook is null then return; end if;
  perform net.http_post(url := url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-festival-hook', hook), timeout_milliseconds := 15000);
end $$;
revoke all on function festival_ops.push_send_hook() from public, anon, authenticated;

-- Messages older than 10 minutes are dropped; one claim takes at most 100 and holds them for 60 seconds.
create or replace function public.festival_push_claim(p_hook text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ids bigint[];
begin
  if p_hook is null or p_hook is distinct from festival_ops.push_hook_secret() then raise exception 'HOOK_REQUIRED'; end if;
  update festival_ops.push_outbox set sent_at = now(), result = 'expired' where sent_at is null and created_at < now() - interval '10 minutes';
  update festival_ops.push_outbox set sent_at = now(), result = 'failed' where sent_at is null and attempts >= 3 and claimed_at < now() - interval '60 seconds';
  select array_agg(id) into ids from (select id from festival_ops.push_outbox where sent_at is null and attempts < 3
    and (claimed_at is null or claimed_at < now() - interval '60 seconds') order by id limit 100 for update skip locked) x;
  update festival_ops.push_outbox set claimed_at = now(), attempts = attempts + 1 where id = any(ids);
  return jsonb_build_object('vapid', (select decrypted_secret::jsonb from vault.decrypted_secrets where name = 'festival_vapid_private'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'title', o.title, 'body', o.body, 'url', o.url, 'tag', o.tag,
        'subscriptions', (select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
          from festival_ops.push_subscriptions s where s.user_id = o.user_id)) order by o.id)
      from festival_ops.push_outbox o where o.id = any(ids)), '[]'::jsonb));
end $$;
revoke all on function public.festival_push_claim(text) from public, anon, authenticated;
grant execute on function public.festival_push_claim(text) to service_role;

-- p_results: [{id, sent: [endpoint], gone: [endpoint], retry: boolean}]. Gone subscriptions are deleted;
-- a message with nothing sent and retry true is tried again on the next claim.
create or replace function public.festival_push_report(p_hook text, p_results jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; n integer := 0;
begin
  if p_hook is null or p_hook is distinct from festival_ops.push_hook_secret() then raise exception 'HOOK_REQUIRED'; end if;
  if jsonb_typeof(p_results) <> 'array' then raise exception 'INVALID_INPUT'; end if;
  for r in select value from jsonb_array_elements(p_results) loop
    delete from festival_ops.push_subscriptions where endpoint in (select jsonb_array_elements_text(coalesce(r->'gone', '[]'::jsonb)));
    update festival_ops.push_subscriptions set last_ok_at = now() where endpoint in (select jsonb_array_elements_text(coalesce(r->'sent', '[]'::jsonb)));
    if jsonb_array_length(coalesce(r->'sent', '[]'::jsonb)) > 0 or not coalesce((r->>'retry')::boolean, false) then
      update festival_ops.push_outbox set sent_at = now(),
        result = case when jsonb_array_length(coalesce(r->'sent', '[]'::jsonb)) > 0 then 'sent ' || jsonb_array_length(r->'sent')
          when jsonb_array_length(coalesce(r->'gone', '[]'::jsonb)) > 0 then 'gone' else 'no_subscription' end
        where id = (r->>'id')::bigint and sent_at is null;
    else
      update festival_ops.push_outbox set result = left(coalesce(r->>'error', 'retry'), 200) where id = (r->>'id')::bigint and sent_at is null;
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('reported', n);
end $$;
revoke all on function public.festival_push_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.festival_push_report(text, jsonb) to service_role;

-- Every 30 seconds: no-shows at booths that turned automatic no-show on, then delivery of anything left.
create or replace function festival_ops.waiting_tick_all() returns void
language plpgsql security definer set search_path = '' as $$
declare e uuid; k text;
begin
  select id into e from festival_ops.events where current;
  if e is not null then
    for k in select distinct w.booth_key from festival_ops.waiting_entries w
        join festival_ops.waiting_settings s on s.event_id = w.event_id and s.booth_key = w.booth_key and s.auto_noshow
        where w.event_id = e and w.status = 'called' and w.called_at + make_interval(mins => s.noshow_minutes) <= now() loop
      perform pg_catalog.pg_advisory_xact_lock(170927, hashtext(k));
      perform festival_ops.waiting_tick(e, k);
    end loop;
  end if;
  if exists(select 1 from festival_ops.push_outbox where sent_at is null and attempts < 3 and created_at > now() - interval '10 minutes'
      and (claimed_at is null or claimed_at < now() - interval '60 seconds')) then
    perform festival_ops.push_kick();
  end if;
end $$;
revoke all on function festival_ops.waiting_tick_all() from public, anon, authenticated;

do $$
begin
  if exists(select 1 from cron.job where jobname = 'festival-waiting-tick') then perform cron.unschedule('festival-waiting-tick'); end if;
  perform cron.schedule('festival-waiting-tick', '30 seconds', 'select festival_ops.waiting_tick_all()');
end $$;

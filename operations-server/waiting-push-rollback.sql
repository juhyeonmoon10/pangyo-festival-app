-- Rollback of waiting-push.sql (1.59): stops the 30-second job and push delivery. Queued messages stay
-- in festival_ops.push_outbox until waiting-rollback.sql drops it. pg_net and the Vault secrets are kept;
-- delete the secrets 'festival_push_hook' and 'festival_vapid_private' in the dashboard if no longer needed.
do $$
begin
  if exists(select 1 from cron.job where jobname = 'festival-waiting-tick') then perform cron.unschedule('festival-waiting-tick'); end if;
end $$;
drop function if exists festival_ops.waiting_tick_all();
drop function if exists public.festival_push_report(text, jsonb);
drop function if exists public.festival_push_claim(text);
drop function if exists festival_ops.push_send_hook();
drop function if exists festival_ops.push_hook_secret();
update festival_ops.push_config set hook_url = '';

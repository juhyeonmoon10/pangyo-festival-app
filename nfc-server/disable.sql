-- Emergency stop for the personal festival functions. Keeps every other object and policy as-is.
-- Students and administrators can no longer call the RPCs; stored visits and reviews are untouched.
-- Re-enable by granting execute back and setting "enabled" to true in the Vault secret.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
revoke execute on function public.festival_nfc_profile(), public.festival_nfc_claim(text) from authenticated;
do $$
declare
  target text;
begin
  foreach target in array array[
    'public.festival_nfc_admin_issue(text, integer)',
    'public.festival_booth_reviews(text)',
    'public.festival_my_reviews()',
    'public.festival_review_submit(text, integer, text)'
  ] loop
    if to_regprocedure(target) is not null then
      execute format('revoke execute on function %s from authenticated', target);
    end if;
  end loop;
end $$;
select vault.update_secret(id, (decrypted_secret::jsonb || '{"enabled": false}'::jsonb)::text)
  from vault.decrypted_secrets where name = 'pangyo_festival_nfc_v1';
notify pgrst, 'reload schema';
commit;

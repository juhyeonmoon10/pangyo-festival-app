-- Full removal of the personal NFC install and restoration of the users permissions that were
-- observed on 2026-09-09 (before-permissions.json). Operator decision required before running:
-- the restored policies re-open the broad SELECT/UPDATE access that install.sql closed.
-- Deleting the Vault secret permanently invalidates every issued tag.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.users') is null then
    raise exception 'REQUIRED_EXISTING_OBJECT_MISSING';
  end if;
end $$;

drop function if exists public.festival_review_submit(text, integer, text);
drop function if exists public.festival_booth_reviews(text);
drop function if exists public.festival_my_reviews();
drop function if exists public.festival_nfc_admin_issue(text, integer);
drop function if exists public.festival_nfc_claim(text);
drop function if exists public.festival_nfc_profile();
drop schema if exists festival_nfc_private cascade;

-- booth_ratings.content is left in place on purpose: dropping it would delete written feedback.
-- Remove it manually only after exporting or discarding that text.

alter policy users_authenticated_select on public.users using (true);
alter policy users_authenticated_update on public.users using (true) with check (money >= 0);
grant select, update on public.users to authenticated;

delete from vault.secrets where name = 'pangyo_festival_nfc_v1';

notify pgrst, 'reload schema';
commit;

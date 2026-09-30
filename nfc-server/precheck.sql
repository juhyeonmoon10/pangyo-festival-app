-- Read-only pre-install check for the shared project. Run with SQL editor privileges.
-- Compare every result with before-permissions.json (observed 2026-09-09) before running install.sql.
-- Nothing here modifies data, policies, functions, or settings.

-- 1. Policies on public.users (expect users_authenticated_select USING true, users_authenticated_update USING true WITH CHECK money >= 0).
select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' and tablename = 'users' order by policyname;

-- 2. Table grants on public.users for browser roles (expect authenticated: SELECT, UPDATE; anon: none).
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'users' and grantee in ('anon', 'authenticated') order by 1, 2;

-- 3. Policies on other tables whose body references users (install.sql narrows users SELECT to the own row).
select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename <> 'users'
  and (coalesce(qual, '') ilike '%users%' or coalesce(with_check, '') ilike '%users%');

-- 4. Column list that install.sql revokes UPDATE on (all nine must exist).
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'users'
  and column_name in ('id', 'name', 'email', 'money', 'completed_booths', 'completed_quests', 'admin', 'rank', 'auth_user_id')
order by column_name;

-- 5. Objects install.sql requires or forbids.
select to_regclass('public.users') as users_table, to_regclass('public.booths') as booths_table,
  to_regclass('vault.decrypted_secrets') as vault_view,
  exists(select 1 from pg_namespace where nspname = 'festival_nfc_private') as nfc_schema_already_exists,
  has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT') as vault_readable_by_anon,
  has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT') as vault_readable_by_authenticated,
  exists(select 1 from vault.secrets where name = 'pangyo_festival_nfc_v1') as nfc_secret_already_exists;

-- 6. booth_enum values must include the twenty club names used by supabase-catalog.js.
select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
where t.typname = 'booth_enum' order by e.enumsortorder;

-- 7. Existing public.festival_nfc_* functions (expect none before install, two after).
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname like 'festival_nfc_%' or n.nspname = 'festival_nfc_private' order by 1, 2;

-- 8. Post-install only: browser roles must not be able to execute the RPCs as anon.
select has_function_privilege('anon', 'public.festival_nfc_claim(text)', 'EXECUTE') as anon_can_claim,
  has_function_privilege('authenticated', 'public.festival_nfc_claim(text)', 'EXECUTE') as authenticated_can_claim
where to_regprocedure('public.festival_nfc_claim(text)') is not null;

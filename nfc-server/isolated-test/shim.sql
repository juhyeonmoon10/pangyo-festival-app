-- Isolated stand-in for the Supabase objects that install.sql depends on.
-- Runs inside a throwaway PGlite database. Nothing here touches the shared project.
-- auth.uid()/auth.jwt() mirror Supabase's definitions; vault.* is a plain-table shim
-- (no encryption), so Vault behaviour itself is NOT verified here.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema extensions;
create extension pgcrypto schema extensions;
do $shim$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions' and p.proname = 'gen_random_uuid') then
    create function extensions.gen_random_uuid() returns uuid language sql
      as 'select pg_catalog.gen_random_uuid()';
  end if;
end $shim$;
grant usage on schema extensions to anon, authenticated;
grant usage on schema public to anon, authenticated;

create schema auth;
create table auth.users(
  id uuid primary key, email text, email_confirmed_at timestamptz, banned_until timestamptz,
  raw_app_meta_data jsonb not null default '{}', raw_user_meta_data jsonb not null default '{}',
  created_at timestamptz, updated_at timestamptz);
create table auth.sessions(
  id uuid primary key, user_id uuid references auth.users(id),
  created_at timestamptz, updated_at timestamptz, not_after timestamptz);
create function auth.jwt() returns jsonb language sql stable as $shim$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), ''))::jsonb $shim$;
create function auth.uid() returns uuid language sql stable as $shim$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), auth.jwt()->>'sub'), '')::uuid $shim$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;

create schema vault;
create table vault.secrets(
  id uuid primary key default pg_catalog.gen_random_uuid(), name text unique, description text default '',
  secret text not null, key_id uuid, nonce bytea,
  created_at timestamptz default now(), updated_at timestamptz default now());
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at
  from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null,
  new_description text default '', new_key_id uuid default null) returns uuid language sql as $shim$
  insert into vault.secrets(name, description, secret, key_id)
  values(new_name, new_description, new_secret, new_key_id) returning id $shim$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null) returns void language sql as $shim$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
    description = coalesce(new_description, description), updated_at = now() where id = secret_id $shim$;
revoke all on schema vault from public, anon, authenticated;

-- Shared-DB shapes observed on 2026-09-09 (see ../before-permissions.json and ../README.md).
create type public.booth_enum as enum (
  '글빛누리', '매커니즘', '인사이트', '패러다임', '리켐', '인벨릭스', '건축학부', '머큐리', '네온', '티치스트',
  '케미스트', '아트 캔버스', '창업특허연구소', '모멘트', '배구사랑', '월드 스코프', '방송부', '심장박동', '레브', '다이나믹스');
create table public.booths(id public.booth_enum primary key, name text not null, rating numeric not null default 0, position text not null default '');
insert into public.booths(id, name) select e, e::text from unnest(enum_range(null::public.booth_enum)) e;
alter table public.booths enable row level security;
create policy booths_public_select on public.booths for select to anon, authenticated using (true);
grant select on public.booths to anon, authenticated;

create table public.users(
  id integer generated always as identity primary key,
  auth_user_id uuid, email text, name text,
  money integer not null default 0,
  completed_booths public.booth_enum[] not null default '{}',
  completed_quests text[] not null default '{}',
  admin boolean not null default false,
  rank integer,
  created_at timestamptz default now());
alter table public.users enable row level security;
create policy users_authenticated_select on public.users for select to authenticated using (true);
create policy users_authenticated_update on public.users for update to authenticated using (true) with check (money >= 0);
grant select, update on public.users to authenticated;

create table public.booth_ratings(
  user_id integer references public.users(id), booth_id public.booth_enum references public.booths(id),
  rating integer not null, created_at timestamptz default now(), unique(user_id, booth_id));
alter table public.booth_ratings enable row level security;
create policy booth_ratings_public_select on public.booth_ratings for select to authenticated using (true);
create policy booth_ratings_own_insert on public.booth_ratings for insert to authenticated
  with check (user_id in (select id from public.users where auth_user_id = (select auth.uid())));
grant select, insert on public.booth_ratings to authenticated;

-- Apply only after project-owner approval. Schedule times are stored as instants.
begin;
create table public.festival_2026_performances (
  id uuid primary key default gen_random_uuid(), title text not null check (length(trim(title)) between 1 and 120),
  starts_at timestamptz not null, ends_at timestamptz not null check (ends_at > starts_at)
);
create table public.festival_2026_ballots (
  voter uuid primary key default auth.uid() references auth.users(id),
  first uuid not null references public.festival_2026_performances,
  second uuid not null references public.festival_2026_performances,
  third uuid not null references public.festival_2026_performances,
  check(first <> second and second <> third and first <> third)
);
alter table public.festival_2026_performances enable row level security;
alter table public.festival_2026_ballots enable row level security;
revoke all on public.festival_2026_ballots,public.festival_2026_performances from public,anon,authenticated;
grant select,delete on public.festival_2026_performances to authenticated;
grant insert(title,starts_at,ends_at),update(title,starts_at,ends_at) on public.festival_2026_performances to authenticated;
grant select,insert(first,second,third) on public.festival_2026_ballots to authenticated;
create policy schedule_read on public.festival_2026_performances for select to authenticated using(true);
create policy schedule_admin on public.festival_2026_performances for all to authenticated using(exists(select 1 from public.users u where u.auth_user_id=auth.uid() and u.admin)) with check(exists(select 1 from public.users u where u.auth_user_id=auth.uid() and u.admin));
create policy ballot_read on public.festival_2026_ballots for select to authenticated using(voter=auth.uid());
create policy ballot_submit on public.festival_2026_ballots for insert to authenticated with check(voter=auth.uid() and
  (select count(*) from public.festival_2026_performances p where p.id in (first,second,third) and p.ends_at<=now())=3);
commit;

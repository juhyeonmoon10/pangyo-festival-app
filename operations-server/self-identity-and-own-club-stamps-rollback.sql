-- Rollback for self-identity-and-own-club-stamps.sql. Stops own-club stamp blocking and removal.
-- Removed stamps are not restored (the audit rows 'own_club_stamp_remove' list the accounts).
-- To return to operator-only identity confirmation, reapply operator-identity-and-scoped-reset.sql after this.
begin;
select pg_catalog.pg_advisory_xact_lock(170926,1);
drop trigger visits_block_own_club on festival_ops.visits;
drop trigger review_identities_strip_own_club on festival_ops.review_identities;
drop function festival_ops.block_own_club_visit();
drop function festival_ops.strip_after_identity();
drop function festival_ops.strip_own_club_stamps(uuid,integer,integer);
drop function public.festival_identity_overview();
-- claim() still calls own_booths; an empty result disables the NFC check without replacing claim().
create or replace function festival_ops.own_booths(e uuid,u integer) returns text[]
language sql stable set search_path='' as $$ select '{}'::text[] $$;
revoke all on function festival_ops.own_booths(uuid,integer) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;

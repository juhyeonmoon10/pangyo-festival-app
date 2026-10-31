-- 1.30 security: the booth rating helpers are trigger-only.
--
-- public.refresh_booth_rating and public.handle_booth_rating_changed (ORBIT, 2026-07-13) recompute
-- public.booths.rating after a change to public.booth_ratings. The original migration revoked them
-- from PUBLIC, but Supabase's default privileges also grant EXECUTE to anon and authenticated, so a
-- browser could call them through /rest/v1/rpc without signing in (Supabase advisor 0028/0029).
-- Triggers do not check EXECUTE when they fire, so the rating keeps updating after this change.
-- No app calls these functions directly (checked in every ORBIT branch and this app).
begin;
revoke execute on function public.refresh_booth_rating(public.booth_enum) from public, anon, authenticated;
revoke execute on function public.handle_booth_rating_changed() from public, anon, authenticated;
commit;

-- Restores the Supabase default grants removed by rating-function-grants.sql.
begin;
grant execute on function public.refresh_booth_rating(public.booth_enum) to anon, authenticated;
grant execute on function public.handle_booth_rating_changed() to anon, authenticated;
commit;

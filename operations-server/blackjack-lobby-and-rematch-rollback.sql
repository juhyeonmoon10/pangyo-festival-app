-- Rollback for blackjack-lobby-and-rematch.sql: removes the hub matching count and the same-opponent rematch.
-- Games already started by a rematch stay in private.blackjack_games and finish as usual.
begin;
drop function if exists public.festival_blackjack_rematch(uuid, text);
drop function if exists public.festival_blackjack_lobby();
drop table if exists festival_ops.blackjack_rematch;
notify pgrst, 'reload schema';
commit;

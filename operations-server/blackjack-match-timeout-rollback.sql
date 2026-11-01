-- Rollback for blackjack-match-timeout.sql (1.43): back to the 1.42 functions; ORBIT's sweep cancels waiting games after 3 minutes again.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function public.festival_blackjack_state() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_me public.users := private.blackjack_me();
begin
  return festival_ops.blackjack_named(public.orbit_blackjack_state(), v_me.id);
end $$;

create or replace function public.festival_blackjack_lobby() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_set festival_ops.blackjack_settings;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select * into v_set from festival_ops.blackjack_settings where singleton;
  return jsonb_build_object('waiting', (select count(*) from private.blackjack_games
      where status = 'waiting' and created_at > clock_timestamp() - interval '3 minutes'),
    'maxPerTurn', coalesce(v_set.max_per_turn, 1), 'maxDraws', v_set.max_draws);
end $$;

create or replace function public.festival_blackjack_join() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_stake constant integer := 300;
begin
  -- The same queue lock as orbit_blackjack_join, so both functions share one queue.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('orbit-blackjack-queue', 0));
  select * into v_game from private.blackjack_games
    where status in ('waiting','playing') and (player_a = v_me.id or player_b = v_me.id) for update;
  if found then return festival_ops.blackjack_named(private.blackjack_view(private.blackjack_advance(v_game), v_me.id), v_me.id); end if;
  if v_me.money < v_stake then raise exception using message = 'INSUFFICIENT_POINTS'; end if;

  select * into v_game from private.blackjack_games
    where status = 'waiting' and player_a <> v_me.id order by created_at limit 1 for update;
  if not found then
    insert into private.blackjack_games(stake, player_a, deck)
      values (v_stake, v_me.id, (select array_agg(c::smallint order by gen_random_uuid()) from generate_series(0, 51) c))
      returning * into v_game;
    perform private.blackjack_move_points(v_me.id, -v_stake, v_game.id, 'stake');
    return private.blackjack_view(v_game, v_me.id);
  end if;

  perform private.blackjack_move_points(v_me.id, -v_game.stake, v_game.id, 'stake');
  update private.blackjack_games set player_b = v_me.id, status = 'playing', started_at = clock_timestamp(),
    hand_a = array[deck[1], deck[3]], hand_b = array[deck[2], deck[4]], next_card = 4,
    turn = 'a', turn_deadline = clock_timestamp() + private.blackjack_turn_limit(), version = version + 1
  where id = v_game.id returning * into v_game;
  return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id);
end $$;

drop function festival_ops.blackjack_expire_waiting();
drop function festival_ops.blackjack_match_limit();
notify pgrst, 'reload schema';
commit;

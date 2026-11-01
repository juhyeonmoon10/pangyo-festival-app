-- 1.43 blackjack matching ends after 1 minute and gives the stake back.
-- ORBIT's private.blackjack_sweep (pg_cron, every minute) cancels a waiting game only after 3 minutes, so a
-- player could wait 3-4 minutes. The festival functions now cancel and refund every waiting game older than
-- 1 minute themselves: the waiting player's 1-second state poll, any join and the 5-second lobby poll do it.
-- ORBIT's sweep stays as it is (a backstop for games nobody looks at).
--   festival_ops.blackjack_match_limit   - interval '1 minute'.
--   festival_ops.blackjack_expire_waiting - cancels and refunds expired waiting games (same steps as the sweep).
--   festival_blackjack_state/join/lobby  - expire first; join only meets opponents within the limit; the
--                                          lobby counts players waiting within the limit (was 3 minutes).
-- ORBIT's orbit_* functions and private.* helpers are not changed. Requested 2026-11-01.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function festival_ops.blackjack_match_limit() returns interval
language sql immutable set search_path='' as $$ select interval '1 minute' $$;

create function festival_ops.blackjack_expire_waiting() returns integer
language plpgsql security definer set search_path='' as $$
declare v_game private.blackjack_games; v_count integer := 0;
begin
  for v_game in select * from private.blackjack_games
    where status = 'waiting' and created_at < clock_timestamp() - festival_ops.blackjack_match_limit()
    for update skip locked loop
    update private.blackjack_games set status = 'cancelled', finished_at = clock_timestamp(), version = version + 1 where id = v_game.id;
    perform private.blackjack_move_points(v_game.player_a, v_game.stake, v_game.id, 'payout');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke all on function festival_ops.blackjack_match_limit(), festival_ops.blackjack_expire_waiting() from public, anon, authenticated;

create or replace function public.festival_blackjack_state() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_me public.users := private.blackjack_me();
begin
  perform festival_ops.blackjack_expire_waiting();
  return festival_ops.blackjack_named(public.orbit_blackjack_state(), v_me.id);
end $$;

-- Was stable; it now cancels expired waiting games, so it is volatile.
create or replace function public.festival_blackjack_lobby() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_set festival_ops.blackjack_settings;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  perform festival_ops.blackjack_expire_waiting();
  select * into v_set from festival_ops.blackjack_settings where singleton;
  return jsonb_build_object('waiting', (select count(*) from private.blackjack_games
      where status = 'waiting' and created_at > clock_timestamp() - festival_ops.blackjack_match_limit()),
    'maxPerTurn', coalesce(v_set.max_per_turn, 1), 'maxDraws', v_set.max_draws,
    'matchSeconds', extract(epoch from festival_ops.blackjack_match_limit())::integer);
end $$;

create or replace function public.festival_blackjack_join() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_stake constant integer := 300;
begin
  -- The same queue lock as orbit_blackjack_join, so both functions share one queue.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('orbit-blackjack-queue', 0));
  perform festival_ops.blackjack_expire_waiting();
  select * into v_game from private.blackjack_games
    where status in ('waiting','playing') and (player_a = v_me.id or player_b = v_me.id) for update;
  if found then return festival_ops.blackjack_named(private.blackjack_view(private.blackjack_advance(v_game), v_me.id), v_me.id); end if;
  if v_me.money < v_stake then raise exception using message = 'INSUFFICIENT_POINTS'; end if;

  -- Only opponents still within the matching time (a game expiring this instant may be locked by another call).
  select * into v_game from private.blackjack_games
    where status = 'waiting' and player_a <> v_me.id and created_at >= clock_timestamp() - festival_ops.blackjack_match_limit()
    order by created_at limit 1 for update;
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

notify pgrst, 'reload schema';
commit;

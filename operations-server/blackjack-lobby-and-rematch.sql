-- 1.38 미니게임: the "n명 매칭중" count on the games hub and a same-opponent rematch on the blackjack result
-- screen. ORBIT's orbit_blackjack_* functions and private.* helpers are not changed. The rematch reads
-- private.blackjack_games and starts the next game with the same steps as orbit_blackjack_join (same queue
-- lock, stake from both players through private.blackjack_move_points, same deal and two-card-21 rule).
--
-- Rematch state per finished game and player lives in festival_ops.blackjack_rematch:
--   watch   - sent every second while the player's result screen is open (heartbeat; keeps an accept).
--   accept  - "한 판 더 하기" with the same opponent. When both have accepted, the second call starts the game.
--   decline - sent when the player leaves the blackjack screen.
-- The opponent is reported as 'waiting' while their heartbeat is fresh (10 s; 20 s after the game ended
-- before their first heartbeat), 'accept' after they accepted, and 'decline' when they left, went stale,
-- or are already in another waiting/playing game.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table festival_ops.blackjack_rematch (
  game_id uuid not null references private.blackjack_games(id) on delete cascade,
  user_id integer not null references public.users(id) on delete cascade,
  choice text not null default 'waiting' check (choice in ('waiting','accept','decline')),
  seen_at timestamptz not null default clock_timestamp(),
  next_game_id uuid references private.blackjack_games(id) on delete set null,
  primary key (game_id, user_id)
);
alter table festival_ops.blackjack_rematch enable row level security;
revoke all on table festival_ops.blackjack_rematch from public, anon, authenticated;

-- Players waiting for a random opponent (the queue sweeps them after 3 minutes).
create function public.festival_blackjack_lobby() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  return jsonb_build_object('waiting', (select count(*) from private.blackjack_games
    where status = 'waiting' and created_at > clock_timestamp() - interval '3 minutes'));
end $$;

create function public.festival_blackjack_rematch(p_game_id uuid, p_choice text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_me public.users := private.blackjack_me();
  v_game private.blackjack_games; v_next private.blackjack_games;
  v_mine festival_ops.blackjack_rematch; v_theirs festival_ops.blackjack_rematch;
  v_opp integer; v_status text;
begin
  if p_game_id is null or p_choice is null or p_choice not in ('watch','accept','decline') then raise exception 'INVALID_INPUT'; end if;
  -- The same lock as orbit_blackjack_join, so a player is never placed in two games at once.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('orbit-blackjack-queue', 0));
  select * into v_game from private.blackjack_games where id = p_game_id and v_me.id in (player_a, player_b);
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if v_game.status <> 'finished' or v_game.finished_at < clock_timestamp() - interval '10 minutes' then raise exception 'REMATCH_EXPIRED'; end if;
  v_opp := case when v_game.player_a = v_me.id then v_game.player_b else v_game.player_a end;

  if p_choice = 'accept' then
    if exists (select 1 from private.blackjack_games g where g.status in ('waiting','playing') and v_me.id in (g.player_a, g.player_b))
      then raise exception 'INVALID_ACTION'; end if;
    if v_me.money < v_game.stake then raise exception 'INSUFFICIENT_POINTS'; end if;
  end if;
  insert into festival_ops.blackjack_rematch as r (game_id, user_id, choice)
    values (v_game.id, v_me.id, case when p_choice = 'watch' then 'waiting' else p_choice end)
  on conflict (game_id, user_id) do update set seen_at = clock_timestamp(),
    -- A heartbeat keeps an accept; coming back to the screen after leaving turns a decline into waiting.
    choice = case when excluded.choice <> 'waiting' then excluded.choice when r.choice = 'decline' then 'waiting' else r.choice end
  returning * into v_mine;

  select * into v_theirs from festival_ops.blackjack_rematch where game_id = v_game.id and user_id = v_opp;
  v_status := case
    when v_mine.next_game_id is not null then 'accept'
    when exists (select 1 from private.blackjack_games g where g.status in ('waiting','playing') and v_opp in (g.player_a, g.player_b)) then 'decline'
    when v_theirs.user_id is null then case when v_game.finished_at > clock_timestamp() - interval '20 seconds' then 'waiting' else 'decline' end
    when v_theirs.choice = 'decline' or v_theirs.seen_at < clock_timestamp() - interval '10 seconds' then 'decline'
    else v_theirs.choice end;

  if v_mine.choice = 'accept' and v_mine.next_game_id is null and v_status = 'accept' then
    if (select money from public.users where id = v_opp) < v_game.stake then
      -- The opponent spent their points meanwhile: their accept no longer holds.
      update festival_ops.blackjack_rematch set choice = 'decline' where game_id = v_game.id and user_id = v_opp;
      v_status := 'decline';
    else
      -- The player who accepted first acts first, like the waiting player in orbit_blackjack_join.
      insert into private.blackjack_games(stake, player_a, deck)
        values (v_game.stake, v_opp, (select array_agg(c::smallint order by gen_random_uuid()) from generate_series(0, 51) c))
        returning * into v_next;
      perform private.blackjack_move_points(v_opp, -v_next.stake, v_next.id, 'stake');
      perform private.blackjack_move_points(v_me.id, -v_next.stake, v_next.id, 'stake');
      update private.blackjack_games set player_b = v_me.id, status = 'playing', started_at = clock_timestamp(),
        hand_a = array[deck[1], deck[3]], hand_b = array[deck[2], deck[4]], next_card = 4,
        turn = 'a', turn_deadline = clock_timestamp() + private.blackjack_turn_limit(), version = version + 1
      where id = v_next.id returning * into v_next;
      update private.blackjack_games set done_a = private.blackjack_total(hand_a) = 21, done_b = private.blackjack_total(hand_b) = 21
      where id = v_next.id returning * into v_next;
      if v_next.done_a then v_next := private.blackjack_next_turn(v_next); end if;
      if v_next.status = 'playing' and v_next.done_a and v_next.done_b then v_next := private.blackjack_settle(v_next); end if;
      update festival_ops.blackjack_rematch set next_game_id = v_next.id where game_id = v_game.id;
      v_mine.next_game_id := v_next.id;
    end if;
  elsif v_mine.next_game_id is not null then
    select * into v_next from private.blackjack_games where id = v_mine.next_game_id;
  end if;

  return jsonb_build_object('me', v_mine.choice, 'opponent', v_status,
    'game', case when v_next.id is not null then private.blackjack_view(v_next, v_me.id) end);
end $$;

revoke all on function public.festival_blackjack_lobby(), public.festival_blackjack_rematch(uuid, text) from public, anon, authenticated;
grant execute on function public.festival_blackjack_lobby(), public.festival_blackjack_rematch(uuid, text) to authenticated;
notify pgrst, 'reload schema';
commit;

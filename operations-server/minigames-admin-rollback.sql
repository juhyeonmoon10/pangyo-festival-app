-- Rolls back 1.41 (minigames-admin.sql). Deploy a 1.40 client first: it calls festival_blackjack_join/action and
-- orbit_blackjack_state. Blackjack goes back to the 1.40 rules (no card limits, masked opponent name).
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
drop function if exists public.festival_blackjack_admin(text, jsonb);
drop function if exists public.festival_blackjack_state();
drop function if exists public.festival_blackjack_action(uuid, text, integer, integer);

create function public.festival_blackjack_action(p_game_id uuid, p_action text, p_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_side text; v_hand smallint[]; v_stand boolean;
begin
  if p_game_id is null or p_action is null or p_action not in ('hit','stand') or p_version is null then
    raise exception using message = 'INVALID_ACTION';
  end if;
  select * into v_game from private.blackjack_games where id = p_game_id and (player_a = v_me.id or player_b = v_me.id) for update;
  if not found then raise exception using message = 'GAME_NOT_FOUND'; end if;
  v_game := private.blackjack_advance(v_game);
  if v_game.version <> p_version then return private.blackjack_view(v_game, v_me.id); end if;
  v_side := case when v_game.player_a = v_me.id then 'a' else 'b' end;
  if v_game.status <> 'playing' or v_game.turn <> v_side then raise exception using message = 'NOT_YOUR_TURN'; end if;

  v_stand := p_action = 'stand' or v_game.next_card >= pg_catalog.cardinality(v_game.deck);
  if v_stand then
    if v_side = 'a' then update private.blackjack_games set done_a = true where id = v_game.id returning * into v_game;
    else update private.blackjack_games set done_b = true where id = v_game.id returning * into v_game;
    end if;
  else
    -- A hit only adds a card: 21 or a bust does not stand.
    v_hand := case when v_side = 'a' then v_game.hand_a else v_game.hand_b end || v_game.deck[v_game.next_card + 1];
    if v_side = 'a' then update private.blackjack_games set hand_a = v_hand, next_card = next_card + 1 where id = v_game.id returning * into v_game;
    else update private.blackjack_games set hand_b = v_hand, next_card = next_card + 1 where id = v_game.id returning * into v_game;
    end if;
  end if;
  return private.blackjack_view(private.blackjack_next_turn(v_game), v_me.id);
end $$;

create or replace function public.festival_blackjack_join() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_stake constant integer := 300;
begin
  -- The same queue lock as orbit_blackjack_join, so both functions share one queue.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('orbit-blackjack-queue', 0));
  select * into v_game from private.blackjack_games
    where status in ('waiting','playing') and (player_a = v_me.id or player_b = v_me.id) for update;
  if found then return private.blackjack_view(private.blackjack_advance(v_game), v_me.id); end if;
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
  return private.blackjack_view(v_game, v_me.id);
end $$;

create or replace function public.festival_blackjack_rematch(p_game_id uuid, p_choice text) returns jsonb
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
      -- 1.40: no automatic stand on a two-card 21; players stand themselves.
      update festival_ops.blackjack_rematch set next_game_id = v_next.id where game_id = v_game.id;
      v_mine.next_game_id := v_next.id;
    end if;
  elsif v_mine.next_game_id is not null then
    select * into v_next from private.blackjack_games where id = v_mine.next_game_id;
  end if;

  return jsonb_build_object('me', v_mine.choice, 'opponent', v_status,
    'game', case when v_next.id is not null then private.blackjack_view(v_next, v_me.id) end);
end $$;

create or replace function public.festival_blackjack_lobby() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  return jsonb_build_object('waiting', (select count(*) from private.blackjack_games
    where status = 'waiting' and created_at > clock_timestamp() - interval '3 minutes'));
end $$;

drop function if exists festival_ops.blackjack_named(jsonb, integer);
drop table if exists festival_ops.blackjack_settings;
revoke all on function public.festival_blackjack_action(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.festival_blackjack_action(uuid, text, integer) to authenticated;
notify pgrst, 'reload schema';
commit;

-- 1.49 blackjack: simultaneous rounds (MINIGAME_RULES.md 3).
--   Both players choose hit or stand in the same round without seeing the other's choice; when both have
--   chosen (or 10 s pass) the choices are revealed together and each hit draws one card. A stand stops the
--   player for the game; no choice in time is a stand. Cards per turn (1.42-1.44) are gone; the per-game
--   card limit stays.
--   Matching uses a festival-only queue (festival_ops.blackjack_queue): ORBIT's orbit_blackjack_join only
--   sees waiting rows in private.blackjack_games, so festival players never meet ORBIT-app players. The
--   stake is taken from both players when they are matched, so leaving the queue refunds nothing.
--   A festival game in progress keeps turn and turn_deadline null, so ORBIT's private.blackjack_advance and
--   its per-minute sweep never touch it; the round deadline lives in festival_ops.blackjack_round and a
--   festival sweep (pg_cron, every minute) settles rounds nobody is watching.
-- ORBIT's orbit_* functions and private.* helpers are not changed. Requested 2026-11-02.
-- Apply only while no game is waiting or in progress (checked below).
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if exists (select 1 from private.blackjack_games where status in ('waiting','playing')) then
    raise exception 'BLACKJACK_GAMES_IN_PROGRESS';
  end if;
end $$;

create table festival_ops.blackjack_queue (
  id uuid primary key default gen_random_uuid(),
  user_id integer not null references public.users(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting','matched','cancelled','expired')),
  joined_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  game_id uuid references private.blackjack_games(id) on delete set null
);
create unique index blackjack_queue_one_waiting on festival_ops.blackjack_queue(user_id) where status = 'waiting';
create index blackjack_queue_waiting_idx on festival_ops.blackjack_queue(joined_at) where status = 'waiting';
create index blackjack_queue_user_idx on festival_ops.blackjack_queue(user_id, ended_at desc);

-- The open round of a game in progress. A choice never leaves these functions before the reveal.
create table festival_ops.blackjack_round (
  game_id uuid primary key references private.blackjack_games(id) on delete cascade,
  round integer not null check (round >= 1),
  deadline timestamptz not null,
  choice_a text check (choice_a in ('hit','stand')),
  choice_b text check (choice_b in ('hit','stand'))
);
-- What each player did in each round (null: already stopped). The latest row drives the reveal.
create table festival_ops.blackjack_round_log (
  game_id uuid not null references private.blackjack_games(id) on delete cascade,
  round integer not null,
  action_a text check (action_a in ('hit','stand','timeout')),
  action_b text check (action_b in ('hit','stand','timeout')),
  resolved_at timestamptz not null default clock_timestamp(),
  primary key (game_id, round)
);
alter table festival_ops.blackjack_queue enable row level security;
alter table festival_ops.blackjack_round enable row level security;
alter table festival_ops.blackjack_round_log enable row level security;
revoke all on table festival_ops.blackjack_queue, festival_ops.blackjack_round, festival_ops.blackjack_round_log
  from public, anon, authenticated;

-- 10 s to choose plus 1.5 s for the reveal of the last round.
create function festival_ops.blackjack_round_deadline() returns timestamptz
language sql volatile set search_path='' as $$ select clock_timestamp() + interval '11.5 seconds' $$;

create function festival_ops.blackjack_expire_queue() returns integer
language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  update festival_ops.blackjack_queue set status = 'expired', ended_at = clock_timestamp()
    where status = 'waiting' and joined_at < clock_timestamp() - festival_ops.blackjack_match_limit();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- A queue entry shown like a game, so the screen keeps one shape: waiting, or cancelled when it ended.
create function festival_ops.blackjack_queue_view(p_queue festival_ops.blackjack_queue) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id', p_queue.id, 'status', case when p_queue.status = 'waiting' then 'waiting' else 'cancelled' end,
    'stake', 300, 'version', 0, 'createdAt', p_queue.joined_at, 'myCards', '[]'::jsonb, 'myTotal', 0, 'myDone', false,
    'opponentName', null, 'opponentCards', '[]'::jsonb, 'opponentTotal', null, 'opponentDone', false,
    'turn', null, 'turnDeadline', null, 'result', null, 'payout', null, 'queued', true, 'ended', p_queue.status)
$$;

-- Starts a game between two matched players: both stakes, two cards each, round 1.
create function festival_ops.blackjack_start(p_player_a integer, p_player_b integer, p_stake integer) returns private.blackjack_games
language plpgsql security definer set search_path='' as $$
declare v_game private.blackjack_games;
begin
  insert into private.blackjack_games(stake, player_a, deck)
    values (p_stake, p_player_a, (select array_agg(c::smallint order by gen_random_uuid()) from generate_series(0, 51) c))
    returning * into v_game;
  perform private.blackjack_move_points(p_player_a, -p_stake, v_game.id, 'stake');
  perform private.blackjack_move_points(p_player_b, -p_stake, v_game.id, 'stake');
  update private.blackjack_games set player_b = p_player_b, status = 'playing', started_at = clock_timestamp(),
    hand_a = array[deck[1], deck[3]], hand_b = array[deck[2], deck[4]], next_card = 4,
    turn = null, turn_deadline = null, version = version + 1
  where id = v_game.id returning * into v_game;
  insert into festival_ops.blackjack_round(game_id, round, deadline) values (v_game.id, 1, festival_ops.blackjack_round_deadline());
  return v_game;
end $$;

-- Reveals the open round: a missing choice is a stand ('timeout'), hits are dealt in seat order, and the
-- game is settled once both players have stopped. Caller holds the game row lock.
create function festival_ops.blackjack_resolve(p_game private.blackjack_games) returns private.blackjack_games
language plpgsql security definer set search_path='' as $$
declare v_round festival_ops.blackjack_round; v_a text; v_b text;
begin
  if p_game.status <> 'playing' then return p_game; end if;
  select * into v_round from festival_ops.blackjack_round where game_id = p_game.id for update;
  if not found then return p_game; end if;
  v_a := case when p_game.done_a then null else coalesce(v_round.choice_a, 'timeout') end;
  v_b := case when p_game.done_b then null else coalesce(v_round.choice_b, 'timeout') end;
  -- With the 52-card deck used up a hit has no card to give, so it stands.
  if v_a = 'hit' and p_game.next_card >= pg_catalog.cardinality(p_game.deck) then v_a := 'stand'; end if;
  if v_a = 'hit' then
    update private.blackjack_games set hand_a = hand_a || deck[next_card + 1], next_card = next_card + 1
      where id = p_game.id returning * into p_game;
  end if;
  if v_b = 'hit' and p_game.next_card >= pg_catalog.cardinality(p_game.deck) then v_b := 'stand'; end if;
  if v_b = 'hit' then
    update private.blackjack_games set hand_b = hand_b || deck[next_card + 1], next_card = next_card + 1
      where id = p_game.id returning * into p_game;
  end if;
  -- A hit never stops the player, even on 21 or a bust (1.40).
  update private.blackjack_games set done_a = done_a or coalesce(v_a in ('stand','timeout'), false),
      done_b = done_b or coalesce(v_b in ('stand','timeout'), false)
    where id = p_game.id returning * into p_game;
  insert into festival_ops.blackjack_round_log(game_id, round, action_a, action_b) values (p_game.id, v_round.round, v_a, v_b);
  if p_game.done_a and p_game.done_b then
    delete from festival_ops.blackjack_round where game_id = p_game.id;
    return private.blackjack_settle(p_game);
  end if;
  update festival_ops.blackjack_round set round = round + 1, deadline = festival_ops.blackjack_round_deadline(),
    choice_a = null, choice_b = null where game_id = p_game.id;
  update private.blackjack_games set version = version + 1 where id = p_game.id returning * into p_game;
  return p_game;
end $$;

-- Reveals the open round once its time is up. Caller holds the game row lock.
create function festival_ops.blackjack_due(p_game private.blackjack_games) returns private.blackjack_games
language plpgsql security definer set search_path='' as $$
begin
  if p_game.status = 'playing' and exists (select 1 from festival_ops.blackjack_round
      where game_id = p_game.id and deadline < clock_timestamp()) then
    return festival_ops.blackjack_resolve(p_game);
  end if;
  return p_game;
end $$;

-- Settles rounds nobody is watching (both players left); pg_cron runs it every minute.
create function festival_ops.blackjack_round_sweep() returns integer
language plpgsql security definer set search_path='' as $$
declare v_game private.blackjack_games; v_count integer := 0;
begin
  perform festival_ops.blackjack_expire_queue();
  for v_game in select g.* from private.blackjack_games g join festival_ops.blackjack_round r on r.game_id = g.id
      where g.status = 'playing' and r.deadline < clock_timestamp() for update of g skip locked loop
    perform festival_ops.blackjack_resolve(v_game);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- A game view with the opponent's whole name, who forfeited and the round: the round number and deadline,
-- my choice, whether the opponent has chosen (never what), and what both did in the last revealed round.
create or replace function festival_ops.blackjack_named(p_view jsonb, p_me integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_game private.blackjack_games; v_side text; v_name text; v_forfeit integer;
  v_round festival_ops.blackjack_round; v_log festival_ops.blackjack_round_log;
begin
  if p_view is null or p_view->>'id' is null then return p_view; end if;
  select * into v_game from private.blackjack_games where id = (p_view->>'id')::uuid;
  if not found then return p_view; end if;
  v_side := case when v_game.player_a = p_me then 'a' else 'b' end;
  select nullif(btrim(name), '') into v_name from public.users
    where id = case when v_side = 'a' then v_game.player_b else v_game.player_a end;
  select f.user_id into v_forfeit from festival_ops.blackjack_forfeit f where f.game_id = v_game.id;
  select * into v_round from festival_ops.blackjack_round where game_id = v_game.id and v_game.status = 'playing';
  select * into v_log from festival_ops.blackjack_round_log where game_id = v_game.id order by round desc limit 1;
  return p_view || jsonb_build_object('turnDrawn', 0,
      'forfeit', case when v_forfeit is null then null when v_forfeit = p_me then 'me' else 'opponent' end,
      'round', v_round.round, 'roundDeadline', v_round.deadline,
      'myChoice', case when v_side = 'a' then v_round.choice_a else v_round.choice_b end,
      'opponentReady', coalesce((case when v_side = 'a' then v_round.choice_b else v_round.choice_a end) is not null, false),
      'lastRound', case when v_log.game_id is null then null else jsonb_build_object('round', v_log.round,
        'me', case when v_side = 'a' then v_log.action_a else v_log.action_b end,
        'opponent', case when v_side = 'a' then v_log.action_b else v_log.action_a end) end)
    || case when v_name is not null then jsonb_build_object('opponentName', v_name) else '{}'::jsonb end;
end $$;

create or replace function public.festival_blackjack_state() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_queue festival_ops.blackjack_queue;
begin
  perform festival_ops.blackjack_expire_waiting();
  perform festival_ops.blackjack_expire_queue();
  select * into v_game from private.blackjack_games where status in ('waiting','playing') and v_me.id in (player_a, player_b) for update;
  if found then
    v_game := festival_ops.blackjack_due(private.blackjack_advance(v_game));
    return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id);
  end if;
  select * into v_queue from festival_ops.blackjack_queue where user_id = v_me.id and status = 'waiting';
  if found then return festival_ops.blackjack_queue_view(v_queue); end if;
  -- Otherwise the latest ending: a game, or a queue entry that was cancelled or timed out after it.
  select * into v_game from private.blackjack_games where status in ('finished','cancelled') and v_me.id in (player_a, player_b)
    order by coalesce(finished_at, created_at) desc limit 1;
  select * into v_queue from festival_ops.blackjack_queue where user_id = v_me.id and status in ('cancelled','expired')
    order by ended_at desc limit 1;
  if v_queue.id is not null and (v_game.id is null or v_queue.ended_at > coalesce(v_game.finished_at, v_game.created_at)) then
    return festival_ops.blackjack_queue_view(v_queue);
  end if;
  if v_game.id is not null then return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id); end if;
  return null;
end $$;

create or replace function public.festival_blackjack_lobby() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_set festival_ops.blackjack_settings;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  perform festival_ops.blackjack_expire_waiting();
  perform festival_ops.blackjack_expire_queue();
  select * into v_set from festival_ops.blackjack_settings where singleton;
  return jsonb_build_object('waiting', (select count(*) from festival_ops.blackjack_queue where status = 'waiting'),
    'maxPerTurn', 1, 'maxDraws', v_set.max_draws, 'simultaneous', true,
    'matchSeconds', extract(epoch from festival_ops.blackjack_match_limit())::integer);
end $$;

create or replace function public.festival_blackjack_join() returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_me public.users := private.blackjack_me(); v_game private.blackjack_games;
  v_queue festival_ops.blackjack_queue; v_opp public.users; v_stake constant integer := 300;
begin
  -- ORBIT's queue lock also guards rematches, so a player is never placed in two games at once.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('orbit-blackjack-queue', 0));
  perform festival_ops.blackjack_expire_waiting();
  perform festival_ops.blackjack_expire_queue();
  select * into v_game from private.blackjack_games where status in ('waiting','playing') and v_me.id in (player_a, player_b) for update;
  if found then
    return festival_ops.blackjack_named(private.blackjack_view(festival_ops.blackjack_due(private.blackjack_advance(v_game)), v_me.id), v_me.id);
  end if;
  select * into v_queue from festival_ops.blackjack_queue where user_id = v_me.id and status = 'waiting';
  if found then return festival_ops.blackjack_queue_view(v_queue); end if;
  if v_me.money < v_stake then raise exception using message = 'INSUFFICIENT_POINTS'; end if;

  for v_queue in select * from festival_ops.blackjack_queue where status = 'waiting' and user_id <> v_me.id
      order by joined_at for update skip locked loop
    select * into v_opp from public.users where id = v_queue.user_id;
    if v_opp.money < v_stake or exists (select 1 from private.blackjack_games g
        where g.status in ('waiting','playing') and v_opp.id in (g.player_a, g.player_b)) then
      -- Points spent or already in another game meanwhile: this entry can no longer be matched.
      update festival_ops.blackjack_queue set status = 'expired', ended_at = clock_timestamp() where id = v_queue.id;
      continue;
    end if;
    v_game := festival_ops.blackjack_start(v_opp.id, v_me.id, v_stake);
    update festival_ops.blackjack_queue set status = 'matched', ended_at = clock_timestamp(), game_id = v_game.id where id = v_queue.id;
    return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id);
  end loop;

  insert into festival_ops.blackjack_queue(user_id) values (v_me.id) returning * into v_queue;
  return festival_ops.blackjack_queue_view(v_queue);
end $$;

-- Leaves the festival queue. Nothing to refund: the stake is taken only when players are matched.
create function public.festival_blackjack_cancel() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_me public.users := private.blackjack_me(); v_queue festival_ops.blackjack_queue;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('orbit-blackjack-queue', 0));
  update festival_ops.blackjack_queue set status = 'cancelled', ended_at = clock_timestamp()
    where user_id = v_me.id and status = 'waiting' returning * into v_queue;
  if found then return festival_ops.blackjack_queue_view(v_queue); end if;
  -- A waiting game from before 1.49 is cancelled and refunded by ORBIT's own function.
  if exists (select 1 from private.blackjack_games where status = 'waiting' and player_a = v_me.id) then
    return public.orbit_blackjack_cancel();
  end if;
  -- Matched meanwhile, or nothing to cancel: the current state.
  return public.festival_blackjack_state();
end $$;

-- p_version is the round the player saw (the game version changes only when a round is revealed), so a late
-- or repeated tap returns the current state. 'pass' and p_count stay for older screens; 'pass' is a stand.
create or replace function public.festival_blackjack_action(p_game_id uuid, p_action text, p_version integer, p_count integer default 1) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_side text;
  v_round festival_ops.blackjack_round; v_set festival_ops.blackjack_settings; v_choice text;
begin
  if p_game_id is null or p_action is null or p_action not in ('hit','stand','pass') or p_version is null
    or (p_action = 'hit' and p_count is distinct from 1) then
    raise exception using message = 'INVALID_ACTION';
  end if;
  select * into v_game from private.blackjack_games where id = p_game_id and v_me.id in (player_a, player_b) for update;
  if not found then raise exception using message = 'GAME_NOT_FOUND'; end if;
  v_game := festival_ops.blackjack_due(v_game);
  if v_game.version <> p_version then return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id); end if;
  v_side := case when v_game.player_a = v_me.id then 'a' else 'b' end;
  select * into v_round from festival_ops.blackjack_round where game_id = v_game.id for update;
  if not found or v_game.status <> 'playing' or (case when v_side = 'a' then v_game.done_a else v_game.done_b end) then
    raise exception using message = 'NOT_YOUR_TURN';
  end if;
  -- A choice is final for the round.
  if (case when v_side = 'a' then v_round.choice_a else v_round.choice_b end) is not null then
    return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id);
  end if;
  v_choice := case when p_action = 'hit' then 'hit' else 'stand' end;
  if v_choice = 'hit' then
    select * into v_set from festival_ops.blackjack_settings where singleton;
    if v_set.max_draws is not null
      and pg_catalog.cardinality(case when v_side = 'a' then v_game.hand_a else v_game.hand_b end) - 2 >= v_set.max_draws then
      raise exception using message = 'CARD_LIMIT';
    end if;
  end if;
  if v_side = 'a' then update festival_ops.blackjack_round set choice_a = v_choice where game_id = v_game.id returning * into v_round;
  else update festival_ops.blackjack_round set choice_b = v_choice where game_id = v_game.id returning * into v_round;
  end if;
  -- Both have chosen (or the other player has stopped): reveal the round now.
  if (v_round.choice_a is not null or v_game.done_a) and (v_round.choice_b is not null or v_game.done_b) then
    v_game := festival_ops.blackjack_resolve(v_game);
  end if;
  return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id);
end $$;

-- The 1.44 function; the new game starts with simultaneous rounds, and a player in the queue cannot accept.
create or replace function public.festival_blackjack_rematch(p_game_id uuid, p_choice text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_me public.users := private.blackjack_me();
  v_game private.blackjack_games; v_next private.blackjack_games;
  v_mine festival_ops.blackjack_rematch; v_theirs festival_ops.blackjack_rematch;
  v_opp integer; v_status text;
begin
  if p_game_id is null or p_choice is null or p_choice not in ('watch','accept','decline') then raise exception 'INVALID_INPUT'; end if;
  -- The same lock as the joins, so a player is never placed in two games at once.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('orbit-blackjack-queue', 0));
  select * into v_game from private.blackjack_games where id = p_game_id and v_me.id in (player_a, player_b);
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if v_game.status <> 'finished' or v_game.finished_at < clock_timestamp() - interval '10 minutes' then raise exception 'REMATCH_EXPIRED'; end if;
  v_opp := case when v_game.player_a = v_me.id then v_game.player_b else v_game.player_a end;

  if p_choice = 'accept' then
    if exists (select 1 from private.blackjack_games g where g.status in ('waiting','playing') and v_me.id in (g.player_a, g.player_b))
      or exists (select 1 from festival_ops.blackjack_queue q where q.status = 'waiting' and q.user_id = v_me.id)
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
    when exists (select 1 from private.blackjack_games g where g.status in ('waiting','playing') and v_opp in (g.player_a, g.player_b))
      or exists (select 1 from festival_ops.blackjack_queue q where q.status = 'waiting' and q.user_id = v_opp) then 'decline'
    when v_theirs.user_id is null then case when v_game.finished_at > clock_timestamp() - interval '20 seconds' then 'waiting' else 'decline' end
    when v_theirs.choice = 'decline' or v_theirs.seen_at < clock_timestamp() - interval '10 seconds' then 'decline'
    else v_theirs.choice end;

  if v_mine.choice = 'accept' and v_mine.next_game_id is null and v_status = 'accept' then
    if (select money from public.users where id = v_opp) < v_game.stake then
      -- The opponent spent their points meanwhile: their accept no longer holds.
      update festival_ops.blackjack_rematch set choice = 'decline' where game_id = v_game.id and user_id = v_opp;
      v_status := 'decline';
    else
      v_next := festival_ops.blackjack_start(v_opp, v_me.id, v_game.stake);
      update festival_ops.blackjack_rematch set next_game_id = v_next.id where game_id = v_game.id;
      v_mine.next_game_id := v_next.id;
    end if;
  elsif v_mine.next_game_id is not null then
    select * into v_next from private.blackjack_games where id = v_mine.next_game_id;
  end if;

  return jsonb_build_object('me', v_mine.choice, 'opponent', v_status,
    'game', case when v_next.id is not null then festival_ops.blackjack_named(private.blackjack_view(v_next, v_me.id), v_me.id) end);
end $$;

-- The 1.42 function; the open round goes with the game.
create or replace function public.festival_blackjack_forfeit(p_game_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_side text;
begin
  if p_game_id is null then raise exception using message = 'INVALID_ACTION'; end if;
  select * into v_game from private.blackjack_games where id = p_game_id and v_me.id in (player_a, player_b) for update;
  if not found then raise exception using message = 'GAME_NOT_FOUND'; end if;
  v_game := festival_ops.blackjack_due(private.blackjack_advance(v_game));
  -- A game that ended meanwhile (both stood, or time ran out) keeps its own result.
  if v_game.status = 'playing' then
    v_side := case when v_game.player_a = v_me.id then 'a' else 'b' end;
    perform private.blackjack_move_points(case when v_side = 'a' then v_game.player_b else v_game.player_a end,
      v_game.stake * 2, v_game.id, 'payout');
    update private.blackjack_games set status = 'finished', result = case when v_side = 'a' then 'b' else 'a' end,
      turn = null, turn_deadline = null, done_a = true, done_b = true, finished_at = clock_timestamp(), version = version + 1
    where id = v_game.id returning * into v_game;
    insert into festival_ops.blackjack_forfeit(game_id, user_id) values (v_game.id, v_me.id);
    delete from festival_ops.blackjack_round where game_id = v_game.id;
    -- The player who left does not want a rematch.
    insert into festival_ops.blackjack_rematch(game_id, user_id, choice) values (v_game.id, v_me.id, 'decline')
      on conflict (game_id, user_id) do update set choice = 'decline', seen_at = clock_timestamp();
  end if;
  return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id);
end $$;

-- Only the per-game card limit is set now (maxPerTurn is ignored if an older screen sends it). Waiting
-- counts the festival queue; recent games show how many rounds they took.
create or replace function public.festival_blackjack_admin(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  me jsonb; u integer; e uuid; v_set festival_ops.blackjack_settings; v_total integer;
  v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
begin
  if p_action is null or p_action not in ('status','save') or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or length(p_payload::text) > 1000 then raise exception 'INVALID_INPUT'; end if;
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean, true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean, false) then raise exception 'ADMIN_REQUIRED'; end if;

  if p_action = 'save' then
    if coalesce(jsonb_typeof(p_payload->'maxDraws'), 'missing') not in ('number','null') then raise exception 'INVALID_INPUT'; end if;
    v_total := (p_payload->>'maxDraws')::numeric;
    if v_total is not null and ((p_payload->>'maxDraws')::numeric <> v_total or v_total not between 1 and 20) then
      raise exception 'INVALID_INPUT';
    end if;
    update festival_ops.blackjack_settings set max_draws = v_total, updated_at = now(), updated_by = u
      where singleton returning * into v_set;
    select id into e from festival_ops.events where current;
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values (e, u, 'blackjack_settings', 'blackjack', '한 판에 ' || coalesce(v_total || '장', '제한 없음'));
  end if;

  select * into v_set from festival_ops.blackjack_settings where singleton;
  return jsonb_build_object(
    'settings', jsonb_build_object('maxDraws', v_set.max_draws, 'updatedAt', v_set.updated_at,
      'updatedBy', (select name from public.users where id = v_set.updated_by)),
    'waiting', (select count(*) from festival_ops.blackjack_queue where status = 'waiting'
      and joined_at > clock_timestamp() - festival_ops.blackjack_match_limit()),
    'playing', (select count(*) from private.blackjack_games where status = 'playing'),
    'finishedToday', (select count(*) from private.blackjack_games where status = 'finished' and finished_at >= v_today),
    'stakedToday', (select coalesce(sum(stake) * 2, 0) from private.blackjack_games where status = 'finished' and finished_at >= v_today),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'status', g.status, 'stake', g.stake, 'result', g.result,
        'playerA', btrim(a.name), 'playerB', btrim(b.name),
        'cardsA', pg_catalog.cardinality(g.hand_a), 'cardsB', pg_catalog.cardinality(g.hand_b),
        'totalA', case when g.status = 'finished' then private.blackjack_total(g.hand_a) end,
        'totalB', case when g.status = 'finished' then private.blackjack_total(g.hand_b) end,
        'forfeit', case when f.user_id is null then null when f.user_id = g.player_a then 'a' else 'b' end,
        'rounds', (select max(l.round) from festival_ops.blackjack_round_log l where l.game_id = g.id),
        'createdAt', g.created_at, 'finishedAt', g.finished_at) order by g.created_at desc)
      from (select * from private.blackjack_games order by created_at desc limit 30) g
      left join public.users a on a.id = g.player_a left join public.users b on b.id = g.player_b
      left join festival_ops.blackjack_forfeit f on f.game_id = g.id), '[]'::jsonb));
end $$;

revoke all on function festival_ops.blackjack_round_deadline(), festival_ops.blackjack_expire_queue(),
  festival_ops.blackjack_queue_view(festival_ops.blackjack_queue), festival_ops.blackjack_start(integer, integer, integer),
  festival_ops.blackjack_resolve(private.blackjack_games), festival_ops.blackjack_due(private.blackjack_games),
  festival_ops.blackjack_round_sweep() from public, anon, authenticated;
revoke all on function public.festival_blackjack_cancel() from public, anon, authenticated;
grant execute on function public.festival_blackjack_cancel() to authenticated;

select cron.schedule('festival-blackjack-round-sweep', '* * * * *', 'select festival_ops.blackjack_round_sweep()');
notify pgrst, 'reload schema';
commit;

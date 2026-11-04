-- Rollback for blackjack-simultaneous.sql (1.49): back to the 1.44 alternating turns.
-- The functions below are the 1.44 definitions as they were in the operations DB on 2026-11-02.
-- Apply only while no game is in progress: a simultaneous game cannot continue under the old functions.
-- Players still in the festival queue are dropped (nothing to refund; the stake is taken only at a match).
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if exists (select 1 from private.blackjack_games where status in ('waiting','playing')) then
    raise exception 'BLACKJACK_GAMES_IN_PROGRESS';
  end if;
end $$;

select cron.unschedule('festival-blackjack-round-sweep');

-- festival_ops.blackjack_named(p_view jsonb, p_me integer)
CREATE OR REPLACE FUNCTION festival_ops.blackjack_named(p_view jsonb, p_me integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_game private.blackjack_games; v_side text; v_name text; v_drawn integer; v_forfeit integer;
begin
  if p_view is null or p_view->>'id' is null then return p_view; end if;
  select * into v_game from private.blackjack_games where id = (p_view->>'id')::uuid;
  if not found then return p_view; end if;
  v_side := case when v_game.player_a = p_me then 'a' else 'b' end;
  select nullif(btrim(name), '') into v_name from public.users
    where id = case when v_side = 'a' then v_game.player_b else v_game.player_a end;
  select t.drawn into v_drawn from festival_ops.blackjack_turn t
    where t.game_id = v_game.id and t.side = v_side and t.at_version = v_game.version
      and v_game.status = 'playing' and v_game.turn = v_side;
  select f.user_id into v_forfeit from festival_ops.blackjack_forfeit f where f.game_id = v_game.id;
  return p_view || jsonb_build_object('turnDrawn', coalesce(v_drawn, 0),
      'forfeit', case when v_forfeit is null then null when v_forfeit = p_me then 'me' else 'opponent' end)
    || case when v_name is not null then jsonb_build_object('opponentName', v_name) else '{}'::jsonb end;
end $function$;

-- public.festival_blackjack_state()
CREATE OR REPLACE FUNCTION public.festival_blackjack_state()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_me public.users := private.blackjack_me();
begin
  perform festival_ops.blackjack_expire_waiting();
  return festival_ops.blackjack_named(public.orbit_blackjack_state(), v_me.id);
end $function$;

-- public.festival_blackjack_lobby()
CREATE OR REPLACE FUNCTION public.festival_blackjack_lobby()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_set festival_ops.blackjack_settings;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  perform festival_ops.blackjack_expire_waiting();
  select * into v_set from festival_ops.blackjack_settings where singleton;
  return jsonb_build_object('waiting', (select count(*) from private.blackjack_games
      where status = 'waiting' and created_at > clock_timestamp() - festival_ops.blackjack_match_limit()),
    'maxPerTurn', coalesce(v_set.max_per_turn, 1), 'maxDraws', v_set.max_draws,
    'matchSeconds', extract(epoch from festival_ops.blackjack_match_limit())::integer);
end $function$;

-- public.festival_blackjack_join()
CREATE OR REPLACE FUNCTION public.festival_blackjack_join()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_stake constant integer := 300;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('orbit-blackjack-queue', 0));
  perform festival_ops.blackjack_expire_waiting();
  select * into v_game from private.blackjack_games
    where status in ('waiting','playing') and (player_a = v_me.id or player_b = v_me.id) for update;
  if found then return festival_ops.blackjack_named(private.blackjack_view(private.blackjack_advance(v_game), v_me.id), v_me.id); end if;
  if v_me.money < v_stake then raise exception using message = 'INSUFFICIENT_POINTS'; end if;

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
end $function$;

-- public.festival_blackjack_action(p_game_id uuid, p_action text, p_version integer, p_count integer)
CREATE OR REPLACE FUNCTION public.festival_blackjack_action(p_game_id uuid, p_action text, p_version integer, p_count integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_side text; v_hand smallint[];
  v_set festival_ops.blackjack_settings; v_turn integer; v_pass boolean;
begin
  if p_game_id is null or p_action is null or p_action not in ('hit','stand','pass') or p_version is null
    or (p_action = 'hit' and p_count is distinct from 1) then
    raise exception using message = 'INVALID_ACTION';
  end if;
  select * into v_game from private.blackjack_games where id = p_game_id and (player_a = v_me.id or player_b = v_me.id) for update;
  if not found then raise exception using message = 'GAME_NOT_FOUND'; end if;
  v_game := private.blackjack_advance(v_game);
  if v_game.version <> p_version then return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id); end if;
  v_side := case when v_game.player_a = v_me.id then 'a' else 'b' end;
  if v_game.status <> 'playing' or v_game.turn <> v_side then raise exception using message = 'NOT_YOUR_TURN'; end if;

  v_hand := case when v_side = 'a' then v_game.hand_a else v_game.hand_b end;
  select coalesce((select drawn from festival_ops.blackjack_turn
    where game_id = v_game.id and side = v_side and at_version = v_game.version), 0) into v_turn;
  select * into v_set from festival_ops.blackjack_settings where singleton;
  if p_action = 'hit' then
    if v_turn >= coalesce(v_set.max_per_turn, 1)
      or (v_set.max_draws is not null and pg_catalog.cardinality(v_hand) - 2 >= v_set.max_draws) then
      raise exception using message = 'CARD_LIMIT';
    end if;
  end if;
  delete from festival_ops.blackjack_turn where game_id = v_game.id;

  -- A stand after a card this turn passes the turn while there is still something to draw later.
  v_pass := p_action in ('stand','pass') and v_turn > 0
    and (v_set.max_draws is null or pg_catalog.cardinality(v_hand) - 2 < v_set.max_draws)
    and v_game.next_card < pg_catalog.cardinality(v_game.deck)
    and not (case when v_side = 'a' then v_game.done_b else v_game.done_a end);
  if v_pass then
    return festival_ops.blackjack_named(private.blackjack_view(private.blackjack_next_turn(v_game), v_me.id), v_me.id);
  end if;

  -- With the 52-card deck used up a hit has no card to give, so it stands.
  if p_action in ('stand','pass') or v_game.next_card >= pg_catalog.cardinality(v_game.deck) then
    if v_side = 'a' then update private.blackjack_games set done_a = true where id = v_game.id returning * into v_game;
    else update private.blackjack_games set done_b = true where id = v_game.id returning * into v_game;
    end if;
  else
    -- A hit adds one card: 21 or a bust does not stand (1.40).
    v_hand := v_hand || v_game.deck[v_game.next_card + 1];
    if v_side = 'a' then update private.blackjack_games set hand_a = v_hand, next_card = next_card + 1 where id = v_game.id returning * into v_game;
    else update private.blackjack_games set hand_b = v_hand, next_card = next_card + 1 where id = v_game.id returning * into v_game;
    end if;
    v_turn := v_turn + 1;
    if v_turn < coalesce(v_set.max_per_turn, 1) then
      -- The turn stays with the player: a new time limit, and this turn's cards are counted.
      update private.blackjack_games set turn_deadline = clock_timestamp() + private.blackjack_turn_limit(), version = version + 1
        where id = v_game.id returning * into v_game;
      insert into festival_ops.blackjack_turn(game_id, side, drawn, at_version) values (v_game.id, v_side, v_turn, v_game.version);
      return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id);
    end if;
  end if;
  return festival_ops.blackjack_named(private.blackjack_view(private.blackjack_next_turn(v_game), v_me.id), v_me.id);
end $function$;

-- public.festival_blackjack_rematch(p_game_id uuid, p_choice text)
CREATE OR REPLACE FUNCTION public.festival_blackjack_rematch(p_game_id uuid, p_choice text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    'game', case when v_next.id is not null then festival_ops.blackjack_named(private.blackjack_view(v_next, v_me.id), v_me.id) end);
end $function$;

-- public.festival_blackjack_forfeit(p_game_id uuid)
CREATE OR REPLACE FUNCTION public.festival_blackjack_forfeit(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_side text;
begin
  if p_game_id is null then raise exception using message = 'INVALID_ACTION'; end if;
  select * into v_game from private.blackjack_games where id = p_game_id and (player_a = v_me.id or player_b = v_me.id) for update;
  if not found then raise exception using message = 'GAME_NOT_FOUND'; end if;
  v_game := private.blackjack_advance(v_game);
  -- A game that ended meanwhile (both stood, or time ran out) keeps its own result.
  if v_game.status = 'playing' then
    v_side := case when v_game.player_a = v_me.id then 'a' else 'b' end;
    perform private.blackjack_move_points(case when v_side = 'a' then v_game.player_b else v_game.player_a end,
      v_game.stake * 2, v_game.id, 'payout');
    update private.blackjack_games set status = 'finished', result = case when v_side = 'a' then 'b' else 'a' end,
      turn = null, turn_deadline = null, done_a = true, done_b = true, finished_at = clock_timestamp(), version = version + 1
    where id = v_game.id returning * into v_game;
    insert into festival_ops.blackjack_forfeit(game_id, user_id) values (v_game.id, v_me.id);
    delete from festival_ops.blackjack_turn where game_id = v_game.id;
    -- The player who left does not want a rematch.
    insert into festival_ops.blackjack_rematch(game_id, user_id, choice) values (v_game.id, v_me.id, 'decline')
      on conflict (game_id, user_id) do update set choice = 'decline', seen_at = clock_timestamp();
  end if;
  return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id);
end $function$;

-- public.festival_blackjack_admin(p_action text, p_payload jsonb)
CREATE OR REPLACE FUNCTION public.festival_blackjack_admin(p_action text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me jsonb; u integer; e uuid; v_set festival_ops.blackjack_settings; v_per integer; v_total integer;
  v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
begin
  if p_action is null or p_action not in ('status','save') or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or length(p_payload::text) > 1000 then raise exception 'INVALID_INPUT'; end if;
  me := festival_nfc_private.current_profile(); u := (me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean, true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean, false) then raise exception 'ADMIN_REQUIRED'; end if;

  if p_action = 'save' then
    if jsonb_typeof(p_payload->'maxPerTurn') is distinct from 'number'
      or coalesce(jsonb_typeof(p_payload->'maxDraws'), 'missing') not in ('number','null') then raise exception 'INVALID_INPUT'; end if;
    v_per := (p_payload->>'maxPerTurn')::numeric; v_total := (p_payload->>'maxDraws')::numeric;
    if (p_payload->>'maxPerTurn')::numeric <> v_per or v_per not between 1 and 5
      or (v_total is not null and ((p_payload->>'maxDraws')::numeric <> v_total or v_total not between 1 and 20))
      or (v_total is not null and v_per > v_total) then raise exception 'INVALID_INPUT'; end if;
    update festival_ops.blackjack_settings set max_per_turn = v_per, max_draws = v_total, updated_at = now(), updated_by = u
      where singleton returning * into v_set;
    select id into e from festival_ops.events where current;
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values (e, u, 'blackjack_settings', 'blackjack',
        '한 차례에 ' || v_per || '장 · 한 판에 ' || coalesce(v_total || '장', '제한 없음'));
  end if;

  select * into v_set from festival_ops.blackjack_settings where singleton;
  return jsonb_build_object(
    'settings', jsonb_build_object('maxPerTurn', v_set.max_per_turn, 'maxDraws', v_set.max_draws, 'updatedAt', v_set.updated_at,
      'updatedBy', (select name from public.users where id = v_set.updated_by)),
    'waiting', (select count(*) from private.blackjack_games where status = 'waiting' and created_at > clock_timestamp() - interval '3 minutes'),
    'playing', (select count(*) from private.blackjack_games where status = 'playing'),
    'finishedToday', (select count(*) from private.blackjack_games where status = 'finished' and finished_at >= v_today),
    'stakedToday', (select coalesce(sum(stake) * 2, 0) from private.blackjack_games where status = 'finished' and finished_at >= v_today),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'status', g.status, 'stake', g.stake, 'result', g.result,
        'playerA', btrim(a.name), 'playerB', btrim(b.name),
        'cardsA', pg_catalog.cardinality(g.hand_a), 'cardsB', pg_catalog.cardinality(g.hand_b),
        'totalA', case when g.status = 'finished' then private.blackjack_total(g.hand_a) end,
        'totalB', case when g.status = 'finished' then private.blackjack_total(g.hand_b) end,
        'forfeit', case when f.user_id is null then null when f.user_id = g.player_a then 'a' else 'b' end,
        'createdAt', g.created_at, 'finishedAt', g.finished_at) order by g.created_at desc)
      from (select * from private.blackjack_games order by created_at desc limit 30) g
      left join public.users a on a.id = g.player_a left join public.users b on b.id = g.player_b
      left join festival_ops.blackjack_forfeit f on f.game_id = g.id), '[]'::jsonb));
end $function$;

drop function public.festival_blackjack_cancel();
drop function festival_ops.blackjack_round_sweep();
drop function festival_ops.blackjack_due(private.blackjack_games);
drop function festival_ops.blackjack_resolve(private.blackjack_games);
drop function festival_ops.blackjack_start(integer, integer, integer);
drop function festival_ops.blackjack_queue_view(festival_ops.blackjack_queue);
drop function festival_ops.blackjack_expire_queue();
drop function festival_ops.blackjack_round_deadline();
drop table festival_ops.blackjack_round_log;
drop table festival_ops.blackjack_round;
drop table festival_ops.blackjack_queue;

notify pgrst, 'reload schema';
commit;

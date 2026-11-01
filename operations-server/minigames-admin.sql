-- 1.41 미니게임 관리 (관리 마법사), blackjack card limits and the opponent's full name.
-- ORBIT's orbit_* functions and private.* helpers are not changed.
--   festival_ops.blackjack_settings  - one row: how many cards one hit may draw (1-5, default 1) and how
--                                      many cards a player may draw in one game after the first two
--                                      (null = no limit, else 1-20). Changed in 관리 마법사 → 미니게임 관리.
--   festival_blackjack_action        - takes p_count (cards for this hit, default 1) and enforces the limits
--                                      (CARD_LIMIT). Replaces the 1.40 three-argument function.
--   festival_blackjack_state         - orbit_blackjack_state with the opponent's full name.
--   festival_blackjack_join/rematch  - the same games as 1.40, also with the opponent's full name.
--   festival_blackjack_lobby         - also returns the card limits so the table can show them.
--   festival_blackjack_admin         - status (settings, counts, recent games) and save, admins only.
-- private.blackjack_view masks the opponent's name (first and last letter); the festival functions put the
-- whole public.users.name back (requested 2026-11-01).
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table festival_ops.blackjack_settings (
  singleton boolean primary key default true check (singleton),
  max_per_hit smallint not null default 1 check (max_per_hit between 1 and 5),
  max_draws smallint check (max_draws between 1 and 20),
  updated_at timestamptz not null default now(),
  updated_by integer references public.users(id) on delete set null
);
insert into festival_ops.blackjack_settings(singleton) values (true);
alter table festival_ops.blackjack_settings enable row level security;
revoke all on table festival_ops.blackjack_settings from public, anon, authenticated;

-- A game view with the opponent's whole name instead of the masked one.
create function festival_ops.blackjack_named(p_view jsonb, p_me integer) returns jsonb
language sql stable security definer set search_path='' as $$
  select case when p_view is null or p_view->>'id' is null then p_view
    else coalesce((select jsonb_set(p_view, '{opponentName}', to_jsonb(btrim(u.name)))
      from private.blackjack_games g
      join public.users u on u.id = case when g.player_a = p_me then g.player_b else g.player_a end
      where g.id = (p_view->>'id')::uuid and nullif(btrim(u.name), '') is not null), p_view) end
$$;
revoke all on function festival_ops.blackjack_named(jsonb, integer) from public, anon, authenticated;

create function public.festival_blackjack_state() returns jsonb
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
    'maxPerHit', coalesce(v_set.max_per_hit, 1), 'maxDraws', v_set.max_draws);
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

drop function public.festival_blackjack_action(uuid, text, integer);
create function public.festival_blackjack_action(p_game_id uuid, p_action text, p_version integer, p_count integer default 1) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_side text; v_hand smallint[];
  v_set festival_ops.blackjack_settings; v_count integer; v_drawn integer;
begin
  if p_game_id is null or p_action is null or p_action not in ('hit','stand') or p_version is null
    or (p_action = 'hit' and (p_count is null or p_count < 1)) then
    raise exception using message = 'INVALID_ACTION';
  end if;
  select * into v_game from private.blackjack_games where id = p_game_id and (player_a = v_me.id or player_b = v_me.id) for update;
  if not found then raise exception using message = 'GAME_NOT_FOUND'; end if;
  v_game := private.blackjack_advance(v_game);
  if v_game.version <> p_version then return festival_ops.blackjack_named(private.blackjack_view(v_game, v_me.id), v_me.id); end if;
  v_side := case when v_game.player_a = v_me.id then 'a' else 'b' end;
  if v_game.status <> 'playing' or v_game.turn <> v_side then raise exception using message = 'NOT_YOUR_TURN'; end if;

  v_hand := case when v_side = 'a' then v_game.hand_a else v_game.hand_b end;
  if p_action = 'hit' then
    select * into v_set from festival_ops.blackjack_settings where singleton;
    v_drawn := pg_catalog.cardinality(v_hand) - 2;
    if p_count > coalesce(v_set.max_per_hit, 1) or (v_set.max_draws is not null and v_drawn + p_count > v_set.max_draws) then
      raise exception using message = 'CARD_LIMIT';
    end if;
  end if;
  -- With the 52-card deck used up a hit has no card to give, so it stands.
  v_count := case when p_action = 'hit' then least(p_count, pg_catalog.cardinality(v_game.deck) - v_game.next_card) else 0 end;
  if v_count <= 0 then
    if v_side = 'a' then update private.blackjack_games set done_a = true where id = v_game.id returning * into v_game;
    else update private.blackjack_games set done_b = true where id = v_game.id returning * into v_game;
    end if;
  else
    -- A hit only adds cards: 21 or a bust does not stand (1.40).
    v_hand := v_hand || v_game.deck[v_game.next_card + 1 : v_game.next_card + v_count];
    if v_side = 'a' then update private.blackjack_games set hand_a = v_hand, next_card = next_card + v_count where id = v_game.id returning * into v_game;
    else update private.blackjack_games set hand_b = v_hand, next_card = next_card + v_count where id = v_game.id returning * into v_game;
    end if;
  end if;
  return festival_ops.blackjack_named(private.blackjack_view(private.blackjack_next_turn(v_game), v_me.id), v_me.id);
end $$;

-- festival_blackjack_rematch: the 1.40 function; the new game carries the opponent's full name.
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
    'game', case when v_next.id is not null then festival_ops.blackjack_named(private.blackjack_view(v_next, v_me.id), v_me.id) end);
end $$;

create function public.festival_blackjack_admin(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
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
    if jsonb_typeof(p_payload->'maxPerHit') is distinct from 'number'
      or coalesce(jsonb_typeof(p_payload->'maxDraws'), 'missing') not in ('number','null') then raise exception 'INVALID_INPUT'; end if;
    v_per := (p_payload->>'maxPerHit')::numeric; v_total := (p_payload->>'maxDraws')::numeric;
    if (p_payload->>'maxPerHit')::numeric <> v_per or v_per not between 1 and 5
      or (v_total is not null and ((p_payload->>'maxDraws')::numeric <> v_total or v_total not between 1 and 20))
      or (v_total is not null and v_per > v_total) then raise exception 'INVALID_INPUT'; end if;
    update festival_ops.blackjack_settings set max_per_hit = v_per, max_draws = v_total, updated_at = now(), updated_by = u
      where singleton returning * into v_set;
    select id into e from festival_ops.events where current;
    insert into festival_ops.audit(event_id, actor_id, action, target, reason)
      values (e, u, 'blackjack_settings', 'blackjack',
        '한 번에 ' || v_per || '장 · 한 판에 ' || coalesce(v_total || '장', '제한 없음'));
  end if;

  select * into v_set from festival_ops.blackjack_settings where singleton;
  return jsonb_build_object(
    'settings', jsonb_build_object('maxPerHit', v_set.max_per_hit, 'maxDraws', v_set.max_draws, 'updatedAt', v_set.updated_at,
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
        'createdAt', g.created_at, 'finishedAt', g.finished_at) order by g.created_at desc)
      from (select * from private.blackjack_games order by created_at desc limit 30) g
      left join public.users a on a.id = g.player_a left join public.users b on b.id = g.player_b), '[]'::jsonb));
end $$;

revoke all on function public.festival_blackjack_state(), public.festival_blackjack_action(uuid, text, integer, integer),
  public.festival_blackjack_admin(text, jsonb) from public, anon, authenticated;
grant execute on function public.festival_blackjack_state(), public.festival_blackjack_action(uuid, text, integer, integer),
  public.festival_blackjack_admin(text, jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;

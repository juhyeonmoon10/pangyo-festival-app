-- 1.42 blackjack: cards per turn instead of cards per hit, and leaving a game in progress forfeits it.
-- ORBIT's orbit_* functions and private.* helpers are not changed.
--   festival_ops.blackjack_settings.max_per_hit -> max_per_turn: how many cards a player may draw in one turn
--                                      (1-5, default 1). One hit draws one card; the turn stays with the player
--                                      until they have drawn that many, pass ('pass') or stand.
--   festival_ops.blackjack_turn       - cards drawn in the current turn (valid while the game version matches).
--   festival_ops.blackjack_forfeit    - who left a game in progress; the opponent wins the whole pot.
--   festival_blackjack_action         - 'pass' ends the turn after at least one hit; p_count stays for 1.41
--                                      screens and must be 1.
--   festival_blackjack_forfeit        - the player who leaves loses (back button or leaving the screen).
--   blackjack_named                   - also returns turnDrawn and forfeit ('me' | 'opponent' | null).
--   festival_blackjack_lobby/admin    - maxPerTurn instead of maxPerHit; admin recent games mark forfeits.
-- Requested 2026-11-01.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table festival_ops.blackjack_settings rename column max_per_hit to max_per_turn;

create table festival_ops.blackjack_turn (
  game_id uuid primary key references private.blackjack_games(id) on delete cascade,
  side text not null check (side in ('a','b')),
  drawn smallint not null check (drawn >= 1),
  at_version integer not null
);
create table festival_ops.blackjack_forfeit (
  game_id uuid primary key references private.blackjack_games(id) on delete cascade,
  user_id integer not null references public.users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
alter table festival_ops.blackjack_turn enable row level security;
alter table festival_ops.blackjack_forfeit enable row level security;
revoke all on table festival_ops.blackjack_turn, festival_ops.blackjack_forfeit from public, anon, authenticated;

-- A game view with the opponent's whole name, the cards drawn in this turn and who forfeited.
create or replace function festival_ops.blackjack_named(p_view jsonb, p_me integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
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
end $$;
revoke all on function festival_ops.blackjack_named(jsonb, integer) from public, anon, authenticated;

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

create or replace function public.festival_blackjack_action(p_game_id uuid, p_action text, p_version integer, p_count integer default 1) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_me public.users := private.blackjack_me(); v_game private.blackjack_games; v_side text; v_hand smallint[];
  v_set festival_ops.blackjack_settings; v_turn integer;
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
  if p_action = 'pass' and v_turn = 0 then raise exception using message = 'INVALID_ACTION'; end if;
  if p_action = 'hit' then
    select * into v_set from festival_ops.blackjack_settings where singleton;
    if v_turn >= coalesce(v_set.max_per_turn, 1)
      or (v_set.max_draws is not null and pg_catalog.cardinality(v_hand) - 2 >= v_set.max_draws) then
      raise exception using message = 'CARD_LIMIT';
    end if;
  end if;
  delete from festival_ops.blackjack_turn where game_id = v_game.id;

  -- With the 52-card deck used up a hit has no card to give, so it stands.
  if p_action = 'stand' or (p_action = 'hit' and v_game.next_card >= pg_catalog.cardinality(v_game.deck)) then
    if v_side = 'a' then update private.blackjack_games set done_a = true where id = v_game.id returning * into v_game;
    else update private.blackjack_games set done_b = true where id = v_game.id returning * into v_game;
    end if;
  elsif p_action = 'hit' then
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
end $$;

-- Leaving a game in progress: the opponent takes the whole pot, as if the leaver had lost.
create function public.festival_blackjack_forfeit(p_game_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
end $$;

create or replace function public.festival_blackjack_admin(p_action text, p_payload jsonb) returns jsonb
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
end $$;

revoke all on function public.festival_blackjack_forfeit(uuid) from public, anon, authenticated;
grant execute on function public.festival_blackjack_forfeit(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;

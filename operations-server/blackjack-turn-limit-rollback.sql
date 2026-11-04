-- Rollback for blackjack-turn-limit.sql (1.42): back to the 1.41 functions (cards per hit), no forfeit.
-- Games already forfeited keep their result and payout; only the forfeit marks are dropped.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

drop function public.festival_blackjack_forfeit(uuid);
alter table festival_ops.blackjack_settings rename column max_per_turn to max_per_hit;

create or replace function festival_ops.blackjack_named(p_view jsonb, p_me integer) returns jsonb
language sql stable security definer set search_path='' as $$
  select case when p_view is null or p_view->>'id' is null then p_view
    else coalesce((select jsonb_set(p_view, '{opponentName}', to_jsonb(btrim(u.name)))
      from private.blackjack_games g
      join public.users u on u.id = case when g.player_a = p_me then g.player_b else g.player_a end
      where g.id = (p_view->>'id')::uuid and nullif(btrim(u.name), '') is not null), p_view) end
$$;

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

create or replace function public.festival_blackjack_action(p_game_id uuid, p_action text, p_version integer, p_count integer default 1) returns jsonb
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

drop table festival_ops.blackjack_turn;
drop table festival_ops.blackjack_forfeit;
notify pgrst, 'reload schema';
commit;

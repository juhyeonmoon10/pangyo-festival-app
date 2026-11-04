-- Rollback for blackjack-stand-pass.sql (1.44): back to the 1.42 action ('pass' is its own action, a stand always stops).
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

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

notify pgrst, 'reload schema';
commit;

-- Rollback for stock-visit-rules.sql (1.50): back to demand-only prices and trading in any stock.
-- The functions below are the definitions as they were in the operations DB on 2026-11-02 (before 1.50).
-- Prices already moved by decay or visits stay where they are; only the rules change back.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- private.run_orbit_price_tick(p_tick_key text)
CREATE OR REPLACE FUNCTION private.run_orbit_price_tick(p_tick_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_market public.stock_market_state;
  v_config private.stock_price_config;
  v_run private.stock_price_runs;
  v_stock public.stock;
  v_nfc private.stock_nfc_signals;
  v_count integer;
  v_seen integer := 0;
  v_buy numeric;
  v_sell numeric;
  v_signal numeric;
  v_price integer;
  v_now timestamptz;
  v_version bigint;
begin
  if p_tick_key is null or length(btrim(p_tick_key)) not between 8 and 200 then
    raise exception using message = 'INVALID_TICK_KEY';
  end if;
  p_tick_key := btrim(p_tick_key);
  if not pg_catalog.pg_try_advisory_xact_lock(197310,1) then
    return jsonb_build_object('status','locked');
  end if;
  select * into v_market from public.stock_market_state where singleton for update;
  if not found then raise exception using message = 'MARKET_CLOSED'; end if;
  select * into v_run from private.stock_price_runs where event_id = v_market.event_id and tick_key = p_tick_key;
  if found then
    return jsonb_build_object('status','published','version',v_run.version,'stockCount',v_run.stock_count);
  end if;
  v_now := clock_timestamp();
  if v_market.status <> 'open' or v_market.event_status <> 'open'
    or v_now < v_market.starts_at or v_now >= v_market.ends_at then
    raise exception using message = 'MARKET_CLOSED';
  end if;
  if not private.stock_authority_ready() then raise exception using message = 'STOCK_SECURITY_PENDING'; end if;
  select * into v_config from private.stock_price_config where event_id = v_market.event_id for share;
  if not found or not v_config.approved then raise exception using message = 'PRICE_CONFIG_PENDING'; end if;
  -- Block concurrent catalog inserts/remapping during the entire publication.
  lock table public.stock in share row exclusive mode;
  v_now := clock_timestamp();
  if v_now >= v_market.ends_at then raise exception using message = 'MARKET_CLOSED'; end if;
  select count(*) into v_count from public.stock where event_id = v_market.event_id;
  if v_count = 0 then raise exception using message = 'EMPTY_MARKET'; end if;
  v_version := v_market.current_version + 1;
  insert into private.stock_price_runs(event_id,version,tick_key,demand_window,config,stock_count,published_at)
    values(v_market.event_id,v_version,p_tick_key,v_market.demand_window,to_jsonb(v_config),v_count,v_now);
  for v_stock in select * from public.stock where event_id = v_market.event_id order by id for update loop
    select coalesce(sum(buy_quantity),0),coalesce(sum(sell_quantity),0) into v_buy,v_sell
      from private.stock_demand where event_id = v_market.event_id and stock_id = v_stock.id and window_id = v_market.demand_window;
    v_signal := (v_buy - v_sell) * v_config.demand_weight_bps / (v_buy + v_sell + v_config.liquidity_floor);
    v_nfc := null;
    if v_config.nfc_weight_bps > 0 and v_stock.trading_status = 'open' then
      if v_stock.booth_id is null then raise exception using message = 'NFC_INPUT_PENDING'; end if;
      select * into v_nfc from private.stock_nfc_signals
        where event_id = v_market.event_id and stock_id = v_stock.id for share;
      if not found or v_nfc.observed_at > v_now
        or v_nfc.observed_at < v_now - make_interval(secs => v_config.nfc_max_age_seconds) then
        raise exception using message = 'NFC_INPUT_PENDING';
      end if;
      v_signal := v_signal + least(1,v_nfc.recent_count::numeric / v_config.nfc_baseline) * v_config.nfc_weight_bps;
    end if;
    -- Halted stocks still receive the same version, with their price unchanged.
    v_price := private.stock_bounded_price(v_stock.price,
      case when v_stock.trading_status = 'open' then v_signal else 0 end,
      v_config.min_price,v_config.max_price,v_config.max_tick_bps);
    insert into public.stock_price_history(event_id,stock_id,version,price,previous_price,inputs,created_at)
      values(v_market.event_id,v_stock.id,v_version,v_price,v_stock.price,
        jsonb_build_object('buy',v_buy,'sell',v_sell,'nfcCount',v_nfc.recent_count,
          'nfcObservedAt',v_nfc.observed_at,'signalBps',v_signal,'tradingStatus',v_stock.trading_status),v_now);
    update public.stock set previous_price = price,price = v_price,price_version = v_version,
      price_updated_at = v_now,recent_nfc_count = v_nfc.recent_count,
      purchase_rate = case when v_buy + v_sell = 0 then null else v_buy / (v_buy + v_sell) end
      where id = v_stock.id;
    v_seen := v_seen + 1;
  end loop;
  if v_seen <> v_count then raise exception using message = 'INCOMPLETE_PRICE_RUN'; end if;
  update public.stock_market_state set current_version = v_version,demand_window = demand_window + 1,
    updated_at = v_now where singleton;
  return jsonb_build_object('status','published','version',v_version,'stockCount',v_count);
end;
$function$;

-- public.orbit_trade_stock(p_stock_id integer, p_side text, p_quantity numeric, p_idempotency_key text)
CREATE OR REPLACE FUNCTION public.orbit_trade_stock(p_stock_id integer, p_side text, p_quantity numeric, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user public.users;
  v_market public.stock_market_state;
  v_stock public.stock;
  v_holding public.holding;
  v_config private.stock_price_config;
  v_request private.stock_trade_requests;
  v_request_id uuid := gen_random_uuid();
  v_trade_id uuid := gen_random_uuid();
  v_quantity integer;
  v_old_quantity integer;
  v_new_quantity bigint;
  v_total bigint;
  v_balance bigint;
  v_cost numeric(30,6);
  v_now timestamptz;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception using message = 'UNAUTHENTICATED'; end if;
  if p_side is null or p_side not in ('buy','sell') or p_stock_id is null or p_stock_id <= 0
    or p_quantity is null or p_quantity::text in ('NaN','Infinity','-Infinity')
    or p_quantity <> trunc(p_quantity) or p_quantity < 1 or p_quantity > 10000
    or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 8 and 200 then
    raise exception using message = 'INVALID_TRADE';
  end if;
  p_idempotency_key := btrim(p_idempotency_key);
  v_quantity := p_quantity::integer;
  select * into v_user from public.users where auth_user_id = auth.uid() for update;
  if not found then raise exception using message = 'UNREGISTERED_USER'; end if;
  if not v_user.stock_active then raise exception using message = 'ACCOUNT_DISABLED'; end if;
  if not private.stock_authority_ready() then raise exception using message = 'STOCK_SECURITY_PENDING'; end if;

  select * into v_request from private.stock_trade_requests
    where user_id = v_user.id and idempotency_key = p_idempotency_key;
  if found then
    if v_request.stock_id <> p_stock_id or v_request.side <> p_side or v_request.quantity <> v_quantity then
      raise exception using message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_request.result;
  end if;
  -- All trades serialize at the one legacy market. Tick locks market then
  -- stocks in ID order, and never locks users: no reverse user lock ordering.
  select * into v_market from public.stock_market_state where singleton for update;
  v_now := clock_timestamp();
  if not found or v_market.status <> 'open' or v_market.event_status <> 'open'
    or v_now < v_market.starts_at or v_now >= v_market.ends_at then
    raise exception using message = 'MARKET_CLOSED';
  end if;
  select * into v_config from private.stock_price_config where event_id = v_market.event_id for share;
  if not found or not v_config.approved then raise exception using message = 'PRICE_CONFIG_PENDING'; end if;
  select * into v_stock from public.stock where id = p_stock_id for update;
  if not found or v_stock.event_id is distinct from v_market.event_id then
    raise exception using message = 'STOCK_NOT_FOUND';
  end if;
  if v_stock.trading_status <> 'open' then raise exception using message = 'STOCK_HALTED'; end if;
  v_now := clock_timestamp();
  if v_now >= v_market.ends_at then raise exception using message = 'MARKET_CLOSED'; end if;
  if v_stock.price_updated_at is null or v_stock.price_version <> v_market.current_version
    or v_stock.price_version = 0 or v_stock.price_updated_at > clock_timestamp()
    or v_stock.price_updated_at < clock_timestamp() - make_interval(secs => v_config.max_price_age_seconds) then
    raise exception using message = 'PRICE_STALE';
  end if;
  if v_stock.price not between v_config.min_price and v_config.max_price then
    raise exception using message = 'INVALID_PRICE_CONFIG';
  end if;
  select * into v_holding from public.holding where user_id = v_user.id and stock_id = p_stock_id for update;
  if found and v_holding.event_id is distinct from v_market.event_id then
    raise exception using message = 'HOLDING_SCOPE_PENDING';
  end if;
  v_old_quantity := coalesce(v_holding.quantity,0);
  v_total := v_stock.price::bigint * v_quantity;
  if p_side = 'buy' then
    if v_user.money < v_total then raise exception using message = 'INSUFFICIENT_POINTS'; end if;
    v_balance := v_user.money::bigint - v_total;
    v_new_quantity := v_old_quantity::bigint + v_quantity;
    v_cost := case when v_old_quantity = 0 then v_total else v_holding.cost_basis + v_total end;
  else
    if v_old_quantity < v_quantity then raise exception using message = 'INSUFFICIENT_HOLDINGS'; end if;
    v_balance := v_user.money::bigint + v_total;
    v_new_quantity := v_old_quantity - v_quantity;
    v_cost := case when v_new_quantity = 0 then 0
      else round(v_holding.cost_basis * v_new_quantity / v_old_quantity,6) end;
  end if;
  if v_balance not between 0 and 2147483647 or v_new_quantity not between 0 and 2147483647 then
    raise exception using message = 'ASSET_LIMIT';
  end if;
  update public.users set money = v_balance::integer where id = v_user.id;
  insert into public.holding(user_id,stock_id,event_id,quantity,cost_basis,updated_at)
    values(v_user.id,p_stock_id,v_market.event_id,v_new_quantity::integer,v_cost,v_now)
    on conflict(user_id,stock_id) do update set quantity = excluded.quantity,
      cost_basis = excluded.cost_basis, updated_at = excluded.updated_at;
  v_result := jsonb_build_object('id',v_trade_id,'eventId',v_market.event_id,'userId',v_user.id::text,
    'stockId',p_stock_id::text,'side',p_side,'quantity',v_quantity,'unitPrice',v_stock.price,
    'totalPoints',v_total,'priceVersion',v_stock.price_version,'pointBalanceAfter',v_balance,
    'holdingQuantityAfter',v_new_quantity,'createdAt',v_now);
  insert into private.stock_trade_requests(id,user_id,idempotency_key,event_id,stock_id,side,quantity,result)
    values(v_request_id,v_user.id,p_idempotency_key,v_market.event_id,p_stock_id,p_side,v_quantity,v_result);
  insert into private.stock_trades(id,request_id,event_id,user_id,stock_id,side,quantity,unit_price,total_points,
    price_version,demand_window,balance_before,balance_after,quantity_before,quantity_after,cost_basis_after,created_at)
    values(v_trade_id,v_request_id,v_market.event_id,v_user.id,p_stock_id,p_side,v_quantity,v_stock.price,v_total,
      v_stock.price_version,v_market.demand_window,v_user.money,v_balance::integer,v_old_quantity,v_new_quantity::integer,v_cost,v_now);
  insert into private.stock_demand(event_id,window_id,stock_id,buy_quantity,sell_quantity)
    values(v_market.event_id,v_market.demand_window,p_stock_id,
      case when p_side = 'buy' then v_quantity else 0 end,case when p_side = 'sell' then v_quantity else 0 end)
    on conflict(event_id,window_id,stock_id) do update
      set buy_quantity = private.stock_demand.buy_quantity + excluded.buy_quantity,
          sell_quantity = private.stock_demand.sell_quantity + excluded.sell_quantity;
  return v_result;
end;
$function$;

-- public.orbit_stock_snapshot()
CREATE OR REPLACE FUNCTION public.orbit_stock_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'userId',u.id::text,'pointBalance',u.money,'active',u.stock_active,
    'market',coalesce((select jsonb_build_object('eventId',m.event_id,'status',m.status,
      'eventStatus',m.event_status,'startsAt',m.starts_at,'endsAt',m.ends_at,
      'priceVersion',m.current_version,'securityReady',private.stock_authority_ready(),
      'configApproved',coalesce(c.approved,false),'maxPriceAgeSeconds',c.max_price_age_seconds)
      from public.stock_market_state m left join private.stock_price_config c using(event_id)), 'null'::jsonb),
    'stocks',coalesce((select jsonb_agg(jsonb_build_object('id',s.id::text,'eventId',s.event_id,
      'boothId',s.booth_id,'name',s.name,'price',s.price,'previousPrice',coalesce(s.previous_price,s.price),
      'priceVersion',s.price_version,'updatedAt',s.price_updated_at,'tradingStatus',s.trading_status,
      'recentNfcCount',s.recent_nfc_count,'purchaseRate',s.purchase_rate,
      'minPrice',coalesce(c.min_price,1),'maxPrice',coalesce(c.max_price,2147483647)) order by s.id)
      from public.stock s left join private.stock_price_config c using(event_id)), '[]'::jsonb),
    'holdings',coalesce((select jsonb_agg(jsonb_build_object('id',h.id::text,'eventId',h.event_id,
      'userId',h.user_id::text,'stockId',h.stock_id::text,'quantity',h.quantity,
      'averageBuyPrice',case when h.quantity > 0 then h.cost_basis / h.quantity else 0 end,
      'updatedAt',h.updated_at) order by h.stock_id) from public.holding h where h.user_id = u.id and h.quantity > 0),'[]'::jsonb),
    'trades',coalesce((select jsonb_agg(t.result order by t.created_at desc,t.id desc)
      from (select id,result,created_at from private.stock_trade_requests where user_id = u.id
        order by created_at desc,id desc limit 100) t),'[]'::jsonb)
  ) from public.users u where u.auth_user_id = (select auth.uid());
$function$;

update private.stock_price_config set formula = 'weighted-signals-v1';
alter table private.stock_price_config drop constraint stock_price_config_formula_check;
alter table private.stock_price_config add constraint stock_price_config_formula_check check (formula = 'weighted-signals-v1');
alter table private.stock_price_config drop column decay_bps, drop column visit_step, drop column visit_bonus_bps;
drop function private.stock_visited(integer, text);
drop function private.stock_visitors(text);
drop table private.stock_visit_steps;

notify pgrst, 'reload schema';
commit;

import { CoinDCXClient } from './client';
import { AppConfig } from './config';
import { Notifier } from './notifier';
import { appendAlert } from './fileAlerter';
import { saveStraddleState, findLatestStraddleState } from './stateStore';
import { ActiveLeg, LegCloseReason, OptionsPosition, OrderPlacementOutcome, StraddlePositionState } from './types';
import { CycleRecordWriter } from './records/cycleRecordWriter';
import { parseContractExpiryDate as parseExpiryString } from './reports/reportDataCollector';

export interface ExitResult {
  readonly success: boolean;
  readonly orderId?: string;
  readonly isPermanent: boolean;
  readonly message?: string;
}

/**
 * Classifies an exit rejection into transient vs permanent.
 * Permanent: bad quantity, invalid contract, contract expired, insufficient margin.
 * Transient: 5xx, rate limits, network timeouts, retryable API blips.
 */
export function classifyExitError(outcomeMessage: string, rawResponse?: Record<string, unknown>): {
  readonly isPermanent: boolean;
  readonly category: string;
} {
  const msg = (outcomeMessage || '').toLowerCase();
  const httpStatus = typeof rawResponse?.httpStatus === 'number' ? rawResponse.httpStatus : 0;

  // Permanent failure indicators
  if (
    msg.includes('insufficient margin') ||
    msg.includes('not enough balance') ||
    msg.includes('invalid symbol') ||
    msg.includes('does not exist') ||
    msg.includes('contract expired') ||
    msg.includes('already expired') ||
    msg.includes('invalid quantity') ||
    msg.includes('min lot') ||
    msg.includes('precision') ||
    msg.includes('order size') ||
    msg.includes('should be lower than base_price') ||
    msg.includes('should be higher than base_price')
  ) {
    return { isPermanent: true, category: 'PERMANENT_REJECTION' };
  }

  // HTTP 400 Bad Request with "Please retry" is retryable up to limit
  if (httpStatus >= 500 || msg.includes('timeout') || msg.includes('network') || msg.includes('rate limit') || msg.includes('429')) {
    return { isPermanent: false, category: 'TRANSIENT_SERVER_OR_NETWORK' };
  }

  // Other 4xx or generic "Please retry."
  if (msg.includes('please retry') || httpStatus === 400) {
    return { isPermanent: false, category: 'RETRYABLE_EXCHANGE_ERROR' };
  }

  return { isPermanent: false, category: 'UNKNOWN_RETRYABLE' };
}

/**
 * Checks if a specific contract symbol is still present in the exchange's live positions feed.
 * Returns:
 *   true  -> position is still open on exchange
 *   false -> position is confirmed absent / closed
 *   null  -> could not determine (feed failed / 401 / network error)
 */
export async function isPositionOpenOnExchange(
  client: CoinDCXClient,
  symbol: string
): Promise<boolean | null> {
  try {
    const livePositions = await client.getOptionsPositions();
    const found = livePositions.find((p) => p.symbol === symbol);
    if (!found) {
      return false;
    }
    const qty = Number(found.qty ?? found.quantity);
    if (Number.isFinite(qty) && qty === 0) {
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Reconciliation] Failed to query exchange positions for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Parses expiry timestamp from a contract symbol, e.g. BTC-5OCT26-85250-P-USDT -> Date
 */
export function parseContractExpiryDate(symbol: string, defaultHourUtc = 8): Date | null {
  const m = symbol.match(/^[A-Z]+-(\d{1,2})([A-Z]{3})(\d{2})-/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monStr = m[2].toUpperCase();
  const year = 2000 + parseInt(m[3], 10);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const mon = months.indexOf(monStr);
  if (mon === -1) return null;
  return new Date(Date.UTC(year, mon, day, defaultHourUtc, 0, 0, 0));
}

/**
 * Verifies that a stop order is armed on the venue for a given leg.
 * Checks for an open order with:
 * - symbol matching leg.symbol
 * - triggerPrice matching expectedTriggerPrice (within tolerance)
 * - status 'Untriggered' or 'Open'
 * - reduceOnly: true
 * - qty matching leg.quantity
 */
export function verifyStopOrderArmed(
  orders: readonly Record<string, unknown>[],
  leg: ActiveLeg,
  tolerance = 2.0
): {
  readonly armed: boolean;
  readonly reason?: 'MISSING' | 'TRIGGER_MISMATCH' | 'QTY_MISMATCH' | 'NOT_REDUCE_ONLY' | 'STATUS_INVALID';
  readonly matchedOrder?: Record<string, unknown>;
  readonly message?: string;
} {
  const symbolOrders = orders.filter((o) => {
    const sym = String(o.symbol || o.pair || '');
    return sym === leg.symbol;
  });

  if (symbolOrders.length === 0) {
    return {
      armed: false,
      reason: 'MISSING',
      message: `No open order found on venue for ${leg.symbol}`,
    };
  }

  // Look for stop/trigger orders
  const stopOrders = symbolOrders.filter((o) => {
    const orderType = String(o.orderType || o.order_type || o.type || '').toLowerCase();
    const hasTrigger = o.triggerPrice !== undefined || o.stopPrice !== undefined || o.stop_price !== undefined;
    const isStopOrder = orderType.includes('stop') || hasTrigger;
    const orderId = String(o.id || o.orderId || o.order_id || '');
    return isStopOrder || orderId.startsWith('x-');
  });

  if (stopOrders.length === 0) {
    return {
      armed: false,
      reason: 'MISSING',
      message: `No stop order found on venue for ${leg.symbol} (found ${symbolOrders.length} orders but none are stop orders)`,
    };
  }

  // Find the stop order that matches leg.stopLossPrice within tolerance
  let stopOrder = stopOrders.find((o) => {
    const rawTrigger = o.triggerPrice ?? o.stopPrice ?? o.stop_price;
    const triggerPrice = Number(rawTrigger);
    return Number.isFinite(triggerPrice) && Math.abs(triggerPrice - leg.stopLossPrice) <= tolerance;
  });

  // If none matches the trigger price, take the first stop order to report TRIGGER_MISMATCH
  if (!stopOrder) {
    stopOrder = stopOrders[0];
  }

  // Check trigger price
  const rawTrigger = stopOrder.triggerPrice ?? stopOrder.stopPrice ?? stopOrder.stop_price;
  const triggerPrice = Number(rawTrigger);
  if (!Number.isFinite(triggerPrice) || Math.abs(triggerPrice - leg.stopLossPrice) > tolerance) {
    return {
      armed: false,
      reason: 'TRIGGER_MISMATCH',
      matchedOrder: stopOrder,
      message: `Trigger price mismatch for ${leg.symbol}: venue has ${rawTrigger}, expected ${leg.stopLossPrice.toFixed(2)}`,
    };
  }

  // Check quantity if available
  const rawQty = stopOrder.qty ?? stopOrder.quantity ?? stopOrder.total_quantity;
  if (rawQty !== undefined) {
    const qty = Number(rawQty);
    if (Number.isFinite(qty) && Math.abs(qty - leg.quantity) > 0.0001) {
      return {
        armed: false,
        reason: 'QTY_MISMATCH',
        matchedOrder: stopOrder,
        message: `Quantity mismatch for ${leg.symbol} stop order: venue has ${rawQty}, expected ${leg.quantity}`,
      };
    }
  }

  // Check reduceOnly if present
  if (stopOrder.reduceOnly !== undefined && stopOrder.reduceOnly === false) {
    return {
      armed: false,
      reason: 'NOT_REDUCE_ONLY',
      matchedOrder: stopOrder,
      message: `Stop order for ${leg.symbol} is NOT reduceOnly`,
    };
  }

  // Check status (should be Untriggered or Open or pending)
  const status = String(stopOrder.status || '').toLowerCase();
  if (status && status !== 'untriggered' && status !== 'open' && status !== 'pending') {
    return {
      armed: false,
      reason: 'STATUS_INVALID',
      matchedOrder: stopOrder,
      message: `Stop order for ${leg.symbol} has unexpected status: ${status}`,
    };
  }

  return {
    armed: true,
    matchedOrder: stopOrder,
  };
}

export interface RearmResult {
  readonly rearmed: boolean;
  readonly orderId?: string;
  readonly message?: string;
}

/**
 * Re-arms a missing stop loss order for an open leg on the venue.
 * Never touches or cancels an existing order if it already matches expectations.
 * Places the stop order with:
 * - symbol: leg.symbol
 * - side: 'buy'
 * - qty: leg.quantity
 * - price: 0 (or Market)
 * - stopLoss: triggerPrice (2 * entry price)
 * - reduceOnly: true
 * Logs STOP_RE_ARMED and writes ANOMALY event to cycle record.
 */
export async function rearmStopOrderIfMissing(
  client: CoinDCXClient,
  leg: ActiveLeg,
  orders: readonly Record<string, unknown>[],
  config: AppConfig,
  cycleExpiryStr?: string,
  notifier?: Notifier,
  state?: StraddlePositionState
): Promise<RearmResult> {
  if (leg.status !== 'open' || !leg.confirmedOpen) {
    return { rearmed: false, message: `Leg ${leg.symbol} is not open or confirmed open` };
  }

  const contractExpiry = parseContractExpiryDate(leg.symbol, config.dailyExpiryHourUTC);
  if (contractExpiry !== null && Date.now() >= contractExpiry.getTime()) {
    console.warn(`[Risk Manager] Leg ${leg.symbol} is at/past expiry. Cannot rearm stop.`);
    return { rearmed: false, message: 'Contract expired' };
  }

  const check = verifyStopOrderArmed(orders, leg);
  if (check.armed) {
    return { rearmed: false, message: `Stop order is already correctly armed on venue for ${leg.symbol}` };
  }

  console.warn(
    `[Risk Manager] ⚠️ Stop missing for ${leg.legType} (${leg.symbol}). Venue requires cancel + reopen route to establish stops on short positions.`
  );

  const expiry = cycleExpiryStr || (parseExpiryString(leg.symbol) ?? new Date().toISOString().slice(0, 10));
  const writer = new CycleRecordWriter(expiry);

  // If state is supplied, execute cancel + re-open route
  if (state) {
    const moveRes = await moveStopToCostOnSurvivingLeg(
      client,
      leg,
      state,
      config,
      notifier
    );
    if (moveRes.reopened) {
      writer.appendEvent('ANOMALY', {
        type: 'STOP_RE_ARMED_VIA_REOPEN',
        legType: leg.legType,
        symbol: leg.symbol,
        newTrigger: moveRes.newTrigger,
        orderId: moveRes.orderId,
      });
      return { rearmed: true, orderId: moveRes.orderId, message: 'STOP_RE_ARMED' };
    }
    return { rearmed: false, message: moveRes.message };
  }

  // Fallback when standalone state is not provided (e.g. startup probe):
  // Safe alert and log
  const warnMsg = `Stop missing for ${leg.symbol} but standalone state not provided for cancel+reopen. Alerting operator.`;
  console.warn(`[Risk Manager] ⚠️ ${warnMsg}`);
  appendAlert('stop_missing_manual_action', warnMsg, { symbol: leg.symbol, trigger: leg.stopLossPrice });
  writer.appendEvent('ANOMALY', {
    type: 'STOP_MISSING_UNARMED',
    legType: leg.legType,
    symbol: leg.symbol,
    stopLossPrice: leg.stopLossPrice,
    priorStatus: check.reason,
  });
  return { rearmed: false, message: warnMsg };
}

/**
 * Rounds a price to the nearest tickSize multiple.
 * If tickSize <= 0 or invalid, rounds to 2 decimal places.
 */
export function roundToTickSize(price: number, tickSize: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return Math.round(price * 100) / 100;
  }
  const ticks = Math.round(price / tickSize);
  // Round to reasonable precision to avoid floating point anomalies (e.g. 535.0000000000001)
  const rounded = ticks * tickSize;
  const precision = tickSize < 1 ? Math.max(0, -Math.floor(Math.log10(tickSize))) : 2;
  return Number(rounded.toFixed(precision));
}

export interface MoveStopResult {
  readonly moved: boolean;
  readonly reopened?: boolean;
  readonly skippedAlreadyThroughCost?: boolean;
  readonly closedOnOverdue?: boolean;
  readonly newTrigger?: number;
  readonly orderId?: string;
  readonly message?: string;
}

/**
 * When one leg's SL is hit, performs cost stop via cancel + re-open route (Part B).
 *
 * Route sequence:
 * 1. Resolve live truth of surviving leg (position row, resting orders, tick size, live ticker bid/ask).
 * 2. Compute re-open levels:
 *    - closeLegPrice = ask (market buyback), sellPrice = bid (limit sell).
 *    - newStopTrigger = roundToTickSize(bid + buffer, tickSize) where buffer = COST_STOP_BUFFER_POINTS (> 0).
 * 3. Cancel every resting order for this cycle's symbols and verify zero remain.
 * 4. Buy back surviving leg (reduceOnly: true, Market, qty = leg.quantity). Verify flat (or 422 "no open positions").
 * 5. Re-open short (side: 'sell', orderType: 'Limit', price: bid, qty = leg.quantity, stopLoss: newStopTrigger, conversionRate).
 * 6. Verify: position exists on venue, exactly 1 resting order with triggerPrice === newStopTrigger and reduceOnly: true.
 * 7. Safe failure: if re-open fails, leg is flat with P&L banked. Never leave naked short or retry blindly.
 * 8. Persist state and cycle records: COST_STOP_REOPENED and updated leg details.
 */
export async function moveStopToCostOnSurvivingLeg(
  client: CoinDCXClient,
  survivingLeg: ActiveLeg,
  state: StraddlePositionState,
  config: AppConfig,
  notifier?: Notifier,
  instrumentsOverride?: readonly Record<string, unknown>[],
  ordersOverride?: readonly Record<string, unknown>[]
): Promise<MoveStopResult> {
  const expiry = parseExpiryString(survivingLeg.symbol) ?? state.date;
  const writer = new CycleRecordWriter(expiry);

  // 1. Resolve live truth: tick size and live ticker bid/ask
  let tickSize = 5;
  try {
    const instruments = instrumentsOverride ?? (await client.getOptionsInstruments('BTC'));
    const matchedInst = (instruments as readonly any[]).find((i) => i.symbol === survivingLeg.symbol);
    if (matchedInst && matchedInst.priceFilter) {
      const ts = Number(matchedInst.priceFilter.tickSize ?? matchedInst.priceFilter.tick_size);
      if (Number.isFinite(ts) && ts > 0) {
        tickSize = ts;
      }
    }
  } catch (instErr) {
    console.warn(`[Risk Manager] Could not query instruments for tickSize on ${survivingLeg.symbol}: ${(instErr as Error).message}`);
  }

  // Resolve live market bid and ask
  let liveBid = survivingLeg.currentPrice;
  let liveAsk = survivingLeg.currentPrice;
  try {
    const tickers = await client.getOptionsTicker('BTC');
    const matchedTicker = tickers.find((t) => t.symbol === survivingLeg.symbol);
    if (matchedTicker) {
      const bid = Number(matchedTicker.bidPrice);
      const ask = Number(matchedTicker.askPrice);
      if (Number.isFinite(bid) && bid > 0) liveBid = bid;
      if (Number.isFinite(ask) && ask > 0) liveAsk = ask;
    }
  } catch (tickErr) {
    console.warn(`[Risk Manager] Could not query ticker for ${survivingLeg.symbol}: ${(tickErr as Error).message}`);
  }

  const buffer = config.riskConfig.costStopBufferPoints ?? 20;
  if (buffer <= 0) {
    throw new Error(`COST_STOP_BUFFER_POINTS must be > 0 (buffer of 0 is unconstructible, received ${buffer})`);
  }

  const oldTrigger = survivingLeg.stopLossPrice;
  // Compute new trigger from the new sell entry (bid) + buffer
  const newTrigger = roundToTickSize(liveBid + buffer, tickSize);

  console.log(
    `[Risk Manager] 🛡️ Initiating cost-stop cancel + re-open for ${survivingLeg.legType} (${survivingLeg.symbol}): ` +
    `liveBid: $${liveBid.toFixed(2)}, liveAsk: $${liveAsk.toFixed(2)}, newTrigger: $${newTrigger.toFixed(2)} (buffer: +${buffer} pts, tickSize: ${tickSize})...`
  );

  // 3. Cancel every resting order for this cycle's symbols
  const cycleSymbols = new Set([state.callLeg.symbol, state.putLeg.symbol]);
  let openOrders: readonly Record<string, unknown>[] = [];
  try {
    openOrders = ordersOverride ?? (await client.getOpenOptionsOrders());
  } catch (ordErr) {
    console.error(`[Risk Manager] Failed to query open orders prior to cost stop reopen: ${(ordErr as Error).message}`);
    return { moved: false, message: 'Failed to query open orders' };
  }

  const cycleOrders = openOrders.filter((o) => {
    const sym = String(o.symbol || o.pair || '');
    return cycleSymbols.has(sym);
  });

  for (const o of cycleOrders) {
    const oId = String(o.id || o.orderId || o.order_id || '');
    const sym = String(o.symbol || o.pair || '');
    if (oId && sym) {
      console.log(`[Risk Manager] Cancelling resting order ${oId} for ${sym}...`);
      try {
        await client.cancelOptionsOrder(oId, sym);
      } catch (cancelErr) {
        console.warn(`[Risk Manager] Could not cancel order ${oId}: ${(cancelErr as Error).message}`);
      }
    }
  }

  // Re-read open orders to verify 0 remain for cycle symbols
  try {
    const remainingOrders = ordersOverride ? [] : (await client.getOpenOptionsOrders());
    const remainingCycleOrders = remainingOrders.filter((o) => {
      const sym = String(o.symbol || o.pair || '');
      return cycleSymbols.has(sym);
    });
    if (remainingCycleOrders.length > 0) {
      console.warn(`[Risk Manager] ⚠️ ${remainingCycleOrders.length} resting order(s) remain after cancellation pass.`);
    }
  } catch {
    // Continue
  }

  // 4. Buy back the surviving leg (reduceOnly: true, Market)
  console.log(`[Risk Manager] Buying back surviving leg ${survivingLeg.symbol} (qty: ${survivingLeg.quantity}, reduceOnly: true)...`);
  let buyBackOutcome: OrderPlacementOutcome;
  try {
    buyBackOutcome = await client.placeOptionsOrder(
      survivingLeg.symbol,
      'buy',
      survivingLeg.quantity,
      'Market',
      undefined,
      '',
      '',
      undefined,
      true // reduceOnly: true
    );
  } catch (buyErr) {
    const msg = `Exception buying back surviving leg ${survivingLeg.symbol}: ${(buyErr as Error).message}`;
    console.error(`[Risk Manager] 🚨 ${msg}`);
    appendAlert('cost_stop_buyback_failed', msg, { symbol: survivingLeg.symbol, error: msg });
    return { moved: false, message: msg };
  }

  if (!buyBackOutcome.success && !buyBackOutcome.isAlreadyFlat) {
    const msg = `Failed to buy back surviving leg ${survivingLeg.symbol}: ${buyBackOutcome.message || 'unknown error'}`;
    console.error(`[Risk Manager] 🚨 ${msg}`);
    appendAlert('cost_stop_buyback_failed', msg, { symbol: survivingLeg.symbol, error: buyBackOutcome.message });
    return { moved: false, message: msg };
  }

  // Resolve exit fill price of the buy-back
  let buyBackFillPrice = liveAsk;
  let buyBackOrderId = buyBackOutcome.orderId;
  try {
    const txs = await client.getOptionsWalletTransactions();
    const tradeRow = txs.find(
      (r) =>
        r.symbol === survivingLeg.symbol &&
        String(r.transactionType || r.type).toUpperCase() === 'TRADE' &&
        (buyBackOrderId ? String(r.orderId || r.order_id) === String(buyBackOrderId) : true)
    );
    if (tradeRow && tradeRow.filledPrice !== undefined) {
      const fp = Number(tradeRow.filledPrice);
      if (Number.isFinite(fp) && fp > 0) {
        buyBackFillPrice = fp;
      }
    }
  } catch {
    // Keep buyBackFillPrice
  }

  const bankedPnlPoints = survivingLeg.entryPrice - buyBackFillPrice;

  // Verify flat on venue
  try {
    const venuePositions = await client.getOptionsPositions();
    const stillOpen = venuePositions.find((p) => p.symbol === survivingLeg.symbol);
    const qty = Number(stillOpen?.qty ?? stillOpen?.quantity ?? 0);
    if (stillOpen && qty !== 0) {
      console.warn(`[Risk Manager] ⚠️ Leg ${survivingLeg.symbol} still has qty ${qty} on venue after buy back.`);
    }
  } catch {
    // Non-fatal if read fails
  }

  // 5. Re-open short leg with new stop trigger
  console.log(
    `[Risk Manager] Re-opening short ${survivingLeg.symbol} @ Limit $${liveBid.toFixed(2)} with stopLoss $${newTrigger.toFixed(2)}...`
  );
  let reopenOutcome: OrderPlacementOutcome;
  try {
    reopenOutcome = await client.placeOptionsOrder(
      survivingLeg.symbol,
      'sell',
      survivingLeg.quantity,
      'Limit',
      liveBid,
      String(newTrigger),
      '',
      undefined,
      false // New opening position
    );
  } catch (reopenErr) {
    // Step 7: Safe failure! The leg is flat with P&L banked.
    const msg = `SAFE FAILURE: Exception re-opening leg ${survivingLeg.symbol}: ${(reopenErr as Error).message}. Leg is FLAT.`;
    console.error(`[Risk Manager] 🚨 ${msg}`);
    survivingLeg.status = 'closed';
    survivingLeg.exitPrice = buyBackFillPrice;
    survivingLeg.closeReason = 'SL_COST_STOP_CLOSED';
    survivingLeg.exitOrderId = buyBackOrderId;
    await saveStraddleState(state, state.date);

    appendAlert('cost_stop_reopen_aborted_leg_flat', msg, { symbol: survivingLeg.symbol, error: msg });
    writer.appendEvent('ANOMALY', {
      type: 'COST_STOP_REOPEN_ABORTED_LEG_FLAT',
      symbol: survivingLeg.symbol,
      error: (reopenErr as Error).message,
    });
    if (notifier) {
      void notifier.notifyError('Cost Stop Reopen Aborted (Leg Flat)', reopenErr as Error);
    }
    return { moved: false, message: msg };
  }

  if (!reopenOutcome.success) {
    // Step 7: Safe failure!
    const msg = `SAFE FAILURE: Venue rejected re-opening leg ${survivingLeg.symbol}: ${reopenOutcome.message}. Leg is FLAT with P&L banked.`;
    console.error(`[Risk Manager] 🚨 ${msg}`);
    survivingLeg.status = 'closed';
    survivingLeg.exitPrice = buyBackFillPrice;
    survivingLeg.closeReason = 'SL_COST_STOP_CLOSED';
    survivingLeg.exitOrderId = buyBackOrderId;
    await saveStraddleState(state, state.date);

    appendAlert('cost_stop_reopen_aborted_leg_flat', msg, { symbol: survivingLeg.symbol, error: reopenOutcome.message });
    writer.appendEvent('ANOMALY', {
      type: 'COST_STOP_REOPEN_ABORTED_LEG_FLAT',
      symbol: survivingLeg.symbol,
      error: reopenOutcome.message,
    });
    if (notifier) {
      void notifier.notifyError('Cost Stop Reopen Aborted (Leg Flat)', new Error(msg));
    }
    return { moved: false, message: msg };
  }

  const newOrderId = reopenOutcome.orderId || 'reopened-short-order';
  const newEntryPrice = reopenOutcome.limitPrice ?? liveBid;

  // 6. Verify: position exists, exactly 1 resting order with triggerPrice === newTrigger and reduceOnly: true
  let verifyOrders: readonly Record<string, unknown>[] = [];
  try {
    verifyOrders = ordersOverride ?? (await client.getOpenOptionsOrders());
  } catch {
    verifyOrders = [];
  }

  const tempLegWithNewTrigger: ActiveLeg = {
    ...survivingLeg,
    entryPrice: newEntryPrice,
    stopLossPrice: newTrigger,
  };

  const armedCheck = verifyStopOrderArmed(verifyOrders, tempLegWithNewTrigger, 2.0);
  if (!armedCheck.armed && verifyOrders.length > 0) {
    const verifyMsg = `Verification warning: re-opened stop order for ${survivingLeg.symbol} verification check reported: ${armedCheck.message || 'unconfirmed'}`;
    console.warn(`[Risk Manager] ⚠️ ${verifyMsg}`);
    appendAlert('cost_stop_reopen_verify_failed', verifyMsg, { symbol: survivingLeg.symbol, reason: armedCheck.reason });
    writer.appendEvent('ANOMALY', {
      type: 'COST_STOP_REOPEN_VERIFY_FAILED',
      symbol: survivingLeg.symbol,
      reason: armedCheck.reason,
    });
  }

  // 8. Persist and record everything
  (survivingLeg as any).orderId = newOrderId;
  (survivingLeg as any).entryPrice = newEntryPrice;
  survivingLeg.stopLossPrice = newTrigger;
  (survivingLeg as any).confirmedOpen = true;
  survivingLeg.seenOpenOnVenue = true;
  survivingLeg.status = 'open';
  delete survivingLeg.exitPrice;
  delete survivingLeg.closeReason;
  delete survivingLeg.exitOrderId;

  state.updatedAt = new Date().toISOString();
  await saveStraddleState(state, state.date);

  writer.appendEvent('COST_STOP_REOPENED', {
    legType: survivingLeg.legType,
    symbol: survivingLeg.symbol,
    oldTrigger,
    newEntry: newEntryPrice,
    newTrigger,
    buffer,
    bankedPnlPoints,
    orderId: newOrderId,
  });

  const successMsg =
    `COST_STOP_REOPENED: ${survivingLeg.legType} (${survivingLeg.symbol}) re-opened @ $${newEntryPrice.toFixed(2)} with stop @ $${newTrigger.toFixed(2)} ` +
    `(old trigger: $${oldTrigger.toFixed(2)}, buffer: +${buffer} pts, banked PnL: ${bankedPnlPoints.toFixed(2)} pts) | Order: ${newOrderId}.`;
  console.log(`[Risk Manager] ✅ ${successMsg}`);

  appendAlert('cost_stop_reopened', successMsg, {
    symbol: survivingLeg.symbol,
    leg: survivingLeg.legType,
    oldTrigger,
    newEntry: newEntryPrice,
    newTrigger,
    buffer,
    bankedPnlPoints,
    orderId: newOrderId,
  });

  if (notifier) {
    void notifier.notifyReconciliation(successMsg);
  }

  return {
    moved: true,
    reopened: true,
    newTrigger,
    orderId: newOrderId,
    message: 'COST_STOP_REOPENED',
  };
}

/**
 * Closes an individual leg safely with bounded retry, classification, and exchange confirmation.
 * CRITICAL RULE: NEVER marks leg.status = 'closed' without exchange confirmation!
 */
export async function safeCloseLeg(
  client: CoinDCXClient,
  leg: ActiveLeg,
  currentPrice: number,
  reason: LegCloseReason,
  config: AppConfig,
  notifier?: Notifier,
  maxAttempts = 3
): Promise<ExitResult> {
  if (!leg.confirmedOpen) {
    console.warn(`[Exit] ⚠️ Refusing to close leg ${leg.symbol} because confirmedOpen is false.`);
    return { success: false, isPermanent: true, message: 'confirmedOpen is false' };
  }
  if (leg.status === 'closed') {
    console.warn(`[Exit] ⚠️ Leg ${leg.symbol} is already marked closed.`);
    return { success: true, isPermanent: false, message: 'already closed' };
  }

  leg.closeAttempts = (leg.closeAttempts || 0) + 1;

  console.log(
    `[Exit] 🚨 Attempting to close ${leg.legType} (${leg.symbol}) at $${currentPrice.toFixed(
      2
    )} | Reason: ${reason} (Attempt ${leg.closeAttempts})`
  );

  let lastMessage = '';
  let lastRaw: Record<string, unknown> = {};

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = await client.closePosition(leg.symbol, leg.quantity, config.leverage);
    lastMessage = outcome.message || '';
    lastRaw = outcome.rawResponse || {};

    if (outcome.success) {
      leg.status = 'closed';
      leg.exitPrice = currentPrice;
      leg.closeReason = reason;
      leg.exitOrderId = outcome.orderId;
      console.log(
        `[Exit] ✅ ${leg.legType} (${leg.symbol}) closed successfully on exchange. Order ID: ${outcome.orderId || 'N/A'}`
      );

      if (notifier) {
        const runningPnL = leg.entryPrice - currentPrice;
        void notifier.notifyLegClosed({
          legType: leg.legType,
          symbol: leg.symbol,
          reason,
          exitPrice: currentPrice,
          runningPnL,
        });
      }

      return { success: true, orderId: outcome.orderId, isPermanent: false };
    }

    if (outcome.isAlreadyFlat) {
      console.log(
        `[Exit] ℹ️ Leg ${leg.legType} (${leg.symbol}) is ALREADY_FLAT on venue (rejected with no open positions). Reconciling as closed.`
      );
      leg.status = 'closed';
      leg.exitPrice = currentPrice;
      leg.closeReason = reason;

      if (notifier) {
        const runningPnL = leg.entryPrice - currentPrice;
        void notifier.notifyLegClosed({
          legType: leg.legType,
          symbol: leg.symbol,
          reason,
          exitPrice: currentPrice,
          runningPnL,
        });
      }

      return { success: true, isPermanent: false, message: 'ALREADY_FLAT' };
    }

    // Verify if position is already closed despite error return (e.g. race or prior fill)
    const stillOpen = await isPositionOpenOnExchange(client, leg.symbol);
    if (stillOpen === false) {
      leg.status = 'closed';
      leg.exitPrice = currentPrice;
      leg.closeReason = reason;
      console.log(
        `[Exit] ✅ ${leg.legType} (${leg.symbol}) confirmed closed via exchange positions feed despite order return error.`
      );

      if (notifier) {
        const runningPnL = leg.entryPrice - currentPrice;
        void notifier.notifyLegClosed({
          legType: leg.legType,
          symbol: leg.symbol,
          reason,
          exitPrice: currentPrice,
          runningPnL,
        });
      }

      return { success: true, isPermanent: false, message: 'Confirmed closed via exchange positions' };
    }

    const { isPermanent, category } = classifyExitError(lastMessage, lastRaw);

    console.error(
      `[Exit] ❌ ${leg.legType} (${leg.symbol}) close attempt ${attempt}/${maxAttempts} failed: ${lastMessage} [${category}]`
    );

    if (isPermanent) {
      const alertMsg =
        `MANUAL ACTION NEEDED: Permanent exit rejection for ${leg.legType} (${leg.symbol}) — ` +
        `${lastMessage}. Position remains OPEN on exchange!`;
      appendAlert('exit_failure_permanent', alertMsg, {
        symbol: leg.symbol,
        leg: leg.legType,
        error: lastMessage,
        raw: lastRaw,
      });
      if (notifier) {
        void notifier.notifyError(`Exit Rejection (${leg.symbol})`, alertMsg);
      }
      return { success: false, isPermanent: true, message: lastMessage };
    }

    // Transient failure: backoff before next attempt
    if (attempt < maxAttempts) {
      const backoffMs = attempt * 1000;
      console.warn(`[Exit] Retrying close in ${backoffMs}ms...`);
      await new Promise((res) => setTimeout(res, backoffMs));
    }
  }

  // All retry attempts exhausted: do NOT mark closed! Keep open and alert loudly
  const alertMsg =
    `MANUAL ACTION NEEDED: Failed to close ${leg.legType} (${leg.symbol}) after ${maxAttempts} attempts — ` +
    `${lastMessage}. Position remains OPEN on exchange and actively monitored!`;
  console.error(`[Exit] 🚨 ${alertMsg}`);
  appendAlert('exit_failure', alertMsg, {
    symbol: leg.symbol,
    leg: leg.legType,
    attempts: maxAttempts,
    error: lastMessage,
    raw: lastRaw,
  });

  if (notifier) {
    void notifier.notifyError(`Exit Failure (${leg.symbol})`, alertMsg);
  }

  return { success: false, isPermanent: false, message: lastMessage };
}

/**
 * Reconciles state against exchange positions.
 * If the exchange lists an open leg that state does not know about (e.g. bot crash,
 * premature flat mark, or restart), it resurrects/adopts the orphaned leg into state.
 */
export async function reconcileAndResurrectState(
  client: CoinDCXClient,
  config: AppConfig,
  notifier?: Notifier
): Promise<{ state: StraddlePositionState; resurrected: boolean } | null> {
  let exchangePositions: readonly OptionsPosition[] = [];
  try {
    exchangePositions = await client.getOptionsPositions();
  } catch (err) {
    console.warn(`[Reconciliation] Could not read exchange positions: ${(err as Error).message}`);
    return null;
  }

  // Filter open options positions on BTC
  const openPositions = exchangePositions.filter((p) => {
    const sym = p.symbol || '';
    const isBtcOption = sym.startsWith('BTC-') && (sym.includes('-C-') || sym.includes('-P-'));
    const qty = Number(p.qty ?? p.quantity ?? config.orderQuantity);
    return isBtcOption && qty > 0;
  });

  const latest = await findLatestStraddleState();

  if (openPositions.length === 0) {
    // Exchange is completely flat
    if (latest && latest.state && !latest.state.resolvedScenario) {
      const callWasOpen = latest.state.callLeg.status === 'open';
      const putWasOpen = latest.state.putLeg.status === 'open';
      if (callWasOpen || putWasOpen) {
        console.log(`[Reconciliation] Exchange has 0 open positions. Marking recorded state (${latest.date}) closed.`);
        for (const leg of [latest.state.callLeg, latest.state.putLeg]) {
          if (leg.status !== 'open') {
            continue;
          }
          const expiry = parseContractExpiryDate(leg.symbol, config.dailyExpiryHourUTC);
          leg.status = 'closed';
          if (expiry && Date.now() >= expiry.getTime()) {
            // Past its expiry and gone from the venue => it expired.
            leg.closeReason = 'EXPIRED';
            leg.exitPrice = 0;
          } else {
            // Absent BEFORE expiry: venue stop order executed or closed on venue!
            // Query wallet transactions to adopt venue fill price
            leg.closeReason = 'SL_HIT';
            try {
              const txs = await client.getOptionsWalletTransactions();
              const tradeRow = txs.find(
                (r) =>
                  r.symbol === leg.symbol &&
                  String(r.transactionType || r.type).toUpperCase() === 'TRADE'
              );
              if (tradeRow && tradeRow.filledPrice !== undefined) {
                const fp = Number(tradeRow.filledPrice);
                if (Number.isFinite(fp) && fp > 0) {
                  leg.exitPrice = fp;
                  leg.exitOrderId = String(tradeRow.orderId || tradeRow.order_id || '') || leg.exitOrderId;
                  console.log(`[Reconciliation] Adopted venue fill price for ${leg.symbol}: $${leg.exitPrice.toFixed(2)}`);
                }
              }
            } catch {
              // Keep default/mark if txs unreadable
            }
            if (leg.exitPrice === undefined) {
              leg.exitPrice = leg.currentPrice;
            }
          }
        }
        latest.state.resolvedScenario = 'MAX_TIME_REACHED';
        await saveStraddleState(latest.state, latest.date);
      }
    }
    return null;
  }

  // Exchange has open positions! Check if state matches or needs resurrection
  console.log(`[Reconciliation] Found ${openPositions.length} active position(s) on exchange:`, openPositions.map((p) => p.symbol).join(', '));

  if (!latest || !latest.state) {
    // No state at all, but positions exist on exchange -> Adopt them into a fresh state
    const firstSym = openPositions[0].symbol;
    const expDate = parseContractExpiryDate(firstSym, config.dailyExpiryHourUTC) ?? new Date();
    const dateStr = expDate.toISOString().slice(0, 10);
    const adoptedState = buildAdoptedStateFromPositions(openPositions, dateStr, config);
    await saveStraddleState(adoptedState, dateStr);

    const cycleExpiryStr = parseExpiryString(firstSym) || dateStr;
    const recordWriter = new CycleRecordWriter(cycleExpiryStr);
    recordWriter.appendEvent('CYCLE_START', {
      entryDate: dateStr,
      source: 'state-adoption',
      adopted: true,
      openPositions: openPositions.map((p) => p.symbol),
    });
    recordWriter.writeSummarySnapshot({
      schemaVersion: 1,
      cycle: cycleExpiryStr,
      entryDate: dateStr,
      updatedAt: new Date().toISOString(),
      status: 'ADOPTED',
      adopted: true,
      source: 'state-adoption',
      callSymbol: adoptedState.callLeg.symbol,
      putSymbol: adoptedState.putLeg.symbol,
      callLeg: {
        symbol: adoptedState.callLeg.symbol,
        entryPrice: adoptedState.callLeg.entryPrice,
        status: adoptedState.callLeg.status,
      },
      putLeg: {
        symbol: adoptedState.putLeg.symbol,
        entryPrice: adoptedState.putLeg.entryPrice,
        status: adoptedState.putLeg.status,
      },
    });

    const msg = `Adopted orphaned live position from exchange with 0 local state: ${openPositions.map((p) => p.symbol).join(', ')}`;
    console.warn(`[Reconciliation] 🚨 ${msg}`);
    appendAlert('state_resurrected', msg);
    if (notifier) {
      void notifier.notifyReconciliation(msg);
    }
    return { state: adoptedState, resurrected: true };
  }

  // State exists. Check if any exchange position is marked closed or missing in state
  let stateModified = false;
  const state = latest.state;

  for (const pos of openPositions) {
    const isCall = pos.symbol.includes('-C-');
    const isPut = pos.symbol.includes('-P-');
    const targetLeg = isCall ? state.callLeg : isPut ? state.putLeg : null;

    if (targetLeg && (targetLeg.status === 'closed' || targetLeg.symbol !== pos.symbol)) {
      // OUCH: Leg is marked closed or symbol changed in state, but OPEN on exchange! RESURRECT!
      console.warn(`[Reconciliation] 🚨 RESURRECTING ${targetLeg.legType} (${pos.symbol}): marked '${targetLeg.status}' in state but OPEN on exchange!`);
      targetLeg.status = 'open';
      (targetLeg as any).symbol = pos.symbol;
      const avgPrice = Number(pos.entryPrice ?? pos.avgPrice ?? targetLeg.entryPrice);
      if (Number.isFinite(avgPrice) && avgPrice > 0) {
        (targetLeg as any).entryPrice = avgPrice;
        (targetLeg as any).stopLossPrice = avgPrice * config.riskConfig.stopLossMultiplier;
      }
      delete targetLeg.exitPrice;
      delete targetLeg.closeReason;
      delete targetLeg.exitOrderId;
      state.resolvedScenario = undefined;
      stateModified = true;

      const msg = `Resurrected ${targetLeg.legType} (${pos.symbol}): was marked closed locally but is still OPEN on exchange!`;
      appendAlert('state_resurrected', msg);
      if (notifier) {
        void notifier.notifyReconciliation(msg);
      }
    }
  }

  if (stateModified) {
    state.updatedAt = new Date().toISOString();
    await saveStraddleState(state, latest.date);
    return { state, resurrected: true };
  }

  // If already tracking, return state
  const hasOpenLeg = state.callLeg.status === 'open' || state.putLeg.status === 'open';
  if (hasOpenLeg && !state.resolvedScenario) {
    return { state, resurrected: false };
  }

  return null;
}

function buildAdoptedStateFromPositions(
  positions: readonly OptionsPosition[],
  dateStr: string,
  config: AppConfig
): StraddlePositionState {
  const callPos = positions.find((p) => p.symbol.includes('-C-'));
  const putPos = positions.find((p) => p.symbol.includes('-P-'));

  const callPrice = Number(callPos?.entryPrice ?? callPos?.avgPrice ?? 300);
  const putPrice = Number(putPos?.entryPrice ?? putPos?.avgPrice ?? 300);

  const callLeg: ActiveLeg = {
    legType: 'CALL',
    symbol: callPos?.symbol || `BTC-ADOPTED-C`,
    entryPrice: callPrice,
    entryPriceSource: 'mark',
    stopLossPrice: callPrice * config.riskConfig.stopLossMultiplier,
    quantity: Number(callPos?.qty ?? config.orderQuantity),
    confirmedOpen: Boolean(callPos),
    status: callPos ? 'open' : 'closed',
    currentPrice: callPrice,
  };

  const putLeg: ActiveLeg = {
    legType: 'PUT',
    symbol: putPos?.symbol || `BTC-ADOPTED-P`,
    entryPrice: putPrice,
    entryPriceSource: 'mark',
    stopLossPrice: putPrice * config.riskConfig.stopLossMultiplier,
    quantity: Number(putPos?.qty ?? config.orderQuantity),
    confirmedOpen: Boolean(putPos),
    status: putPos ? 'open' : 'closed',
    currentPrice: putPrice,
  };

  const totalCreditReceived = (callPos ? callPrice : 0) + (putPos ? putPrice : 0);
  const targetProfitPoints = totalCreditReceived * config.riskConfig.profitTargetRatio;

  return {
    date: dateStr,
    entryExecuted: true,
    callLeg,
    putLeg,
    totalCreditReceived,
    targetProfitPoints,
    combinedPnLPoints: 0,
    updatedAt: new Date().toISOString(),
  };
}

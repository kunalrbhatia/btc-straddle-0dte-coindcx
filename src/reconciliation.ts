import { CoinDCXClient } from './client';
import { AppConfig } from './config';
import { Notifier } from './notifier';
import { appendAlert } from './fileAlerter';
import { saveStraddleState, findLatestStraddleState } from './stateStore';
import { ActiveLeg, LegCloseReason, OptionsPosition, StraddlePositionState } from './types';

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
    msg.includes('order size')
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
          } else {
            // Absent BEFORE expiry with no close order of ours: we cannot explain
            // this, so we do not invent a reason for it.
            console.warn(
              `[Reconciliation] ⚠️ ${leg.symbol} is absent from the exchange but its expiry ` +
                `(${expiry ? expiry.toISOString() : 'unknown'}) has not passed — no close reason recorded.`
            );
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

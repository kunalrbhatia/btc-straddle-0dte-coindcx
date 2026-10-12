import { CoinDCXClient } from '../client';
import { TelegramNotifier } from '../notifier';
import { OneDteConfig } from './config';
import { selectOneDteContracts } from './selector';
import { OneDtePositionState, OneDteLeg } from './types';
import { saveOneDteState } from './stateStore';
import { getTodayDateStringIST } from '../stateStore';

export async function executeOneDteEntry(
  client: CoinDCXClient,
  config: OneDteConfig,
  notifier?: TelegramNotifier
): Promise<OneDtePositionState | null> {
  console.log('\n[1DTE Execution] 🚀 Discovering and selecting 1 DTE contracts...');
  const contracts = await selectOneDteContracts(client, config);
  if (!contracts) {
    const errMsg = '1 DTE contract discovery failed — skipping execution.';
    console.error(`[1DTE Execution] ❌ ${errMsg}`);
    if (notifier) void notifier.notifyError('1 DTE Discovery Failed', new Error(errMsg));
    return null;
  }

  const { call, put, expiryTimeMs } = contracts;
  // The venue only accepts option prices in multiples of ONEDTE_PRICE_TICK (default 5). Anything else
  // is rejected with 422 OCS-TECH-0013 "The min tick size should be 5." and the entry never happens.
  const roundToTick = (price: number, tick: number): number => {
    const t = Number.isFinite(tick) && tick > 0 ? tick : 5;
    // Floor, not nearest: as the seller we want a *marketable* ask so both legs fill and the strangle is
    // complete. Rounding up (129.44 -> 130) leaves the sell resting above the market, and a resting leg
    // is a one-sided naked short until it fills.
    return Math.floor(price / t) * t;
  };

  console.log(`[1DTE Execution] Call: ${call.symbol} (indicative: $${call.premium.toFixed(2)})`);
  console.log(`[1DTE Execution] Put : ${put.symbol} (indicative: $${put.premium.toFixed(2)})`);

  // Calculate target exit time: next day at config.exitHourIST:config.exitMinuteIST IST
  const now = new Date();
  const istOffsetMs = 330 * 60 * 1000;
  const nowIst = new Date(now.getTime() + istOffsetMs);
  // Next day IST
  const nextDayIstYear = nowIst.getUTCFullYear();
  const nextDayIstMonth = nowIst.getUTCMonth();
  const nextDayIstDate = nowIst.getUTCDate() + 1;

  const targetExitIstMs = Date.UTC(
    nextDayIstYear,
    nextDayIstMonth,
    nextDayIstDate,
    config.exitHourIST,
    config.exitMinuteIST,
    0,
    0
  );
  const targetExitUtcMs = targetExitIstMs - istOffsetMs;

  console.log(
    `[1DTE Execution] Target scheduled exit: ${new Date(targetExitUtcMs).toISOString()} (${config.exitHourIST}:${String(config.exitMinuteIST).padStart(2, '0')} IST next day)`
  );

  // Place Sell Orders
  console.log(`[1DTE Execution] Placing SELL orders for ${call.symbol} and ${put.symbol}...`);
  const [callOrder, putOrder] = await Promise.all([
    client.placeOptionsOrder(
      call.symbol,
      'sell',
      config.orderQuantity,
      config.entryOrderType,
      config.entryOrderType === 'Limit' ? roundToTick(call.premium, config.priceTick) : undefined,
      '',
      '',
      undefined,
      false
    ),
    client.placeOptionsOrder(
      put.symbol,
      'sell',
      config.orderQuantity,
      config.entryOrderType,
      config.entryOrderType === 'Limit' ? roundToTick(put.premium, config.priceTick) : undefined,
      '',
      '',
      undefined,
      false
    ),
  ]);

  if (!callOrder.success || !putOrder.success) {
    console.error(
      `[1DTE Execution] 🚨 Order placement issue: Call=${callOrder.success ? 'OK' : callOrder.message}, Put=${putOrder.success ? 'OK' : putOrder.message}`
    );
  }

  // Determine entry prices (limitPrice or fallback to indicative)
  const callEntry = callOrder.limitPrice ?? call.premium;
  const putEntry = putOrder.limitPrice ?? put.premium;

  // Stop loss orders: 2x entry price
  const callStopPrice = Math.round(callEntry * config.stopLossMultiplier);
  const putStopPrice = Math.round(putEntry * config.stopLossMultiplier);

  console.log(`[1DTE Execution] Call entry: $${callEntry.toFixed(2)}, SL trigger: $${callStopPrice}`);
  console.log(`[1DTE Execution] Put entry : $${putEntry.toFixed(2)}, SL trigger: $${putStopPrice}`);

  // Place resting Stop-Loss orders on exchange (Limit Buy with stopLoss trigger, reduceOnly: true)
  let callStopOrderId: string | undefined;
  let putStopOrderId: string | undefined;

  try {
    const callStopRes = await client.placeOptionsOrder(
      call.symbol,
      'buy',
      config.orderQuantity,
      'Limit',
      callStopPrice,
      String(callStopPrice),
      '',
      undefined,
      true
    );
    if (callStopRes.success) {
      callStopOrderId = callStopRes.orderId;
      console.log(`[1DTE Execution] ✅ Armed Call Stop Order ID: ${callStopOrderId} @ $${callStopPrice}`);
    } else {
      console.warn(`[1DTE Execution] ⚠️ Could not arm Call Stop Order on venue: ${callStopRes.message}`);
    }
  } catch (err) {
    console.error(`[1DTE Execution] ⚠️ Error placing Call SL: ${(err as Error).message}`);
  }

  try {
    const putStopRes = await client.placeOptionsOrder(
      put.symbol,
      'buy',
      config.orderQuantity,
      'Limit',
      putStopPrice,
      String(putStopPrice),
      '',
      undefined,
      true
    );
    if (putStopRes.success) {
      putStopOrderId = putStopRes.orderId;
      console.log(`[1DTE Execution] ✅ Armed Put Stop Order ID: ${putStopOrderId} @ $${putStopPrice}`);
    } else {
      console.warn(`[1DTE Execution] ⚠️ Could not arm Put Stop Order on venue: ${putStopRes.message}`);
    }
  } catch (err) {
    console.error(`[1DTE Execution] ⚠️ Error placing Put SL: ${(err as Error).message}`);
  }

  const callLeg: OneDteLeg = {
    legType: 'CALL',
    symbol: call.symbol,
    strikePrice: call.strikePrice,
    entryPrice: callEntry,
    stopLossPrice: callStopPrice,
    quantity: config.orderQuantity,
    orderId: callOrder.orderId,
    stopOrderId: callStopOrderId,
    status: callOrder.success ? 'open' : 'closed',
    currentPrice: callEntry,
  };

  const putLeg: OneDteLeg = {
    legType: 'PUT',
    symbol: put.symbol,
    strikePrice: put.strikePrice,
    entryPrice: putEntry,
    stopLossPrice: putStopPrice,
    quantity: config.orderQuantity,
    orderId: putOrder.orderId,
    stopOrderId: putStopOrderId,
    status: putOrder.success ? 'open' : 'closed',
    currentPrice: putEntry,
  };

  const todayStr = getTodayDateStringIST();
  const state: OneDtePositionState = {
    date: todayStr,
    expiryTimeMs,
    entryExecuted: true,
    targetExitUtcMs,
    callLeg,
    putLeg,
    totalCreditReceived: callEntry + putEntry,
    combinedPnLPoints: 0,
    status: 'active',
  };

  await saveOneDteState(state, todayStr);
  console.log(`[1DTE Execution] State successfully persisted to state/onedte-state-${todayStr}.json`);

  if (notifier) {
    void notifier.notifyStraddleEntered({
      strike: Math.round((call.strikePrice + put.strikePrice) / 2),
      callSymbol: call.symbol,
      callPrice: callEntry,
      callPriceSource: 'fill',
      putSymbol: put.symbol,
      putPrice: putEntry,
      putPriceSource: 'fill',
      totalCredit: callEntry + putEntry,
      callSL: callStopPrice,
      putSL: putStopPrice,
      targetProfit: 0,
    });
  }

  return state;
}

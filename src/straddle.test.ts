import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeShortStraddle,
  calculateAtmStrike,
  generateContractSymbols,
  waitForFills,
  discoverAtmStraddleFromInstruments,
  determineAtmStraddle,
} from './straddle';
import { CoinDCXClient } from './client';
import { AppConfig } from './config';
import { OptionsInstrument } from './types';
import { Notifier } from './notifier';

/**
 * Contract symbols for whichever expiry the bot derives RIGHT NOW.
 *
 * Tests must not hardcode a date: the entry rolls to the next day once the
 * 08:00 UTC expiry passes, so a hardcoded 'BTC-4OCT26-...' silently stops
 * matching the bot's real symbols (and these ticker mocks) after that rollover,
 * turning a green suite red for reasons that have nothing to do with the code.
 */
const CURRENT = generateContractSymbols(84750);

const mockConfig: AppConfig = {
  apiKey: 'test-key',
  apiSecret: 'test-secret',
  bearerToken: '',
  baseUrl: 'https://api.coindcx.com',
  scheduledHourIST: 18,
  scheduledMinuteIST: 15,
  dailyExpiryHourUTC: 8,
  strikeStep: 250,
  orderQuantity: 0.01,
  leverage: 10,
  marginCurrency: 'USDT',
  dryRun: false,
  conversionRate: '102',
  entryOrderType: 'Limit',
  entryFillTimeoutMs: 15000,
  riskConfig: {
    stopLossMultiplier: 2.0,
    profitTargetRatio: 0.55,
    pollIntervalMs: 2000,
    maxMonitorMinutes: 720,
  },
};

describe('Straddle Execution & Unwind Tests', () => {
  it('calculateAtmStrike rounds correctly to nearest step', () => {
    assert.equal(calculateAtmStrike(84249, 500), 84000);
    assert.equal(calculateAtmStrike(84251, 500), 84500);
    assert.equal(calculateAtmStrike(85000, 500), 85000);
  });

  it('generateContractSymbols formats symbols accurately', () => {
    const fixedDate = new Date(2026, 9, 3); // Oct is month index 9
    const symbols = generateContractSymbols(84500, fixedDate);
    assert.equal(symbols.callSymbol, 'BTC-3OCT26-84500-C-USDT');
    assert.equal(symbols.putSymbol, 'BTC-3OCT26-84500-P-USDT');
  });

  it('rolls the expiry to the NEXT day when the entry is after the daily expiry', () => {
    // Regression for the 2026-10-03 failure: entry at 18:15 IST (12:45 UTC) is
    // AFTER the 08:00 UTC daily expiry, so the exchange's live contract was
    // BTC-4OCT26-..., not BTC-3OCT26-... . Asking for today's already-expired
    // contract produced " does not exist." and wasted the entry window.
    const entry = new Date('2026-10-03T12:45:00.000Z'); // 18:15 IST
    const symbols = generateContractSymbols(84750, entry);
    // Fixed input date => fixed expected symbols (this test is deliberately date-pinned).
    assert.equal(symbols.callSymbol, 'BTC-4OCT26-84750-C-USDT');
    assert.equal(symbols.putSymbol, 'BTC-4OCT26-84750-P-USDT');
  });

  it('keeps same-day expiry when the entry is before the daily expiry', () => {
    const beforeExpiry = new Date('2026-10-03T05:00:00.000Z'); // 10:30 IST
    const symbols = generateContractSymbols(84750, beforeExpiry);
    assert.equal(symbols.callSymbol, 'BTC-3OCT26-84750-C-USDT');
  });

  it('shifts the derived contract when DAILY_EXPIRY_HOUR_UTC is customized', () => {
    // At 10:00 UTC (15:30 IST):
    // If daily expiry is 8 (08:00 UTC), 10:00 UTC is AFTER expiry -> rolls to NEXT day (4OCT26).
    // If daily expiry is changed to 12 (12:00 UTC), 10:00 UTC is BEFORE expiry -> stays on SAME day (3OCT26).
    const midDay = new Date('2026-10-03T10:00:00.000Z');
    const symbolsWithDefault8 = generateContractSymbols(84750, midDay, 8);
    assert.equal(symbolsWithDefault8.callSymbol, 'BTC-4OCT26-84750-C-USDT');

    const symbolsWithCustom12 = generateContractSymbols(84750, midDay, 12);
    assert.equal(symbolsWithCustom12.callSymbol, 'BTC-3OCT26-84750-C-USDT');
  });

  it('aborts cleanly when both Call and Put entry orders fail', async () => {
    let callOrderPlaced = false;
    let putOrderPlaced = false;

    const mockClient = {
      getBtcSpotPrice: async () => 84520,
      isContractListed: async () => true,
      resolveConversionRate: async () => '102',
      placeOrder: async (order: { pair: string }) => {
        if (order.pair.includes('-C-')) {
          callOrderPlaced = true;
          return { symbol: order.pair, side: 'sell', success: false, message: 'Insufficient margin', rawResponse: {} };
        } else {
          putOrderPlaced = true;
          return { symbol: order.pair, side: 'sell', success: false, message: 'Insufficient margin', rawResponse: {} };
        }
      },
    } as unknown as CoinDCXClient;

    let abortedReason = '';
    const mockNotifier: Notifier = {
      isEnabled: true,
      notifyStraddleEntered: async () => {},
      notifyLegClosed: async () => {},
      notifyScenarioResolved: async () => {},
      notifyEntryAborted: async (p) => {
        abortedReason = p.reason;
      },
      notifyError: async () => {},
      notifyReconciliation: async () => {},
    };

    const result = await executeShortStraddle(mockClient, mockConfig, mockNotifier);

    assert.equal(callOrderPlaced, true);
    assert.equal(putOrderPlaced, true);
    assert.equal(result.success, false);
    assert.equal(result.partialFailure, false);
    assert.match(abortedReason, /Both Call and Put entry orders failed/i);
  });

  it('unwinds Call leg immediately if Call succeeds but Put fails (partial failure)', async () => {
    let unwoundSymbol = '';
    let unwoundQuantity = 0;

    const mockClient = {
      getBtcSpotPrice: async () => 84520,
      isContractListed: async () => true,
      resolveConversionRate: async () => '102',
      placeOrder: async (order: { pair: string }) => {
        if (order.pair.includes('-C-')) {
          return {
            symbol: order.pair,
            side: 'sell',
            success: true,
            orderId: 'call-ok-1',
            rawResponse: { avg_price: 320 },
          };
        } else {
          return {
            symbol: order.pair,
            side: 'sell',
            success: false,
            message: 'Rejected by risk engine',
            rawResponse: {},
          };
        }
      },
      closePosition: async (symbol: string, quantity: number) => {
        unwoundSymbol = symbol;
        unwoundQuantity = quantity;
        return { success: true, orderId: 'unwind-call-1' };
      },
    } as unknown as CoinDCXClient;

    let notifiedUnwound = '';
    const mockNotifier: Notifier = {
      isEnabled: true,
      notifyStraddleEntered: async () => {},
      notifyLegClosed: async () => {},
      notifyScenarioResolved: async () => {},
      notifyEntryAborted: async (p) => {
        if (p.unwoundLeg) notifiedUnwound = p.unwoundLeg;
      },
      notifyError: async () => {},
      notifyReconciliation: async () => {},
    };

    const result = await executeShortStraddle(mockClient, mockConfig, mockNotifier);

    assert.equal(result.success, false);
    assert.equal(result.partialFailure, true);
    assert.equal(unwoundQuantity, mockConfig.orderQuantity);
    assert.equal(result.unwoundLeg, unwoundSymbol);
    assert.equal(notifiedUnwound, unwoundSymbol);
  });

  it('unwinds Put leg immediately if Put succeeds but Call fails (partial failure)', async () => {
    let unwoundSymbol = '';
    let unwoundQuantity = 0;

    const mockClient = {
      getBtcSpotPrice: async () => 84520,
      isContractListed: async () => true,
      resolveConversionRate: async () => '102',
      placeOrder: async (order: { pair: string }) => {
        if (order.pair.includes('-C-')) {
          return {
            symbol: order.pair,
            side: 'sell',
            success: false,
            message: 'Order rate limit exceeded',
            rawResponse: {},
          };
        } else {
          return {
            symbol: order.pair,
            side: 'sell',
            success: true,
            orderId: 'put-ok-1',
            rawResponse: { avg_price: 290 },
          };
        }
      },
      closePosition: async (symbol: string, quantity: number) => {
        unwoundSymbol = symbol;
        unwoundQuantity = quantity;
        return { success: true, orderId: 'unwind-put-1' };
      },
    } as unknown as CoinDCXClient;

    let notifiedUnwound = '';
    const mockNotifier: Notifier = {
      isEnabled: true,
      notifyStraddleEntered: async () => {},
      notifyLegClosed: async () => {},
      notifyScenarioResolved: async () => {},
      notifyEntryAborted: async (p) => {
        if (p.unwoundLeg) notifiedUnwound = p.unwoundLeg;
      },
      notifyError: async () => {},
      notifyReconciliation: async () => {},
    };

    const result = await executeShortStraddle(mockClient, mockConfig, mockNotifier);

    assert.equal(result.success, false);
    assert.equal(result.partialFailure, true);
    assert.equal(unwoundQuantity, mockConfig.orderQuantity);
    assert.equal(result.unwoundLeg, unwoundSymbol);
    assert.equal(notifiedUnwound, unwoundSymbol);
  });

  it('pre-flight blocks ordering when a contract is not listed on the exchange', async () => {
    // Regression guard for 2026-10-03: CoinDCX rejected both legs with a blank
    // symbol error (" does not exist."). The pre-flight must catch that BEFORE
    // any order is sent — a doomed order wastes the once-daily entry window.
    let anyOrderSent = false;

    const mockClient = {
      getBtcSpotPrice: async () => 84822,
      // CALL is listed, PUT is not => both must be listed for a straddle
      isContractListed: async (symbol: string) => symbol.includes('-C-'),
      resolveConversionRate: async () => '102',
      placeOrder: async () => {
        anyOrderSent = true;
        return { symbol: 'x', side: 'sell', success: true, rawResponse: {} };
      },
      placeOptionsOrder: async () => {
        anyOrderSent = true;
        return { symbol: 'x', side: 'sell', success: true, rawResponse: {} };
      },
      closePosition: async () => {
        anyOrderSent = true;
        return { symbol: 'x', side: 'buy', success: true, rawResponse: {} };
      },
    } as unknown as CoinDCXClient;

    let abortedReason = '';
    const mockNotifier: Notifier = {
      isEnabled: true,
      notifyStraddleEntered: async () => {},
      notifyLegClosed: async () => {},
      notifyScenarioResolved: async () => {},
      notifyEntryAborted: async (p) => {
        abortedReason = p.reason;
      },
      notifyError: async () => {},
      notifyReconciliation: async () => {},
    };

    const result = await executeShortStraddle(mockClient, mockConfig, mockNotifier);

    assert.equal(result.success, false, 'pre-flight failure must report success=false');
    assert.equal(result.partialFailure, false, 'nothing was filled, so not a partial failure');
    assert.equal(anyOrderSent, false, 'NO order (or close) may be sent when pre-flight fails');
    assert.match(abortedReason, /Pre-flight failed/);
    assert.match(abortedReason, /NOT FOUND/);
  });

  it('pre-flight allows ordering when both contracts are listed', async () => {
    let ordersSent = 0;

    // Pre-flight + entry-price resolution each read the mark (4 calls at 350),
    // then the monitor sees a much cheaper mark (10) which fires the profit
    // target and terminates the monitor loop — otherwise the interval never
    // clears and the test runner hangs. (Must stay > 0: the monitor ignores
    // non-positive prices.)
    let priceCalls = 0;

    const mockClient = {
      getBtcSpotPrice: async () => 84822,
      getContractPrice: async () => {
        priceCalls += 1;
        return priceCalls <= 4 ? 350 : 10;
      },
      isContractListed: async () => true,
      resolveConversionRate: async () => '102',
      placeOptionsOrder: async (symbol: string) => {
        ordersSent += 1;
        return { symbol, side: 'sell', success: true, orderId: `id-${ordersSent}`, rawResponse: {} };
      },
      placeOrder: async (order: { pair: string }) => {
        ordersSent += 1;
        return { symbol: order.pair, side: 'sell', success: true, orderId: `id-${ordersSent}`, rawResponse: {} };
      },
      closePosition: async () => ({ symbol: 'x', side: 'buy', success: true, rawResponse: {} }),
    } as unknown as CoinDCXClient;

    const mockNotifier: Notifier = {
      isEnabled: true,
      notifyStraddleEntered: async () => {},
      notifyLegClosed: async () => {},
      notifyScenarioResolved: async () => {},
      notifyEntryAborted: async () => {},
      notifyError: async () => {},
      notifyReconciliation: async () => {},
    };

    const result = await executeShortStraddle(mockClient, mockConfig, mockNotifier);

    assert.equal(ordersSent, 2, 'both legs should be sent once pre-flight passes');
    assert.equal(result.success, true);
    assert.equal(result.callOutcome.success, true);
    assert.equal(result.putOutcome.success, true);
  });

  it('unwinds BOTH legs when state init fails AFTER both legs filled (naked-short guard)', async () => {
    // Regression guard: previously this path logged the error and returned, leaving
    // a filled, unmonitored short straddle open with no state file.
    const closed: string[] = [];
    const mockClient = {
      getBtcSpotPrice: async () => 84822,
      isContractListed: async () => true,
      // No price available anywhere => entry price is unresolvable => state init throws.
      getContractPrice: async () => 0,
      resolveConversionRate: async () => '102',
      placeOptionsOrder: async (symbol: string) => ({
        symbol,
        side: 'sell',
        success: true,
        orderId: 'o1',
        rawResponse: {},
      }),
      placeOrder: async (order: { pair: string }) => ({
        symbol: order.pair,
        side: 'sell',
        success: true,
        orderId: 'o1',
        rawResponse: {},
      }),
      closePosition: async (symbol: string) => {
        closed.push(symbol);
        return { symbol, side: 'buy', success: true, rawResponse: {} };
      },
    } as unknown as CoinDCXClient;

    const mockNotifier: Notifier = {
      isEnabled: true,
      notifyStraddleEntered: async () => {},
      notifyLegClosed: async () => {},
      notifyScenarioResolved: async () => {},
      notifyEntryAborted: async () => {},
      notifyError: async () => {},
      notifyReconciliation: async () => {},
    };

    const result = await executeShortStraddle(mockClient, mockConfig, mockNotifier);

    assert.equal(result.success, false);
    assert.equal(result.partialFailure, true, 'entry failed after fills => partial failure');
    assert.equal(closed.length, 2, 'both filled legs must be unwound, not left naked');
    assert.match(result.message ?? '', /Unwound 2\/2 legs/);
  });

  describe('Limit Orders & Live Bid Pricing Tests', () => {
    it('prices Limit orders from live bidPrice and sends stopLoss = 2 * price', async () => {
      let callOrderPlaced: Record<string, unknown> | undefined;
      let putOrderPlaced: Record<string, unknown> | undefined;

      const mockClient = {
        getBearerToken: () => 'valid-bearer-token',
        getBtcSpotPrice: async () => 84750,
        isContractListed: async () => true,
        getOptionsTicker: async () => [
          { symbol: CURRENT.callSymbol, bidPrice: '416.00', askPrice: '418.00' },
          { symbol: CURRENT.putSymbol, bidPrice: '380.50', askPrice: '382.00' },
        ],
        resolveConversionRate: async () => '102',
        placeOptionsOrder: async (
          symbol: string,
          side: 'buy' | 'sell',
          qty: number,
          orderType: 'Limit' | 'Market',
          price?: number | string,
          stopLoss?: string,
          takeProfit?: string
        ) => {
          if (symbol.includes('-C-')) {
            callOrderPlaced = { symbol, side, qty, orderType, price, stopLoss, takeProfit };
            return { symbol, side, success: true, orderId: 'call-1', limitPrice: Number(price), rawResponse: { status: 'filled' } };
          } else {
            putOrderPlaced = { symbol, side, qty, orderType, price, stopLoss, takeProfit };
            return { symbol, side, success: true, orderId: 'put-1', limitPrice: Number(price), rawResponse: { status: 'filled' } };
          }
        },
        getOpenOptionsOrders: async () => [],
        getContractPrice: async () => 10, // Drives monitor immediately to terminal profit target
        closePosition: async () => ({ symbol: 'x', side: 'buy', success: true, rawResponse: {} }),
      } as unknown as CoinDCXClient;

      const fastConfig = { ...mockConfig, riskConfig: { ...mockConfig.riskConfig, pollIntervalMs: 20 } };
      const result = await executeShortStraddle(mockClient, fastConfig);

      assert.equal(result.success, true);
      assert.equal(callOrderPlaced?.orderType, 'Limit');
      assert.equal(callOrderPlaced?.price, 416.0);
      assert.equal(callOrderPlaced?.stopLoss, '832.00'); // 416 * 2.0
      assert.equal(callOrderPlaced?.takeProfit, '');

      assert.equal(putOrderPlaced?.orderType, 'Limit');
      assert.equal(putOrderPlaced?.price, 380.5);
      assert.equal(putOrderPlaced?.stopLoss, '761.00'); // 380.5 * 2.0
      assert.equal(putOrderPlaced?.takeProfit, '');
    });

    it('aborts entry with zero orders sent if bidPrice is missing or <= 0', async () => {
      let ordersSent = 0;
      let alertMsg = '';

      const mockClient = {
        getBearerToken: () => 'valid-bearer-token',
        getBtcSpotPrice: async () => 84750,
        isContractListed: async () => true,
        getOptionsTicker: async () => [
          { symbol: CURRENT.callSymbol, bidPrice: '0', askPrice: '418.00' }, // bid is 0!
          { symbol: CURRENT.putSymbol, bidPrice: '380.50', askPrice: '382.00' },
        ],
        resolveConversionRate: async () => '102',
        placeOptionsOrder: async () => {
          ordersSent++;
          return { symbol: 'x', side: 'sell', success: true, rawResponse: {} };
        },
      } as unknown as CoinDCXClient;

      const mockNotifier: Notifier = {
        isEnabled: true,
        notifyStraddleEntered: async () => {},
        notifyLegClosed: async () => {},
        notifyScenarioResolved: async () => {},
        notifyEntryAborted: async (p) => {
          alertMsg = p.reason;
        },
        notifyError: async () => {},
        notifyReconciliation: async () => {},
      };

      const result = await executeShortStraddle(mockClient, mockConfig, mockNotifier);

      assert.equal(ordersSent, 0, 'ZERO orders must be sent when a leg lacks a usable bid quote');
      assert.equal(result.success, false);
      assert.match(alertMsg, /Missing or invalid bidPrice quote/);
    });

    it('cancels both orders and aborts with zero exposure if neither fills within timeout', async () => {
      const cancelled: string[] = [];

      const mockClient = {
        getBearerToken: () => 'valid-bearer-token',
        getBtcSpotPrice: async () => 84750,
        isContractListed: async () => true,
        getOptionsTicker: async () => [
          { symbol: CURRENT.callSymbol, bidPrice: '416.00' },
          { symbol: CURRENT.putSymbol, bidPrice: '380.50' },
        ],
        resolveConversionRate: async () => '102',
        placeOptionsOrder: async (symbol: string) => ({
          symbol,
          side: 'sell' as const,
          success: true,
          orderId: `ord-${symbol}`,
          limitPrice: 400,
          rawResponse: { status: 'open' },
        }),
        getOpenOptionsOrders: async () => [
          // Still resting on the book => NOT filled. Order IDs match placeOptionsOrder returns.
          { orderId: `ord-${CURRENT.callSymbol}`, symbol: CURRENT.callSymbol, orderStatus: 'New', cumExecValue: '0' },
          { orderId: `ord-${CURRENT.putSymbol}`, symbol: CURRENT.putSymbol, orderStatus: 'New', cumExecValue: '0' },
        ],
        cancelOptionsOrder: async (orderId: string) => {
          cancelled.push(orderId);
          return true;
        },
        closePosition: async () => ({ symbol: 'x', side: 'buy', success: true, rawResponse: {} }),
      } as unknown as CoinDCXClient;

      const customConfig = { ...mockConfig, entryFillTimeoutMs: 50 };
      const result = await executeShortStraddle(mockClient, customConfig);

      assert.equal(result.success, false);
      assert.equal(cancelled.length, 2, 'both unfilled orders must be cancelled');
      assert.match(result.message ?? '', /Neither Call nor Put limit order filled within/);
    });

    it('cancels unfilled leg and immediately unwinds filled leg upon partial fill timeout', async () => {
      const cancelled: string[] = [];
      const unwound: string[] = [];

      const mockClient = {
        getBearerToken: () => 'valid-bearer-token',
        getBtcSpotPrice: async () => 84750,
        isContractListed: async () => true,
        getOptionsTicker: async () => [
          { symbol: CURRENT.callSymbol, bidPrice: '416.00' },
          { symbol: CURRENT.putSymbol, bidPrice: '380.50' },
        ],
        resolveConversionRate: async () => '102',
        placeOptionsOrder: async (symbol: string) => {
          if (symbol.includes('-C-')) {
            // Call is filled immediately
            return {
              symbol,
              side: 'sell' as const,
              success: true,
              orderId: 'call-filled-1',
              limitPrice: 416,
              rawResponse: { status: 'filled' },
            };
          } else {
            // Put remains open in orderbook
            return {
              symbol,
              side: 'sell' as const,
              success: true,
              orderId: 'put-unfilled-1',
              limitPrice: 380.5,
              rawResponse: { status: 'open' },
            };
          }
        },
        getOpenOptionsOrders: async () => [
          { id: 'put-unfilled-1', status: 'open' },
        ],
        cancelOptionsOrder: async (orderId: string) => {
          cancelled.push(orderId);
          return true;
        },
        closePosition: async (symbol: string) => {
          unwound.push(symbol);
          return { symbol, side: 'buy', success: true, rawResponse: {} };
        },
      } as unknown as CoinDCXClient;

      const customConfig = { ...mockConfig, entryFillTimeoutMs: 50 };
      const result = await executeShortStraddle(mockClient, customConfig);

      assert.equal(result.success, false);
      assert.equal(result.partialFailure, true);
      assert.equal(cancelled.includes('put-unfilled-1'), true, 'unfilled put must be cancelled');
      assert.equal(unwound.length, 1);
      assert.match(unwound[0], /-C-/, 'filled call must be unwound immediately');
    });
  });

  describe('Fill confirmation must never trust a failed feed', () => {
    it('waitForFills reports NOT filled when the orders feed keeps failing', async () => {
      // Regression guard for the silent-failure hole found in review: getOpenOptionsOrders
      // used to return [] on a 5xx / network error, and "absent from open orders" means
      // "filled" — so ONE transient blip made BOTH legs look filled, skipping every
      // cancel/unwind branch and starting risk management on a position that might not
      // exist (or leaving a one-sided fill unhedged). It now throws, the poller retries,
      // and a feed that never recovers reports "not filled" so the caller cancels.
      let polls = 0;
      const failingClient = {
        getOpenOptionsOrders: async () => {
          polls += 1;
          throw new Error('Failed to fetch open options orders: HTTP 500');
        },
      } as unknown as CoinDCXClient;

      const outcome = {
        symbol: 'BTC-4OCT26-85000-C-USDT',
        side: 'sell' as const,
        success: true,
        orderId: 'o1',
        rawResponse: {}, // carries no fill fields
      };

      const res = await waitForFills(
        failingClient,
        'BTC-4OCT26-85000-C-USDT',
        'BTC-4OCT26-85000-P-USDT',
        outcome,
        outcome,
        250,
        50
      );

      assert.equal(res.callFilled, false, 'a failing feed must never imply a fill');
      assert.equal(res.putFilled, false, 'a failing feed must never imply a fill');
      assert.ok(polls > 0, 'the poller must retry rather than conclude');
    });

    it('a confirmed-empty open-orders list is still treated as filled', async () => {
      // The healthy path must be unchanged: fetch succeeds, order is absent => filled.
      const healthyClient = {
        getOpenOptionsOrders: async () => [],
      } as unknown as CoinDCXClient;

      const outcome = {
        symbol: 'BTC-4OCT26-85000-C-USDT',
        side: 'sell' as const,
        success: true,
        orderId: 'o2',
        rawResponse: {},
      };

      const res = await waitForFills(
        healthyClient,
        'BTC-4OCT26-85000-C-USDT',
        'BTC-4OCT26-85000-P-USDT',
        outcome,
        outcome,
        250,
        50
      );

      assert.equal(res.callFilled, true);
      assert.equal(res.putFilled, true);
    });
  });

  describe('Exchange Instruments & Expiry Discovery Tests', () => {
    const fixedNow = new Date('2026-10-05T12:45:00.000Z'); // 18:15 IST on 05 Oct 2026

    it('discovers earliest active expiry and extracts verbatim symbols from real listing shape', () => {
      const mockListing: readonly OptionsInstrument[] = [
        {
          symbol: 'BTC-6OCT26-85000-C-USDT',
          displayName: 'BTC-6OCT26-85000-C',
          expiryTime: String(Date.UTC(2026, 9, 6, 8, 0, 0)),
          strikePrice: '85000',
          optionsType: 'Call',
          isActive: true,
        },
        {
          symbol: 'BTC-6OCT26-85000-P-USDT',
          displayName: 'BTC-6OCT26-85000-P',
          expiryTime: String(Date.UTC(2026, 9, 6, 8, 0, 0)),
          strikePrice: '85000',
          optionsType: 'Put',
          isActive: true,
        },
        {
          symbol: 'BTC-7OCT26-85000-C-USDT',
          displayName: 'BTC-7OCT26-85000-C',
          expiryTime: String(Date.UTC(2026, 9, 7, 8, 0, 0)),
          strikePrice: '85000',
          optionsType: 'Call',
          isActive: true,
        },
        {
          symbol: 'BTC-7OCT26-85000-P-USDT',
          displayName: 'BTC-7OCT26-85000-P',
          expiryTime: String(Date.UTC(2026, 9, 7, 8, 0, 0)),
          strikePrice: '85000',
          optionsType: 'Put',
          isActive: true,
        },
      ];

      const discovered = discoverAtmStraddleFromInstruments(mockListing, 84980, 250, fixedNow, 30);
      assert.ok(discovered);
      assert.equal(discovered.atmStrike, 85000);
      assert.equal(discovered.callSymbol, 'BTC-6OCT26-85000-C-USDT');
      assert.equal(discovered.putSymbol, 'BTC-6OCT26-85000-P-USDT');
      assert.equal(discovered.expiryTimeMs, Date.UTC(2026, 9, 6, 8, 0, 0));
    });

    it('skipped-date case: when 08 Oct is skipped, selects 09 Oct instead of failing', () => {
      // Entry at 18:15 IST on 07 Oct (12:45 UTC).
      // Next day arithmetic would have expected 08 Oct. But exchange listing skips 08 Oct and jumps to 09 Oct!
      const entryTime = new Date('2026-10-07T12:45:00.000Z');
      const mockListingWithSkippedDate: readonly OptionsInstrument[] = [
        // 07 Oct expired or active earlier today (08:00 UTC was 4h 45m ago)
        {
          symbol: 'BTC-7OCT26-85000-C-USDT',
          expiryTime: String(Date.UTC(2026, 9, 7, 8, 0, 0)),
          strikePrice: '85000',
          optionsType: 'Call',
          isActive: true,
        },
        {
          symbol: 'BTC-7OCT26-85000-P-USDT',
          expiryTime: String(Date.UTC(2026, 9, 7, 8, 0, 0)),
          strikePrice: '85000',
          optionsType: 'Put',
          isActive: true,
        },
        // NOTICE: 08 Oct is NOT in the listing (it was skipped by CoinDCX!)
        // Next available listing is 09 Oct:
        {
          symbol: 'BTC-9OCT26-85000-C-USDT',
          expiryTime: String(Date.UTC(2026, 9, 9, 8, 0, 0)),
          strikePrice: '85000',
          optionsType: 'Call',
          isActive: true,
        },
        {
          symbol: 'BTC-9OCT26-85000-P-USDT',
          expiryTime: String(Date.UTC(2026, 9, 9, 8, 0, 0)),
          strikePrice: '85000',
          optionsType: 'Put',
          isActive: true,
        },
        {
          symbol: 'BTC-16OCT26-85000-C-USDT',
          expiryTime: String(Date.UTC(2026, 9, 16, 8, 0, 0)),
          strikePrice: '85000',
          optionsType: 'Call',
          isActive: true,
        },
      ];

      const discovered = discoverAtmStraddleFromInstruments(mockListingWithSkippedDate, 85020, 250, entryTime, 30);
      assert.ok(discovered);
      assert.equal(discovered.atmStrike, 85000);
      assert.equal(discovered.callSymbol, 'BTC-9OCT26-85000-C-USDT');
      assert.equal(discovered.putSymbol, 'BTC-9OCT26-85000-P-USDT');
      assert.equal(discovered.expiryTimeMs, Date.UTC(2026, 9, 9, 8, 0, 0));
    });

    it('rejects an expiry less than EXPIRY_MIN_LEAD_MINUTES away in favour of a future expiry', () => {
      // Current time: 07:45 UTC.
      // Expiry 1: 08:00 UTC (15 mins away < 30 mins lead time) -> must be rejected.
      // Expiry 2: Tomorrow 08:00 UTC (24h 15m away) -> must be selected.
      const now = new Date('2026-10-06T07:45:00.000Z');
      const expiringSoonMs = Date.UTC(2026, 9, 6, 8, 0, 0); // 15 min away
      const tomorrowMs = Date.UTC(2026, 9, 7, 8, 0, 0);

      const mockListing: readonly OptionsInstrument[] = [
        {
          symbol: 'BTC-6OCT26-85000-C-USDT',
          expiryTime: String(expiringSoonMs),
          strikePrice: '85000',
          optionsType: 'Call',
          isActive: true,
        },
        {
          symbol: 'BTC-6OCT26-85000-P-USDT',
          expiryTime: String(expiringSoonMs),
          strikePrice: '85000',
          optionsType: 'Put',
          isActive: true,
        },
        {
          symbol: 'BTC-7OCT26-85000-C-USDT',
          expiryTime: String(tomorrowMs),
          strikePrice: '85000',
          optionsType: 'Call',
          isActive: true,
        },
        {
          symbol: 'BTC-7OCT26-85000-P-USDT',
          expiryTime: String(tomorrowMs),
          strikePrice: '85000',
          optionsType: 'Put',
          isActive: true,
        },
      ];

      const discovered = discoverAtmStraddleFromInstruments(mockListing, 85000, 250, now, 30);
      assert.ok(discovered);
      assert.equal(discovered.expiryTimeMs, tomorrowMs);
      assert.equal(discovered.callSymbol, 'BTC-7OCT26-85000-C-USDT');
      assert.equal(discovered.putSymbol, 'BTC-7OCT26-85000-P-USDT');
    });

    it('falls back to arithmetic calculation when getOptionsInstruments fails or returns empty', async () => {
      const mockClient = {
        getBtcSpotPrice: async () => 84750,
        getOptionsInstruments: async () => [],
      } as unknown as CoinDCXClient;

      const legs = await determineAtmStraddle(mockClient, mockConfig);
      assert.ok(legs);
      assert.equal(legs.atmStrike, 84750);
      assert.ok(legs.callSymbol.includes('84750-C-USDT'));
      assert.ok(legs.putSymbol.includes('84750-P-USDT'));
    });
  });
});


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MissingFillPriceError,
  calculateLegPnL,
  closeLeg,
  initializeStraddleState,
  resolveEntryPrice,
} from './riskManager';
import { ActiveLeg, OrderPlacementOutcome, StraddlePositionState } from './types';
import { CoinDCXClient } from './client';
import { AppConfig } from './config';
import { Notifier } from './notifier';

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

const MONTH_ABBREVS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Builds contract symbols for a given day, in the exchange's own format
 * (`BTC-<d><MON><yy>-<strike>-C-USDT`, expiry 08:00 UTC).
 *
 * Derived, never hardcoded: a literal tag (e.g. `5OCT26`) goes stale the moment that
 * date passes, and the test then silently exercises a different code path — this
 * suite has been red on an untouched `main` for exactly that reason.
 */
function contractSymbolsAt(
  when: Date,
  strike = 85500
): { call: string; put: string; expiry: Date } {
  const expiry = new Date(
    Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate(), 8, 0, 0, 0)
  );
  const tag = `${expiry.getUTCDate()}${MONTH_ABBREVS[expiry.getUTCMonth()]}${String(
    expiry.getUTCFullYear()
  ).slice(2)}`;
  return {
    call: `BTC-${tag}-${strike}-C-USDT`,
    put: `BTC-${tag}-${strike}-P-USDT`,
    expiry,
  };
}

/** Days from now, keeping the time-of-day irrelevant (expiry is always 08:00 UTC). */
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 3600 * 1000);
}

describe('Risk Manager Unit Tests', () => {
  describe('resolveEntryPrice', () => {
    it('resolves price from rawResponse.avg_price when present and positive', async () => {
      const outcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-C-USDT',
        side: 'sell',
        success: true,
        orderId: 'ord-123',
        rawResponse: { avg_price: 320.5 },
      };
      const mockClient = {} as CoinDCXClient;

      const result = await resolveEntryPrice(outcome, mockClient, outcome.symbol);
      assert.notEqual(result, null);
      assert.equal(result?.price, 320.5);
      assert.equal(result?.source, 'fill');
    });

    it('resolves price from rawResponse.price when number and positive', async () => {
      const outcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-P-USDT',
        side: 'sell',
        success: true,
        orderId: 'ord-124',
        rawResponse: { price: 280 },
      };
      const mockClient = {} as CoinDCXClient;

      const result = await resolveEntryPrice(outcome, mockClient, outcome.symbol);
      assert.notEqual(result, null);
      assert.equal(result?.price, 280);
      assert.equal(result?.source, 'fill');
    });

    it('resolves price from rawResponse.price when string numeric', async () => {
      const outcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-P-USDT',
        side: 'sell',
        success: true,
        orderId: 'ord-125',
        rawResponse: { price: '250.75' },
      };
      const mockClient = {} as CoinDCXClient;

      const result = await resolveEntryPrice(outcome, mockClient, outcome.symbol);
      assert.notEqual(result, null);
      assert.equal(result?.price, 250.75);
      assert.equal(result?.source, 'fill');
    });

    it('falls back to contract mark price when rawResponse lacks price', async () => {
      const outcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-C-USDT',
        side: 'sell',
        success: true,
        orderId: 'ord-126',
        rawResponse: {},
      };
      const mockClient = {
        getContractPrice: async (_symbol: string) => 310.25,
      } as unknown as CoinDCXClient;

      const result = await resolveEntryPrice(outcome, mockClient, outcome.symbol);
      assert.notEqual(result, null);
      assert.equal(result?.price, 310.25);
      assert.equal(result?.source, 'mark');
    });

    it('falls back to outcome.limitPrice when rawResponse lacks execution price', async () => {
      const outcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-C-USDT',
        side: 'sell',
        success: true,
        orderId: 'ord-limit-1',
        limitPrice: 416.0,
        rawResponse: {},
      };
      const mockClient = {
        getContractPrice: async () => 390.0, // should not be used because limitPrice takes priority
      } as unknown as CoinDCXClient;

      const result = await resolveEntryPrice(outcome, mockClient, outcome.symbol);
      assert.notEqual(result, null);
      assert.equal(result?.price, 416.0);
      assert.equal(result?.source, 'fill');
    });

    it('returns null and NEVER falls back to 100 when neither raw, limit, nor mark price is available', async () => {
      const outcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-C-USDT',
        side: 'sell',
        success: false,
        rawResponse: {},
      };
      const mockClient = {
        getContractPrice: async (_symbol: string) => 0, // invalid / 0
      } as unknown as CoinDCXClient;

      const result = await resolveEntryPrice(outcome, mockClient, outcome.symbol);
      assert.equal(result, null);
    });
  });

  describe('initializeStraddleState', () => {
    it('throws MissingFillPriceError when call or put entry price cannot be resolved', async () => {
      const callOutcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-C-USDT',
        side: 'sell',
        success: true,
        rawResponse: {},
      };
      const putOutcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-P-USDT',
        side: 'sell',
        success: true,
        rawResponse: {},
      };
      const mockClient = {
        getContractPrice: async () => 0,
      } as unknown as CoinDCXClient;

      await assert.rejects(
        async () => {
          await initializeStraddleState(callOutcome, putOutcome, mockClient, mockConfig);
        },
        (err: unknown) => {
          assert.equal(err instanceof MissingFillPriceError, true);
          return true;
        }
      );
    });

    it('correctly sets up initial state with 100% SL and 55% profit target', async () => {
      const callOutcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-C-USDT',
        side: 'sell',
        success: true,
        orderId: 'call-1',
        rawResponse: { avg_price: 300 },
      };
      const putOutcome: OrderPlacementOutcome = {
        symbol: 'BTC-3OCT26-85000-P-USDT',
        side: 'sell',
        success: true,
        orderId: 'put-1',
        rawResponse: { avg_price: 200 },
      };
      const mockClient = {} as CoinDCXClient;

      const state: StraddlePositionState = await initializeStraddleState(
        callOutcome,
        putOutcome,
        mockClient,
        mockConfig,
        undefined,
        undefined,
        '2026-10-03'
      );

      assert.equal(state.date, '2026-10-03');
      assert.equal(state.entryExecuted, true);
      assert.equal(state.totalCreditReceived, 500); // 300 + 200
      assert.equal(state.targetProfitPoints, 275); // 500 * 0.55

      // Call leg assertions
      assert.equal(state.callLeg.entryPrice, 300);
      assert.equal(state.callLeg.stopLossPrice, 600); // 300 * 2.0 (100% SL)
      assert.equal(state.callLeg.confirmedOpen, true);
      assert.equal(state.callLeg.status, 'open');

      // Put leg assertions
      assert.equal(state.putLeg.entryPrice, 200);
      assert.equal(state.putLeg.stopLossPrice, 400); // 200 * 2.0 (100% SL)
      assert.equal(state.putLeg.confirmedOpen, true);
      assert.equal(state.putLeg.status, 'open');
    });
  });

  describe('calculateLegPnL', () => {
    it('calculates open leg PnL as entry - currentPrice', () => {
      const leg: ActiveLeg = {
        legType: 'CALL',
        symbol: 'BTC-3OCT26-85000-C-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 210, // decayed in profit
      };

      const pnl = calculateLegPnL(leg);
      assert.equal(pnl, 90); // 300 - 210
    });

    it('calculates closed leg PnL using exitPrice', () => {
      const leg: ActiveLeg = {
        legType: 'CALL',
        symbol: 'BTC-3OCT26-85000-C-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 650,
        exitPrice: 600,
        closeReason: 'SL_HIT',
      };

      const pnl = calculateLegPnL(leg);
      assert.equal(pnl, -300); // 300 - 600
    });
  });

  describe('closeLeg defense-in-depth guard', () => {
    it('refuses to place a close order if confirmedOpen is false', async () => {
      let closeCalled = false;
      const mockClient = {
        closePosition: async () => {
          closeCalled = true;
          return { success: true, orderId: 'test-close' };
        },
      } as unknown as CoinDCXClient;

      const unconfirmedLeg: ActiveLeg = {
        legType: 'CALL',
        symbol: 'BTC-3OCT26-85000-C-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: false, // NOT confirmed open!
        status: 'open',
        currentPrice: 600,
      };

      await closeLeg(mockClient, unconfirmedLeg, 600, 'SL_HIT', mockConfig);
      assert.equal(closeCalled, false, 'closePosition should not have been called');
      assert.equal(unconfirmedLeg.status, 'open', 'status should remain open');
    });

    it('places buy-to-close order and records exitOrderId when confirmedOpen is true', async () => {
      let closeCalled = false;
      const mockClient = {
        closePosition: async () => {
          closeCalled = true;
          return { success: true, orderId: 'close-ord-789' };
        },
      } as unknown as CoinDCXClient;

      let notifiedClosed = false;
      const mockNotifier: Notifier = {
        isEnabled: true,
        notifyStraddleEntered: async () => {},
        notifyLegClosed: async () => {
          notifiedClosed = true;
        },
        notifyScenarioResolved: async () => {},
        notifyEntryAborted: async () => {},
        notifyError: async () => {},
        notifyReconciliation: async () => {},
      };

      const validLeg: ActiveLeg = {
        legType: 'PUT',
        symbol: 'BTC-3OCT26-85000-P-USDT',
        entryPrice: 250,
        entryPriceSource: 'fill',
        stopLossPrice: 500,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 505,
      };

      await closeLeg(mockClient, validLeg, 505, 'SL_HIT', mockConfig, mockNotifier);
      assert.equal(closeCalled, true);
      assert.equal(validLeg.status, 'closed');
      assert.equal(validLeg.exitPrice, 505);
      assert.equal(validLeg.exitOrderId, 'close-ord-789');
      assert.equal(notifiedClosed, true);
    });
  });

  describe('monitorStraddleRisk loud feed failure check', () => {
    // A future expiry: this test is about the PRICE-POLL path, not the expiry path.
    const future = contractSymbolsAt(daysFromNow(90));

    it('notifies and logs loud error when price feed returns 0 (unavailable mark)', async () => {
      let notifiedErrorContext = '';
      const mockNotifier: Notifier = {
        isEnabled: true,
        notifyStraddleEntered: async () => {},
        notifyLegClosed: async () => {},
        notifyScenarioResolved: async () => {},
        notifyEntryAborted: async () => {},
        notifyError: async (context: string) => {
          notifiedErrorContext = context;
        },
        notifyReconciliation: async () => {},
      };

      const failingClient = {
        getContractPrice: async () => 0, // returns 0 when feed cannot be read
        closePosition: async () => ({ success: true, orderId: 'test-close' }),
      } as unknown as CoinDCXClient;

      const state: StraddlePositionState = {
        date: '2026-10-04',
        entryExecuted: true,
        callLeg: {
          legType: 'CALL',
          symbol: future.call,
          entryPrice: 320,
          entryPriceSource: 'fill',
          stopLossPrice: 640,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 320,
        },
        putLeg: {
          legType: 'PUT',
          symbol: future.put,
          entryPrice: 365,
          entryPriceSource: 'fill',
          stopLossPrice: 730,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 365,
        },
        totalCreditReceived: 685,
        targetProfitPoints: 376.75,
        combinedPnLPoints: 0,
        updatedAt: new Date().toISOString(),
      };

      // Set pollIntervalMs=20 and maxMonitorMinutes ~100ms so at least one poll tick runs
      const fastConfig = {
        ...mockConfig,
        riskConfig: {
          ...mockConfig.riskConfig,
          pollIntervalMs: 20,
          maxMonitorMinutes: 0.002, // 120ms
        },
      };

      const { monitorStraddleRisk } = await import('./riskManager');
      await monitorStraddleRisk(failingClient, state, fastConfig, mockNotifier);

      assert.match(notifiedErrorContext, /monitorStraddleRisk:CALL_price_feed|monitorStraddleRisk:PUT_price_feed/);
    });
  });

  describe('monitorStraddleRisk expiry reconciliation', () => {
    const expiredLegs = (date: string): StraddlePositionState => {
      const expired = contractSymbolsAt(daysFromNow(-2));
      return {
        date,
        entryExecuted: true,
        callLeg: {
          legType: 'CALL',
          symbol: expired.call,
          entryPrice: 320,
          entryPriceSource: 'fill',
          stopLossPrice: 640,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 320,
        },
        putLeg: {
          legType: 'PUT',
          symbol: expired.put,
          entryPrice: 365,
          entryPriceSource: 'fill',
          stopLossPrice: 730,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 365,
        },
        totalCreditReceived: 685,
        targetProfitPoints: 376.75,
        combinedPnLPoints: 0,
        updatedAt: new Date().toISOString(),
      };
    };

    it('resolves the cycle without polling a price once an expired leg is confirmed absent', async () => {
      // The 2026-10-05 shape: expiry (08:00 UTC) has passed, the venue delisted the
      // contract, and the price feed can no longer answer for it. Polling it anyway
      // produced a feed alert every 2 seconds for hours — the monitor must reconcile
      // against the exchange instead, then stop.
      let priceLookups = 0;
      const flatClient = {
        getContractPrice: async () => {
          priceLookups += 1;
          return 0;
        },
        getOptionsPositions: async () => [],
        closePosition: async () => ({ success: true, orderId: 'test-close' }),
      } as unknown as CoinDCXClient;

      const state = expiredLegs('2099-03-03');
      const fastConfig = {
        ...mockConfig,
        riskConfig: { ...mockConfig.riskConfig, pollIntervalMs: 20, maxMonitorMinutes: 60 },
      };

      const { monitorStraddleRisk } = await import('./riskManager');
      const scenario = await monitorStraddleRisk(flatClient, state, fastConfig);

      assert.equal(scenario, 'MAX_TIME_REACHED');
      assert.equal(state.callLeg.status, 'closed');
      assert.equal(state.putLeg.status, 'closed');
      assert.equal(state.callLeg.closeReason, 'EXPIRED');
      assert.equal(state.putLeg.closeReason, 'EXPIRED');
      assert.equal(priceLookups, 0, 'an expired, delisted contract must not be polled for a price');
    });

    it('never treats an unreadable positions feed as a closed leg', async () => {
      // Tri-state discipline: "I could not read it" must not collapse into "it is closed".
      let priceLookups = 0;
      let closeAttempts = 0;
      const unreadableClient = {
        getContractPrice: async () => {
          priceLookups += 1;
          return 0;
        },
        getOptionsPositions: async () => {
          throw new Error('positions feed down');
        },
        closePosition: async () => {
          closeAttempts += 1;
          return { success: true, orderId: 'test-close' };
        },
      } as unknown as CoinDCXClient;

      const state = expiredLegs('2099-03-04');
      const fastConfig = {
        ...mockConfig,
        riskConfig: {
          ...mockConfig.riskConfig,
          pollIntervalMs: 20,
          maxMonitorMinutes: 0.002, // ~120ms so the end-of-life window still fires
        },
      };

      const { monitorStraddleRisk } = await import('./riskManager');
      await monitorStraddleRisk(unreadableClient, state, fastConfig);

      assert.equal(priceLookups, 0, 'no point polling a price the venue cannot give');
      assert.ok(closeAttempts > 0, 'the leg must go through a real exit attempt, not a silent close');
    });
  });

  describe('monitorStraddleRisk venue-only SL and position reconciliation', () => {
    it('does NOT send a bot close order when mark >= stopLossPrice while leg is still open on venue', async () => {
      let slCloseCalled = false;
      const future = contractSymbolsAt(daysFromNow(90));
      const client = {
        getContractPrice: async () => 650, // >= SL (640)
        getOptionsPositions: async () => [
          { symbol: future.call, qty: 0.01, side: 'sell' },
          { symbol: future.put, qty: 0.01, side: 'sell' },
        ],
        getOpenOptionsOrders: async () => [
          {
            symbol: future.call,
            orderType: 'Stop',
            triggerPrice: 640,
            qty: 0.01,
            reduceOnly: true,
            status: 'Untriggered',
          },
          {
            symbol: future.put,
            orderType: 'Stop',
            triggerPrice: 730,
            qty: 0.01,
            reduceOnly: true,
            status: 'Untriggered',
          },
        ],
        closePosition: async () => {
          slCloseCalled = true;
          return { success: true };
        },
      } as unknown as CoinDCXClient;

      const state: StraddlePositionState = {
        date: '2026-10-05',
        entryExecuted: true,
        callLeg: {
          legType: 'CALL',
          symbol: future.call,
          entryPrice: 320,
          entryPriceSource: 'fill',
          stopLossPrice: 640,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 320,
        },
        putLeg: {
          legType: 'PUT',
          symbol: future.put,
          entryPrice: 365,
          entryPriceSource: 'fill',
          stopLossPrice: 730,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 365,
        },
        totalCreditReceived: 685,
        targetProfitPoints: 376.75,
        combinedPnLPoints: 0,
        updatedAt: new Date().toISOString(),
      };

      // Set maxMonitorMinutes to 10 so window does not elapse immediately,
      // but simulate venue closing the CALL leg on poll 2 to allow monitor to resolve.
      let pollCount = 0;
      const venuePositions = [
        { symbol: future.call, qty: 0.01, side: 'sell' },
        { symbol: future.put, qty: 0.01, side: 'sell' },
      ];
      (client as unknown as { getOptionsPositions: () => Promise<unknown> }).getOptionsPositions = async () => {
        pollCount++;
        if (pollCount >= 2) {
          // After observing mark >= SL without triggering bot close, close both legs on venue to resolve monitor
          return [];
        }
        return venuePositions;
      };

      const fastConfig = {
        ...mockConfig,
        riskConfig: {
          ...mockConfig.riskConfig,
          pollIntervalMs: 20,
          maxMonitorMinutes: 10,
          slOverrunTolerance: 0.10, // 10% overrun -> 640 * 1.10 = 704
        },
      };

      const { monitorStraddleRisk } = await import('./riskManager');
      await monitorStraddleRisk(client, state, fastConfig);

      // Within overrun tolerance (< 704), bot must NOT send close order (venue executes it)
      assert.equal(slCloseCalled, false, 'bot must not send its own close order on SL breach when within overrun tolerance');
    });

    it('adopts leg as closed from venue with venue fill price when position disappears from venue', async () => {
      const future = contractSymbolsAt(daysFromNow(90));
      const client = {
        getContractPrice: async () => 600,
        getOptionsPositions: async () => [
          // CALL disappeared! Only PUT is present on venue
          { symbol: future.put, qty: 0.01, side: 'sell' },
        ],
        getOpenOptionsOrders: async () => [],
        getOptionsWalletTransactions: async () => [
          {
            symbol: future.call,
            transactionType: 'TRADE',
            filledPrice: '677.28',
            orderId: 'x-venue-stop-call',
          },
        ],
        closePosition: async () => ({ success: true }),
      } as unknown as CoinDCXClient;

      const state: StraddlePositionState = {
        date: '2026-10-05',
        entryExecuted: true,
        callLeg: {
          legType: 'CALL',
          symbol: future.call,
          entryPrice: 320,
          entryPriceSource: 'fill',
          stopLossPrice: 640,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 320,
        },
        putLeg: {
          legType: 'PUT',
          symbol: future.put,
          entryPrice: 365,
          entryPriceSource: 'fill',
          stopLossPrice: 730,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 365,
        },
        totalCreditReceived: 685,
        targetProfitPoints: 376.75,
        combinedPnLPoints: 0,
        updatedAt: new Date().toISOString(),
      };

      const fastConfig = {
        ...mockConfig,
        riskConfig: {
          ...mockConfig.riskConfig,
          pollIntervalMs: 20,
          maxMonitorMinutes: 0.002,
        },
      };

      const { monitorStraddleRisk } = await import('./riskManager');
      await monitorStraddleRisk(client, state, fastConfig);

      assert.equal(state.callLeg.status, 'closed');
      assert.equal(state.callLeg.closeReason, 'SL_HIT');
      assert.equal(state.callLeg.exitPrice, 677.28, 'must adopt venue filledPrice from ledger');
      assert.equal(state.callLeg.exitOrderId, 'x-venue-stop-call');
    });

    it('escalates to SL_FALLBACK_CLOSE when price exceeds overrun tolerance and position is stuck open', async () => {
      let fallbackCloseCalled = false;
      const future = contractSymbolsAt(daysFromNow(90));
      const client = {
        getContractPrice: async () => 720, // SL is 640, overrun threshold is 640 * 1.10 = 704 -> 720 > 704!
        getOptionsPositions: async () => [
          { symbol: future.call, qty: 0.01, side: 'sell' },
          { symbol: future.put, qty: 0.01, side: 'sell' },
        ],
        getOpenOptionsOrders: async () => [
          {
            symbol: future.call,
            orderType: 'Stop',
            triggerPrice: 640,
            qty: 0.01,
            reduceOnly: true,
            status: 'Untriggered',
          },
        ],
        closePosition: async () => {
          fallbackCloseCalled = true;
          return { success: true, orderId: 'fallback-ord-1' };
        },
      } as unknown as CoinDCXClient;

      const state: StraddlePositionState = {
        date: '2026-10-05',
        entryExecuted: true,
        callLeg: {
          legType: 'CALL',
          symbol: future.call,
          entryPrice: 320,
          entryPriceSource: 'fill',
          stopLossPrice: 640,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 320,
        },
        putLeg: {
          legType: 'PUT',
          symbol: future.put,
          entryPrice: 365,
          entryPriceSource: 'fill',
          stopLossPrice: 730,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 365,
        },
        totalCreditReceived: 685,
        targetProfitPoints: 376.75,
        combinedPnLPoints: 0,
        updatedAt: new Date().toISOString(),
      };

      const fastConfig = {
        ...mockConfig,
        riskConfig: {
          ...mockConfig.riskConfig,
          pollIntervalMs: 20,
          maxMonitorMinutes: 0.002,
          slOverrunTolerance: 0.10,
        },
      };

      const { monitorStraddleRisk } = await import('./riskManager');
      await monitorStraddleRisk(client, state, fastConfig);

      assert.equal(fallbackCloseCalled, true, 'must execute fallback close on overrun tolerance breach');
      assert.equal(state.callLeg.closeReason, 'SL_FALLBACK_CLOSE');
    });

    it('detects unexpected long position on venue and flattens with reduceOnly', async () => {
      let flattenOrderCalled = false;
      let flattenReduceOnly = false;
      const future = contractSymbolsAt(daysFromNow(90));

      const client = {
        getContractPrice: async () => 320,
        getOptionsPositions: async () => [
          { symbol: future.call, qty: 0.01, side: 'buy' }, // Unexpected long position!
          { symbol: future.put, qty: 0.01, side: 'sell' },
        ],
        getOpenOptionsOrders: async () => [],
        placeOptionsOrder: async (
          _sym: string,
          _side: string,
          _qty: number,
          _type: string,
          _price?: number | string,
          _sl?: string,
          _tp?: string,
          _cr?: string,
          reduceOnly?: boolean
        ) => {
          flattenOrderCalled = true;
          flattenReduceOnly = Boolean(reduceOnly);
          return { symbol: future.call, side: 'sell' as const, success: true, rawResponse: {} };
        },
        closePosition: async () => ({ success: true }),
      } as unknown as CoinDCXClient;

      const state: StraddlePositionState = {
        date: '2026-10-05',
        entryExecuted: true,
        callLeg: {
          legType: 'CALL',
          symbol: future.call,
          entryPrice: 320,
          entryPriceSource: 'fill',
          stopLossPrice: 640,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 320,
        },
        putLeg: {
          legType: 'PUT',
          symbol: future.put,
          entryPrice: 365,
          entryPriceSource: 'fill',
          stopLossPrice: 730,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 365,
        },
        totalCreditReceived: 685,
        targetProfitPoints: 376.75,
        combinedPnLPoints: 0,
        updatedAt: new Date().toISOString(),
      };

      const fastConfig = {
        ...mockConfig,
        riskConfig: {
          ...mockConfig.riskConfig,
          pollIntervalMs: 20,
          maxMonitorMinutes: 0.002,
        },
      };

      const { monitorStraddleRisk } = await import('./riskManager');
      await monitorStraddleRisk(client, state, fastConfig);

      assert.equal(flattenOrderCalled, true, 'must attempt to flatten unexpected long position');
      assert.equal(flattenReduceOnly, true, 'flatten order must carry reduceOnly: true');
    });

    it('Criterion 5: Both legs stopped out (BOTH_LEGS_SL) -> no cost stop move attempted, resolves scenario', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'both-sl-test-'));

      const prevMode = process.env.BTC_TEST_MODE;
      const prevStateDir = process.env.BTC_STATE_DIR;
      const prevRecDir = process.env.RECORD_DIR;
      const prevAlertsDir = process.env.BTC_ALERTS_DIR;

      process.env.BTC_TEST_MODE = '1';
      process.env.BTC_STATE_DIR = path.join(tmpBase, 'state');
      process.env.RECORD_DIR = path.join(tmpBase, 'records');
      process.env.BTC_ALERTS_DIR = path.join(tmpBase, 'logs');
      fs.mkdirSync(process.env.BTC_STATE_DIR, { recursive: true });
      fs.mkdirSync(process.env.RECORD_DIR, { recursive: true });
      fs.mkdirSync(process.env.BTC_ALERTS_DIR, { recursive: true });

      try {
        const future = contractSymbolsAt(daysFromNow(90));
        let moveAttempted = false;

        const client = {
          getContractPrice: async () => 700,
          getOptionsPositions: async () => [], // Both absent from venue -> both executed SL
          getOpenOptionsOrders: async () => [],
          getOptionsWalletTransactions: async () => [],
          placeOptionsOrder: async () => {
            moveAttempted = true;
            return { success: true, rawResponse: {} };
          },
          closePosition: async () => ({ success: true }),
        } as unknown as CoinDCXClient;

        const state: StraddlePositionState = {
          date: '2026-10-05',
          entryExecuted: true,
          callLeg: {
            legType: 'CALL',
            symbol: future.call,
            entryPrice: 320,
            entryPriceSource: 'fill',
            stopLossPrice: 640,
            quantity: 0.01,
            confirmedOpen: true,
            status: 'closed',
            currentPrice: 640,
            exitPrice: 640,
            closeReason: 'SL_HIT',
          },
          putLeg: {
            legType: 'PUT',
            symbol: future.put,
            entryPrice: 365,
            entryPriceSource: 'fill',
            stopLossPrice: 730,
            quantity: 0.01,
            confirmedOpen: true,
            status: 'closed',
            currentPrice: 730,
            exitPrice: 730,
            closeReason: 'SL_HIT',
          },
          totalCreditReceived: 685,
          targetProfitPoints: 376.75,
          combinedPnLPoints: 0,
          updatedAt: new Date().toISOString(),
        };

        const fastConfig = {
          ...mockConfig,
          riskConfig: {
            ...mockConfig.riskConfig,
            pollIntervalMs: 20,
            maxMonitorMinutes: 0.002,
          },
        };

        const { monitorStraddleRisk } = await import('./riskManager');
        const scenario = await monitorStraddleRisk(client, state, fastConfig);

        assert.equal(scenario, 'BOTH_LEGS_SL', 'resolves BOTH_LEGS_SL when both legs hit SL');
        assert.equal(moveAttempted, false, 'no cost stop move attempted when both legs are closed');
      } finally {
        process.env.BTC_TEST_MODE = prevMode;
        process.env.BTC_STATE_DIR = prevStateDir;
        process.env.RECORD_DIR = prevRecDir;
        process.env.BTC_ALERTS_DIR = prevAlertsDir;
        try {
          fs.rmSync(tmpBase, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The rule that started all of this: the venue owns the stop-loss, so a breached
// stop must never trigger a close order from the bot (2026-10-05: the bot's own
// SL close fired one second after the venue stop and flipped the leg long).
// ---------------------------------------------------------------------------
describe('monitorStraddleRisk venue-only stop-loss', () => {
  const future = contractSymbolsAt(daysFromNow(90));

  const breachedState = (callMark: number): StraddlePositionState => ({
    date: '2026-10-04',
    entryExecuted: true,
    callLeg: {
      legType: 'CALL',
      symbol: future.call,
      entryPrice: 320,
      entryPriceSource: 'fill',
      stopLossPrice: 640,
      quantity: 0.01,
      confirmedOpen: true,
      status: 'open',
      currentPrice: callMark,
    },
    putLeg: {
      legType: 'PUT',
      symbol: future.put,
      entryPrice: 365,
      entryPriceSource: 'fill',
      stopLossPrice: 730,
      quantity: 0.01,
      confirmedOpen: true,
      status: 'open',
      currentPrice: 300,
    },
    totalCreditReceived: 685,
    targetProfitPoints: 376.75,
    combinedPnLPoints: 0,
    updatedAt: new Date().toISOString(),
  });

  const venueClient = (closeCalls: string[]) =>
    ({
      getContractPrice: async (symbol: string) => (symbol === future.call ? 650 : 300),
      getOpenOptionsOrders: async () => [
        { symbol: future.call, orderId: 'x-stop-call', triggerPrice: '640', orderStatus: 'Untriggered', reduceOnly: true },
        { symbol: future.put, orderId: 'x-stop-put', triggerPrice: '730', orderStatus: 'Untriggered', reduceOnly: true },
      ],
      getOptionsPositions: async () => [
        { symbol: future.call, side: 'Sell', qty: 0.01, avgPrice: 320, markPrice: 650 },
        { symbol: future.put, side: 'Sell', qty: 0.01, avgPrice: 365, markPrice: 300 },
      ],
      getOptionsWalletTransactions: async () => [],
      getInstrumentDetails: async () => ({ priceFilter: { tickSize: '5' }, quantityFilter: { stepSize: '0.01' } }),
      closePosition: async () => {
        closeCalls.push('close');
        return { success: true, orderId: 'test-close' } as OrderPlacementOutcome;
      },
      placeOptionsOrder: async () => {
        closeCalls.push('place');
        return { success: true, orderId: 'test-place' } as OrderPlacementOutcome;
      },
    }) as unknown as CoinDCXClient;

  it('does NOT place an SL close while the venue stop is armed and not overrun', async () => {
    const closeCalls: string[] = [];
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(' '));
    };

    const config = {
      ...mockConfig,
      riskConfig: { ...mockConfig.riskConfig, pollIntervalMs: 20, maxMonitorMinutes: 0.002 },
    };

    const state = breachedState(650); // 650 >= SL 640, but far below the 10% overrun threshold (704)
    const { monitorStraddleRisk } = await import('./riskManager');
    try {
      await monitorStraddleRisk(venueClient(closeCalls), state, config);
    } finally {
      console.warn = realWarn;
    }

    assert.ok(
      warns.some((w) => w.includes('Waiting for venue stop order execution')),
      'the monitor must log that it is waiting for the venue stop'
    );
    assert.ok(
      !warns.some((w) => w.includes('STUCK STOP ESCALATION')),
      'a stop that is merely breached must not escalate to a fallback close'
    );
    assert.equal(
      state.callLeg.closeReason === 'SL_HIT',
      false,
      'the bot must never record an SL_HIT close of its own'
    );
  });
});

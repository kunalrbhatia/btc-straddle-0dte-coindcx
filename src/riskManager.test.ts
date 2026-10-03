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
  strikeStep: 250,
  orderQuantity: 0.01,
  leverage: 10,
  marginCurrency: 'USDT',
  dryRun: false,
  conversionRate: '102',
  riskConfig: {
    stopLossMultiplier: 2.0,
    profitTargetRatio: 0.55,
    pollIntervalMs: 2000,
    maxMonitorMinutes: 720,
  },
};

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

    it('returns null and NEVER falls back to 100 when neither raw nor mark price is available', async () => {
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
});

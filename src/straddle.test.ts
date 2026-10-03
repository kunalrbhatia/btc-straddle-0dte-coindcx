import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeShortStraddle, calculateAtmStrike, generateContractSymbols } from './straddle';
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
  strikeStep: 500,
  orderQuantity: 0.01,
  leverage: 10,
  marginCurrency: 'USDT',
  conversionRate: '102',
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

  it('aborts cleanly when both Call and Put entry orders fail', async () => {
    let callOrderPlaced = false;
    let putOrderPlaced = false;

    const mockClient = {
      getBtcSpotPrice: async () => 84520,
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
});

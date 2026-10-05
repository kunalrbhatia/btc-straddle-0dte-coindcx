import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyExitError,
  parseContractExpiryDate,
  safeCloseLeg,
  reconcileAndResurrectState,
  moveStopToCostOnSurvivingLeg,
  roundToTickSize,
  verifyStopOrderArmed,
} from './reconciliation';
import { ActiveLeg, OptionsPosition, StraddlePositionState } from './types';
import { AppConfig } from './config';
import { CoinDCXClient } from './client';
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
    pollIntervalMs: 50,
    maxMonitorMinutes: 1380,
  },
};

describe('Reconciliation & Exit Safety Unit Tests', () => {
  describe('classifyExitError', () => {
    it('classifies permanent errors correctly without retrying', () => {
      assert.equal(
        classifyExitError('Insufficient margin to close').isPermanent,
        true
      );
      assert.equal(
        classifyExitError('Contract expired already').isPermanent,
        true
      );
      assert.equal(
        classifyExitError('Invalid symbol specified').isPermanent,
        true
      );
      assert.equal(
        classifyExitError('Min lot size error: invalid quantity').isPermanent,
        true
      );
    });

    it('classifies transient/retryable errors correctly', () => {
      assert.equal(
        classifyExitError('Failed to place the order. Please retry.', { httpStatus: 400 }).isPermanent,
        false
      );
      assert.equal(
        classifyExitError('Server error', { httpStatus: 500 }).isPermanent,
        false
      );
      assert.equal(
        classifyExitError('Rate limit exceeded 429', { httpStatus: 429 }).isPermanent,
        false
      );
      assert.equal(
        classifyExitError('Network timeout').isPermanent,
        false
      );
    });
  });

  describe('parseContractExpiryDate', () => {
    it('parses standard CoinDCX option contract symbols correctly', () => {
      const d1 = parseContractExpiryDate('BTC-5OCT26-85250-P-USDT', 8);
      assert.notEqual(d1, null);
      assert.equal(d1?.getUTCFullYear(), 2026);
      assert.equal(d1?.getUTCMonth(), 9); // October is index 9
      assert.equal(d1?.getUTCDate(), 5);
      assert.equal(d1?.getUTCHours(), 8);

      const d2 = parseContractExpiryDate('BTC-16OCT26-90000-C-USDT', 8);
      assert.notEqual(d2, null);
      assert.equal(d2?.getUTCDate(), 16);
      assert.equal(d2?.getUTCMonth(), 9);
    });

    it('returns null for unparseable symbols', () => {
      assert.equal(parseContractExpiryDate('BTCUSDT', 8), null);
      assert.equal(parseContractExpiryDate('INVALID-SYM', 8), null);
    });
  });

  describe('safeCloseLeg exit safety guard', () => {
    it('NEVER marks leg closed when exchange returns 400 rejection and position is still open', async () => {
      let closeAttempts = 0;
      let alertedError = '';

      const mockClient = {
        closePosition: async () => {
          closeAttempts++;
          return {
            success: false,
            message: 'Failed to place the order. Please retry.',
            rawResponse: { httpStatus: 400, code: 400 },
          };
        },
        getOptionsPositions: async () => [
          {
            symbol: 'BTC-5OCT26-85250-P-USDT',
            qty: 0.01,
            entryPrice: 300,
          } as OptionsPosition,
        ],
      } as unknown as CoinDCXClient;

      const mockNotifier: Notifier = {
        isEnabled: true,
        notifyStraddleEntered: async () => {},
        notifyLegClosed: async () => {},
        notifyScenarioResolved: async () => {},
        notifyEntryAborted: async () => {},
        notifyError: async (context: string, err: any) => {
          alertedError = `${context}: ${err}`;
        },
        notifyReconciliation: async () => {},
      };

      const leg: ActiveLeg = {
        legType: 'PUT',
        symbol: 'BTC-5OCT26-85250-P-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 310,
      };

      // Set maxAttempts to 2 to run fast in unit test
      const result = await safeCloseLeg(mockClient, leg, 310, 'SL_HIT', mockConfig, mockNotifier, 2);

      assert.equal(result.success, false, 'safeCloseLeg should report failure');
      assert.equal(leg.status, 'open', 'CRITICAL: leg status MUST remain OPEN when close fails!');
      assert.equal(leg.exitPrice, undefined, 'exitPrice must not be recorded');
      assert.equal(closeAttempts, 2, 'should have attempted retries up to maxAttempts');
      assert.match(alertedError, /Exit Failure/i);
    });

    it('aborts immediately without retrying on permanent rejection', async () => {
      let closeAttempts = 0;
      const mockClient = {
        closePosition: async () => {
          closeAttempts++;
          return {
            success: false,
            message: 'Contract does not exist',
            rawResponse: { httpStatus: 400 },
          };
        },
        getOptionsPositions: async () => [
          {
            symbol: 'BTC-5OCT26-85250-C-USDT',
            qty: 0.01,
          } as OptionsPosition,
        ],
      } as unknown as CoinDCXClient;

      const leg: ActiveLeg = {
        legType: 'CALL',
        symbol: 'BTC-5OCT26-85250-C-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 310,
      };

      const result = await safeCloseLeg(mockClient, leg, 310, 'PROFIT_TARGET_HIT', mockConfig, undefined, 3);
      assert.equal(result.success, false);
      assert.equal(result.isPermanent, true);
      assert.equal(closeAttempts, 1, 'Permanent error must NOT be retried');
    });

    it('marks leg closed when closePosition succeeds', async () => {
      const mockClient = {
        closePosition: async () => ({
          success: true,
          orderId: 'close-ord-success',
        }),
        getOptionsPositions: async () => [],
      } as unknown as CoinDCXClient;

      const leg: ActiveLeg = {
        legType: 'CALL',
        symbol: 'BTC-5OCT26-85250-C-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 150,
      };

      const result = await safeCloseLeg(mockClient, leg, 150, 'PROFIT_TARGET_HIT', mockConfig);
      assert.equal(result.success, true);
      assert.equal(leg.status, 'closed');
      assert.equal(leg.exitPrice, 150);
      assert.equal(leg.exitOrderId, 'close-ord-success');
    });

    it('treats isAlreadyFlat rejection as ALREADY_FLAT clean close', async () => {
      const mockClient = {
        closePosition: async () => ({
          symbol: 'BTC-5OCT26-85250-C-USDT',
          side: 'buy' as const,
          success: false,
          isAlreadyFlat: true,
          message: 'Failed to submit the reduce-only order! You do not have any open positions.',
          rawResponse: {},
        }),
        getOptionsPositions: async () => [],
      } as unknown as CoinDCXClient;

      const leg: ActiveLeg = {
        legType: 'CALL',
        symbol: 'BTC-5OCT26-85250-C-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 600,
      };

      const result = await safeCloseLeg(mockClient, leg, 600, 'SL_HIT', mockConfig);
      assert.equal(result.success, true);
      assert.equal(result.message, 'ALREADY_FLAT');
      assert.equal(leg.status, 'closed');
      assert.equal(leg.exitPrice, 600);
      assert.equal(leg.closeReason, 'SL_HIT');
    });
  });

  describe('verifyStopOrderArmed', () => {
    it('verifies stop order is armed when symbol, triggerPrice, and qty match', async () => {
      const { verifyStopOrderArmed } = await import('./reconciliation');
      const leg: ActiveLeg = {
        legType: 'CALL',
        symbol: 'BTC-6OCT26-85750-C-USDT',
        entryPrice: 535,
        entryPriceSource: 'fill',
        stopLossPrice: 1070,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 535,
      };

      const orders = [
        {
          id: 'x-c2422d57-1111',
          symbol: 'BTC-6OCT26-85750-C-USDT',
          orderType: 'Stop',
          triggerPrice: 1070,
          qty: 0.01,
          reduceOnly: true,
          status: 'Untriggered',
        },
      ];

      const res = verifyStopOrderArmed(orders, leg);
      assert.equal(res.armed, true);
    });

    it('reports MISSING when no stop order exists for symbol', async () => {
      const { verifyStopOrderArmed } = await import('./reconciliation');
      const leg: ActiveLeg = {
        legType: 'PUT',
        symbol: 'BTC-6OCT26-85750-P-USDT',
        entryPrice: 400,
        entryPriceSource: 'fill',
        stopLossPrice: 800,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 400,
      };

      const orders: Record<string, unknown>[] = [];
      const res = verifyStopOrderArmed(orders, leg);
      assert.equal(res.armed, false);
      assert.equal(res.reason, 'MISSING');
    });

    it('reports TRIGGER_MISMATCH when trigger price differs from stopLossPrice', async () => {
      const { verifyStopOrderArmed } = await import('./reconciliation');
      const leg: ActiveLeg = {
        legType: 'CALL',
        symbol: 'BTC-6OCT26-85750-C-USDT',
        entryPrice: 535,
        entryPriceSource: 'fill',
        stopLossPrice: 1070,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 535,
      };

      const orders = [
        {
          id: 'x-c2422d57-1111',
          symbol: 'BTC-6OCT26-85750-C-USDT',
          orderType: 'Stop',
          triggerPrice: 800, // mismatch
          qty: 0.01,
          reduceOnly: true,
          status: 'Untriggered',
        },
      ];

      const res = verifyStopOrderArmed(orders, leg);
      assert.equal(res.armed, false);
      assert.equal(res.reason, 'TRIGGER_MISMATCH');
    });
  });

  describe('reconcileAndResurrectState', () => {
    it('resurrects an orphaned live position on exchange when state marked it closed or flat', async () => {
      const os = await import('os');
      const fs = await import('fs');
      const path = await import('path');
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-recon-test-'));
      const prevMode = process.env.BTC_TEST_MODE;
      const prevStateDir = process.env.BTC_STATE_DIR;
      const prevAlertsDir = process.env.BTC_ALERTS_DIR;

      process.env.BTC_TEST_MODE = '1';
      process.env.BTC_STATE_DIR = path.join(tmpBase, 'state');
      process.env.BTC_ALERTS_DIR = path.join(tmpBase, 'alerts');
      fs.mkdirSync(process.env.BTC_STATE_DIR, { recursive: true });
      fs.mkdirSync(process.env.BTC_ALERTS_DIR, { recursive: true });

      try {
        const livePositions: OptionsPosition[] = [
          {
            symbol: 'BTC-5OCT26-85250-P-USDT',
            qty: 0.01,
            entryPrice: 365,
          },
        ];

        const { saveStraddleState } = await import('./stateStore');
        const testState: StraddlePositionState = {
          date: '2026-10-05',
          entryExecuted: true,
          callLeg: {
            legType: 'CALL',
            symbol: 'BTC-5OCT26-85250-C-USDT',
            entryPrice: 320,
            entryPriceSource: 'fill',
            stopLossPrice: 640,
            quantity: 0.01,
            confirmedOpen: true,
            status: 'closed',
            currentPrice: 320,
            exitPrice: 320,
            closeReason: 'SL_HIT',
          },
          putLeg: {
            legType: 'PUT',
            symbol: 'BTC-5OCT26-85250-P-USDT',
            entryPrice: 365,
            entryPriceSource: 'fill',
            stopLossPrice: 730,
            quantity: 0.01,
            confirmedOpen: true,
            status: 'closed', // OOPS: marked closed in state!
            currentPrice: 365,
            exitPrice: 365,
            closeReason: 'MONITOR_WINDOW_ELAPSED',
          },
          totalCreditReceived: 685,
          targetProfitPoints: 376.75,
          combinedPnLPoints: 0,
          updatedAt: new Date().toISOString(),
        };
        await saveStraddleState(testState, '2026-10-05');

      const mockClient = {
        getOptionsPositions: async () => livePositions,
      } as unknown as CoinDCXClient;

      let reconNotified = '';
      const mockNotifier: Notifier = {
        isEnabled: true,
        notifyStraddleEntered: async () => {},
        notifyLegClosed: async () => {},
        notifyScenarioResolved: async () => {},
        notifyEntryAborted: async () => {},
        notifyError: async () => {},
        notifyReconciliation: async (msg: string) => {
          reconNotified = msg;
        },
      };

      const res = await reconcileAndResurrectState(mockClient, mockConfig, mockNotifier);
      assert.notEqual(res, null);
      assert.equal(res?.state.putLeg.symbol, 'BTC-5OCT26-85250-P-USDT');
      assert.match(reconNotified, /Adopted orphaned live position|Resurrected/i);
    } finally {
      process.env.BTC_TEST_MODE = prevMode;
      process.env.BTC_STATE_DIR = prevStateDir;
      process.env.BTC_ALERTS_DIR = prevAlertsDir;
      try {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      } catch {
        // cleanup
      }
    }
  });
});

describe('Cost Stop on Surviving Leg Unit Tests (§1 - §3)', () => {
  it('Criterion 7: roundToTickSize rounds correctly to instrument tickSize', () => {
    assert.equal(roundToTickSize(532.4, 5), 530);
    assert.equal(roundToTickSize(533, 5), 535);
    assert.equal(roundToTickSize(535, 5), 535);
    assert.equal(roundToTickSize(537.5, 5), 540);
    assert.equal(roundToTickSize(100.123, 0.5), 100);
    assert.equal(roundToTickSize(100.26, 0.5), 100.5);
  });

  it('Criterion 1 & 6: moves stop to venue cost basis + buffer with tick-rounding and reduceOnly', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-stop-test-'));

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
      let placedOrder: any = null;
      let cancelledOrderId: string | null = null;

      // Existing orders on venue: has old 2x stop @ 800
      const venueOrders: any[] = [
        {
          id: 'old-put-stop-id',
          symbol: 'BTC-5OCT26-85250-P-USDT',
          orderType: 'Stop-Market',
          triggerPrice: 800,
          qty: 0.01,
          reduceOnly: true,
          status: 'Untriggered',
        },
      ];

      const mockClient = {
        getOptionsInstruments: async () => [
          {
            symbol: 'BTC-5OCT26-85250-P-USDT',
            priceFilter: { tickSize: 5 },
          },
        ],
        getOptionsWalletTransactions: async () => [],
        getOpenOptionsOrders: async () => venueOrders,
        placeOptionsOrder: async (
          symbol: string,
          side: string,
          qty: number,
          type: string,
          _price: any,
          stopLoss: string,
          _tp: any,
          _cr: any,
          reduceOnly: boolean
        ) => {
          placedOrder = { symbol, side, qty, type, stopLoss, reduceOnly };
          // Add newly placed stop to venue orders
          const newOrder = {
            id: 'mock-cost-stop-1',
            symbol,
            orderType: 'Stop-Market',
            triggerPrice: Number(stopLoss),
            qty,
            reduceOnly,
            status: 'Untriggered',
          };
          venueOrders.push(newOrder);
          return {
            symbol,
            side: side as any,
            success: true,
            orderId: 'mock-cost-stop-1',
            rawResponse: {},
          };
        },
        cancelOptionsOrder: async (orderId: string) => {
          cancelledOrderId = orderId;
          const idx = venueOrders.findIndex((o) => o.id === orderId);
          if (idx !== -1) venueOrders.splice(idx, 1);
          return true;
        },
      } as unknown as CoinDCXClient;

      // State: PUT is surviving, venue fill is 400 (even though entry was quoted at 395)
      const state: StraddlePositionState = {
        date: '2026-10-05',
        entryExecuted: true,
        callLeg: {
          legType: 'CALL',
          symbol: 'BTC-5OCT26-85250-C-USDT',
          entryPrice: 535,
          entryPriceSource: 'fill',
          stopLossPrice: 1070,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'closed',
          currentPrice: 1080,
          exitPrice: 1080,
          closeReason: 'SL_HIT',
        },
        putLeg: {
          legType: 'PUT',
          symbol: 'BTC-5OCT26-85250-P-USDT',
          entryPrice: 395, // quote
          venueAvgPrice: 400, // actual venue fill! Criterion 6
          entryPriceSource: 'fill',
          stopLossPrice: 800,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 250, // comfortably below cost (400)
        },
        totalCreditReceived: 935,
        targetProfitPoints: 500,
        combinedPnLPoints: 0,
        updatedAt: new Date().toISOString(),
      };

      const result = await moveStopToCostOnSurvivingLeg(mockClient, state.putLeg, state, mockConfig);
      assert.equal(result.moved, true);
      assert.equal(result.newTrigger, 400, 'must move trigger to venueAvgPrice 400');
      assert.notEqual(placedOrder, null);
      assert.equal(placedOrder.reduceOnly, true, 'new stop must carry reduceOnly: true');
      assert.equal(placedOrder.stopLoss, '400');
      assert.equal(cancelledOrderId, 'old-put-stop-id', 'old stop must be cancelled after new stop verified');
      assert.equal(venueOrders.length, 1, 'exactly one stop must remain');
      assert.equal(state.putLeg.stopLossPrice, 400, 'state.putLeg.stopLossPrice must be updated to 400');

      // Check record JSONL
      const recFile = path.join(process.env.RECORD_DIR, '2026-10-05.jsonl');
      assert.equal(fs.existsSync(recFile), true);
      const lines = fs.readFileSync(recFile, 'utf8').trim().split('\n');
      const stopMovedEv = lines.map((l) => JSON.parse(l)).find((e) => e.event === 'STOP_MOVED_TO_COST');
      assert.notEqual(stopMovedEv, undefined);
      assert.equal(stopMovedEv.data.newTrigger, 400);
      assert.equal(stopMovedEv.data.costBasis, 400);
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

  it('Criterion 2: mark >= newTrigger skips move, logs COST_STOP_SKIPPED_ALREADY_THROUGH_COST, leaves old stop', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-stop-skip-'));

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
      let placeAttempted = false;
      let cancelAttempted = false;

      const mockClient = {
        getOptionsInstruments: async () => [{ symbol: 'BTC-5OCT26-85250-P-USDT', priceFilter: { tickSize: 5 } }],
        getOptionsWalletTransactions: async () => [],
        getOpenOptionsOrders: async () => [],
        placeOptionsOrder: async () => {
          placeAttempted = true;
          return { success: true };
        },
        cancelOptionsOrder: async () => {
          cancelAttempted = true;
          return true;
        },
      } as unknown as CoinDCXClient;

      // Mark is 450, while cost basis is 400 -> already crossed!
      const state: StraddlePositionState = {
        date: '2026-10-05',
        entryExecuted: true,
        callLeg: {
          legType: 'CALL',
          symbol: 'BTC-5OCT26-85250-C-USDT',
          entryPrice: 535,
          entryPriceSource: 'fill',
          stopLossPrice: 1070,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'closed',
          currentPrice: 1080,
          exitPrice: 1080,
          closeReason: 'SL_HIT',
        },
        putLeg: {
          legType: 'PUT',
          symbol: 'BTC-5OCT26-85250-P-USDT',
          entryPrice: 400,
          entryPriceSource: 'fill',
          stopLossPrice: 800,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 450, // >= newTrigger (400)
        },
        totalCreditReceived: 935,
        targetProfitPoints: 500,
        combinedPnLPoints: 0,
        updatedAt: new Date().toISOString(),
      };

      const result = await moveStopToCostOnSurvivingLeg(mockClient, state.putLeg, state, mockConfig);
      assert.equal(result.moved, false);
      assert.equal(result.skippedAlreadyThroughCost, true);
      assert.equal(placeAttempted, false, 'no order placement must be attempted');
      assert.equal(cancelAttempted, false, 'no order cancellation must be attempted');
      assert.equal(state.putLeg.stopLossPrice, 800, 'existing stopLossPrice must be retained');

      // Check ANOMALY record event
      const recFile = path.join(process.env.RECORD_DIR, '2026-10-05.jsonl');
      const lines = fs.readFileSync(recFile, 'utf8').trim().split('\n');
      const anomalyEv = lines.map((l) => JSON.parse(l)).find((e) => e.data?.type === 'COST_STOP_SKIPPED_ALREADY_THROUGH_COST');
      assert.notEqual(anomalyEv, undefined);
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

  it('Criterion 3: No unprotected window — if new stop fails, old stop remains and ANOMALY is recorded', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-stop-err-'));

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
      let cancelCalled = false;
      const venueOrders: any[] = [
        {
          id: 'old-put-stop-id',
          symbol: 'BTC-5OCT26-85250-P-USDT',
          orderType: 'Stop-Market',
          triggerPrice: 800,
          qty: 0.01,
          reduceOnly: true,
          status: 'Untriggered',
        },
      ];

      const mockClient = {
        getOptionsInstruments: async () => [{ symbol: 'BTC-5OCT26-85250-P-USDT', priceFilter: { tickSize: 5 } }],
        getOptionsWalletTransactions: async () => [],
        getOpenOptionsOrders: async () => venueOrders,
        placeOptionsOrder: async () => {
          // Placement fails!
          return {
            symbol: 'BTC-5OCT26-85250-P-USDT',
            side: 'buy' as const,
            success: false,
            message: 'Simulated venue reject',
            rawResponse: {},
          };
        },
        cancelOptionsOrder: async () => {
          cancelCalled = true;
          return true;
        },
      } as unknown as CoinDCXClient;

      const state: StraddlePositionState = {
        date: '2026-10-05',
        entryExecuted: true,
        callLeg: {
          legType: 'CALL',
          symbol: 'BTC-5OCT26-85250-C-USDT',
          entryPrice: 535,
          entryPriceSource: 'fill',
          stopLossPrice: 1070,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'closed',
          currentPrice: 1080,
          exitPrice: 1080,
          closeReason: 'SL_HIT',
        },
        putLeg: {
          legType: 'PUT',
          symbol: 'BTC-5OCT26-85250-P-USDT',
          entryPrice: 400,
          entryPriceSource: 'fill',
          stopLossPrice: 800,
          quantity: 0.01,
          confirmedOpen: true,
          status: 'open',
          currentPrice: 200,
        },
        totalCreditReceived: 935,
        targetProfitPoints: 500,
        combinedPnLPoints: 0,
        updatedAt: new Date().toISOString(),
      };

      const result = await moveStopToCostOnSurvivingLeg(mockClient, state.putLeg, state, mockConfig);
      assert.equal(result.moved, false);
      assert.equal(cancelCalled, false, 'must NOT cancel old stop when new placement fails');
      assert.equal(venueOrders.length, 1, 'old stop must remain untouched');
      assert.equal(state.putLeg.stopLossPrice, 800, 'state stopLossPrice must not be changed');

      // Check ANOMALY record event
      const recFile = path.join(process.env.RECORD_DIR, '2026-10-05.jsonl');
      const lines = fs.readFileSync(recFile, 'utf8').trim().split('\n');
      const errEv = lines.map((l) => JSON.parse(l)).find((e) => e.data?.type === 'COST_STOP_MOVE_FAILED');
      assert.notEqual(errEv, undefined);
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

  it('Criterion 4: Restart safety — after move, restart accepts cost stop and does NOT re-arm 2x stop', async () => {
    // Surviving leg state has been updated to stopLossPrice = 400
    const survivingLeg: ActiveLeg = {
      legType: 'PUT',
      symbol: 'BTC-5OCT26-85250-P-USDT',
      entryPrice: 400,
      entryPriceSource: 'fill',
      stopLossPrice: 400, // Updated in state!
      quantity: 0.01,
      confirmedOpen: true,
      status: 'open',
      currentPrice: 220,
    };

    // Venue has the cost stop armed at 400
    const venueOrders = [
      {
        id: 'venue-cost-stop-id',
        symbol: 'BTC-5OCT26-85250-P-USDT',
        orderType: 'Stop-Market',
        triggerPrice: 400,
        qty: 0.01,
        reduceOnly: true,
        status: 'Untriggered',
      },
    ];

    const check = verifyStopOrderArmed(venueOrders, survivingLeg);
    assert.equal(check.armed, true, 'verifyStopOrderArmed must report armed: true');
    assert.equal(check.reason, undefined);
  });
});
});


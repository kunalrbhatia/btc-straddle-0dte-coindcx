import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  getTodayDateStringIST,
  getStateFilePath,
  saveStraddleState,
  loadStraddleState,
  hasTodayExecuted,
  hasUnresolvedOpenLeg,
} from './stateStore';
import { StraddlePositionState } from './types';

describe('StateStore Tests', () => {
  const testDate = '2099-01-01';
  const testFilePath = getStateFilePath(testDate);

  // Cleanup helper
  const cleanTestFile = () => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  };

  it('getTodayDateStringIST returns YYYY-MM-DD format respecting IST offset', () => {
    // UTC 2026-10-02T19:00:00Z is 2026-10-03 00:30 IST
    const utcDate = new Date('2026-10-02T19:00:00Z');
    const istString = getTodayDateStringIST(utcDate);
    assert.equal(istString, '2026-10-03');
  });

  it('saves state atomically and loads it back accurately', async () => {
    cleanTestFile();

    const mockState: StraddlePositionState = {
      date: testDate,
      entryExecuted: true,
      callLeg: {
        legType: 'CALL',
        symbol: 'BTC-1JAN99-100000-C-USDT',
        entryPrice: 500,
        entryPriceSource: 'fill',
        stopLossPrice: 1000,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 500,
      },
      putLeg: {
        legType: 'PUT',
        symbol: 'BTC-1JAN99-100000-P-USDT',
        entryPrice: 400,
        entryPriceSource: 'fill',
        stopLossPrice: 800,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 400,
      },
      totalCreditReceived: 900,
      targetProfitPoints: 495,
      combinedPnLPoints: 0,
      updatedAt: new Date().toISOString(),
    };

    await saveStraddleState(mockState, testDate);
    assert.equal(fs.existsSync(testFilePath), true);

    const loaded = await loadStraddleState(testDate);
    assert.notEqual(loaded, null);
    assert.equal(loaded?.date, testDate);
    assert.equal(loaded?.totalCreditReceived, 900);
    assert.equal(loaded?.callLeg.symbol, 'BTC-1JAN99-100000-C-USDT');
    assert.equal(loaded?.putLeg.symbol, 'BTC-1JAN99-100000-P-USDT');

    const executed = await hasTodayExecuted(testDate);
    assert.equal(executed, true);

    cleanTestFile();
  });

  it('hasTodayExecuted returns false when no state exists', async () => {
    cleanTestFile();
    const executed = await hasTodayExecuted(testDate);
    assert.equal(executed, false);
  });

  describe('hasUnresolvedOpenLeg', () => {
    const stateWith = (
      callStatus: 'open' | 'closed',
      putStatus: 'open' | 'closed',
      resolvedScenario?: StraddlePositionState['resolvedScenario']
    ): StraddlePositionState => ({
      date: testDate,
      entryExecuted: true,
      callLeg: {
        legType: 'CALL',
        symbol: 'BTC-1JAN99-100000-C-USDT',
        entryPrice: 320,
        entryPriceSource: 'fill',
        stopLossPrice: 640,
        quantity: 0.01,
        confirmedOpen: true,
        status: callStatus,
        currentPrice: 320,
      },
      putLeg: {
        legType: 'PUT',
        symbol: 'BTC-1JAN99-100000-P-USDT',
        entryPrice: 365,
        entryPriceSource: 'fill',
        stopLossPrice: 730,
        quantity: 0.01,
        confirmedOpen: true,
        status: putStatus,
        currentPrice: 365,
      },
      totalCreditReceived: 685,
      targetProfitPoints: 376.75,
      combinedPnLPoints: 0,
      resolvedScenario,
      updatedAt: new Date().toISOString(),
    });

    it('is true while a leg is still open and the cycle is unresolved', () => {
      assert.equal(hasUnresolvedOpenLeg(stateWith('open', 'closed')), true);
      assert.equal(hasUnresolvedOpenLeg(stateWith('closed', 'open')), true);
    });

    it('is false once every leg is closed', () => {
      assert.equal(hasUnresolvedOpenLeg(stateWith('closed', 'closed')), false);
    });

    it('is false once the cycle is resolved, even if a leg was left open', () => {
      assert.equal(hasUnresolvedOpenLeg(stateWith('open', 'open', 'MAX_TIME_REACHED')), false);
    });

    it('is false for missing state or a state that never entered', () => {
      assert.equal(hasUnresolvedOpenLeg(null), false);
      assert.equal(hasUnresolvedOpenLeg(undefined), false);
      assert.equal(
        hasUnresolvedOpenLeg({ ...stateWith('open', 'open'), entryExecuted: false }),
        false
      );
    });
  });
});

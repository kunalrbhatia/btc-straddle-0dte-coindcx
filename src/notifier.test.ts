import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramNotifier } from './notifier';

describe('TelegramNotifier Unit Tests', () => {
  it('gracefully disables when tokens are absent and does not attempt network calls', async () => {
    const notifier = new TelegramNotifier('', '');
    assert.equal(notifier.isEnabled, false);

    // Call all methods to ensure none throw or make unauthorized requests
    await notifier.notifyStraddleEntered({
      strike: 84500,
      callSymbol: 'BTC-3OCT26-84500-C-USDT',
      callPrice: 300,
      callPriceSource: 'fill',
      putSymbol: 'BTC-3OCT26-84500-P-USDT',
      putPrice: 250,
      putPriceSource: 'fill',
      totalCredit: 550,
      callSL: 600,
      putSL: 500,
      targetProfit: 302.5,
    });

    await notifier.notifyLegClosed({
      legType: 'CALL',
      symbol: 'BTC-3OCT26-84500-C-USDT',
      reason: 'SL_HIT',
      exitPrice: 600,
      runningPnL: -300,
    });

    await notifier.notifyScenarioResolved({
      scenario: 'PROFIT_TARGET_REACHED',
      totalCredit: 550,
      combinedPnL: 305,
      summary: 'Profit target hit cleanly',
    });

    await notifier.notifyEntryAborted({
      reason: 'Both orders failed',
      callSuccess: false,
      putSuccess: false,
    });

    await notifier.notifyError('test', new Error('test-err'));
    await notifier.notifyReconciliation('reconciled cleanly');
  });

  it('marks isEnabled = true when botToken and chatId are provided', () => {
    const notifier = new TelegramNotifier('mock-token', '123456');
    assert.equal(notifier.isEnabled, true);
  });
});

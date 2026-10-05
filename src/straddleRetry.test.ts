import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placeLegWithRetry } from './straddle';
import { OrderPlacementOutcome } from './types';

/**
 * The entry used to place each leg exactly once. On 2026-10-05 both legs came back
 * `400 OCS-TECH-0024 "Failed to place the order. Please retry."` and the day's trade was
 * abandoned — while the exit path retried the identical signature three times. These tests
 * pin the retry semantics: transient failures retry, permanent ones never do.
 */

const TRANSIENT_MSG =
  'Failed to place the order. Please retry. | code: 400 | errorCode: OCS-TECH-0024 | HTTP 400';

function outcome(overrides: Partial<OrderPlacementOutcome> = {}): OrderPlacementOutcome {
  return {
    symbol: 'BTC-6OCT26-85750-C-USDT',
    side: 'sell',
    success: false,
    rawResponse: { httpStatus: 400 },
    ...overrides,
  };
}

const noSleep = async (): Promise<void> => {};

describe('placeLegWithRetry', () => {
  it('retries a transient rejection and succeeds', async () => {
    let calls = 0;
    const result = await placeLegWithRetry(
      async () => {
        calls += 1;
        return calls < 2
          ? outcome({ message: TRANSIENT_MSG })
          : outcome({ success: true, orderId: 'ord-ok', message: undefined });
      },
      { sleep: noSleep }
    );

    assert.equal(result.success, true);
    assert.equal(result.orderId, 'ord-ok');
    assert.equal(calls, 2, 'expected exactly one retry');
  });

  it('does NOT retry a permanent rejection', async () => {
    let calls = 0;
    const result = await placeLegWithRetry(
      async () => {
        calls += 1;
        return outcome({
          message: 'BTC-9ZZZ99-1-C-USDT does not exist. | code: 422',
          rawResponse: { httpStatus: 422 },
        });
      },
      { sleep: noSleep }
    );

    assert.equal(result.success, false);
    assert.equal(calls, 1, 'an unknown contract must fail on the first attempt');
  });

  it('does not retry an insufficient-margin rejection', async () => {
    let calls = 0;
    await placeLegWithRetry(
      async () => {
        calls += 1;
        return outcome({ message: 'Insufficient margin to place this order', rawResponse: { httpStatus: 400 } });
      },
      { sleep: noSleep }
    );
    assert.equal(calls, 1);
  });

  it('gives up after maxAttempts and returns the last failure', async () => {
    let calls = 0;
    const result = await placeLegWithRetry(
      async () => {
        calls += 1;
        return outcome({ message: TRANSIENT_MSG });
      },
      { maxAttempts: 3, sleep: noSleep }
    );

    assert.equal(result.success, false);
    assert.equal(calls, 3, 'exactly maxAttempts attempts, never more');
    assert.match(result.message ?? '', /Please retry/);
  });

  it('backs off linearly and does not sleep after the final attempt', async () => {
    const slept: number[] = [];
    await placeLegWithRetry(
      async () => outcome({ message: TRANSIENT_MSG }),
      { maxAttempts: 3, baseDelayMs: 1000, sleep: async (ms) => { slept.push(ms); } }
    );

    assert.deepEqual(slept, [1000, 2000], 'waits base*1 then base*2, and nothing after the last try');
  });

  it('sleeps zero times when the first attempt succeeds', async () => {
    const slept: number[] = [];
    const result = await placeLegWithRetry(
      async () => outcome({ success: true, orderId: 'ord-first' }),
      { sleep: async (ms) => { slept.push(ms); } }
    );

    assert.equal(result.success, true);
    assert.deepEqual(slept, []);
  });

  it('treats a 5xx / network failure as retryable', async () => {
    let calls = 0;
    const result = await placeLegWithRetry(
      async () => {
        calls += 1;
        return calls < 3
          ? outcome({ message: 'HTTP 503 Service Unavailable', rawResponse: { httpStatus: 503 } })
          : outcome({ success: true, orderId: 'ord-after-503' });
      },
      { sleep: noSleep }
    );

    assert.equal(result.success, true);
    assert.equal(calls, 3);
  });
});

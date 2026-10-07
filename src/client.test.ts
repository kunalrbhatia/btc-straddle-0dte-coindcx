import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CoinDCXClient, SessionTokenExpiredError } from './client';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CoinDCXClient Options Unit Tests', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reads session token dynamically from file', () => {
    const tmpFile = path.join(os.tmpdir(), `test-token-${Date.now()}.token`);
    fs.writeFileSync(tmpFile, 'dynamic-token-12345', 'utf8');

    const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', '', tmpFile);
    assert.equal(client.getBearerToken(), 'dynamic-token-12345');

    // Simulate token refresh in background
    fs.writeFileSync(tmpFile, 'refreshed-token-67890', 'utf8');
    assert.equal(client.getBearerToken(), 'refreshed-token-67890');

    fs.unlinkSync(tmpFile);
  });

  it('handles 401 Unauthorized by throwing SessionTokenExpiredError without retrying in a loop', async () => {
    let callCount = 0;
    global.fetch = async (_url: string | URL | Request) => {
      callCount++;
      return new Response(JSON.stringify({ message: 'Invalid token' }), {
        status: 401,
        statusText: 'Unauthorized',
      });
    };

    const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'expired-token');

    await assert.rejects(
      async () => {
        await client.getOptionsPositions();
      },
      (err: unknown) => {
        assert.equal(err instanceof SessionTokenExpiredError, true);
        assert.match((err as Error).message, /session token expired\/invalid/i);
        return true;
      }
    );

    assert.equal(callCount, 1, 'Must not retry in a loop upon receiving 401');
  });

  it('getOptionsPositions maps markPrice correctly for flat payload', async () => {
    global.fetch = async (_url: string | URL | Request) => {
      const positionsData = [
        {
          symbol: 'BTC-4OCT26-85000-C-USDT',
          side: 'sell',
          qty: 0.01,
          entryPrice: 320,
          markPrice: 310,
        },
        {
          symbol: 'BTC-4OCT26-85000-P-USDT',
          side: 'sell',
          qty: 0.01,
          entryPrice: 280,
          markPrice: 275,
        },
      ];
      return new Response(JSON.stringify(positionsData), { status: 200 });
    };

    const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
    const positions = await client.getOptionsPositions();
    assert.equal(positions.length, 2);
    assert.equal(positions[0].markPrice, 310);
    assert.equal(positions[1].markPrice, 275);
  });

  it('getOptionsPositions correctly unwraps real production nested payload: { status: "success", data: { data: [...] } }', async () => {
    global.fetch = async (_url: string | URL | Request) => {
      const nestedResponse = {
        status: 'success',
        data: {
          data: [
            {
              symbol: 'BTC-5OCT26-85500-C-USDT',
              side: 'sell',
              qty: '0.01',
              avgPrice: '320.00',
              markPrice: '394.20',
              unrealisedPnl: '-74.20',
            },
            {
              symbol: 'BTC-5OCT26-85500-P-USDT',
              side: 'sell',
              qty: '0.01',
              avgPrice: '365.00',
              markPrice: '208.20',
              unrealisedPnl: '+156.80',
            },
          ],
        },
      };
      return new Response(JSON.stringify(nestedResponse), { status: 200 });
    };

    const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
    const positions = await client.getOptionsPositions();
    assert.equal(positions.length, 2);
    assert.equal(positions[0].symbol, 'BTC-5OCT26-85500-C-USDT');
    assert.equal(positions[0].markPrice, '394.20');
    assert.equal(positions[1].symbol, 'BTC-5OCT26-85500-P-USDT');
    assert.equal(positions[1].markPrice, '208.20');
  });

  it('getContractPrice resolves mark price from nested positions feed without falling back to entryPrice', async () => {
    global.fetch = async (_url: string | URL | Request) => {
      const nestedResponse = {
        status: 'success',
        data: {
          data: [
            {
              symbol: 'BTC-5OCT26-85500-C-USDT',
              entryPrice: 320,
              markPrice: 394.5,
            },
          ],
        },
      };
      return new Response(JSON.stringify(nestedResponse), { status: 200 });
    };

    const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
    const markPrice = await client.getContractPrice('BTC-5OCT26-85500-C-USDT');
    assert.equal(markPrice, 394.5, 'Must return live markPrice (394.5), NOT entryPrice (320)');
  });

  it('DRY_RUN mode sends no real HTTP network requests for order placement', async () => {
    let networkCalled = false;
    global.fetch = async () => {
      networkCalled = true;
      return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
    };

    const dryClient = new CoinDCXClient(
      'key',
      'secret',
      'https://api.coindcx.com',
      'valid-token',
      undefined,
      true // dryRun = true
    );

    const callResult = await dryClient.placeOptionsOrder('BTC-4OCT26-85000-C-USDT', 'sell', 0.01);
    assert.equal(networkCalled, false, 'DRY_RUN must not send network order requests');
    assert.equal(callResult.success, true);
    assert.match(callResult.orderId || '', /sim-options/);

    const cancelResult = await dryClient.cancelOptionsOrder('ord-123', 'BTC-4OCT26-85000-C-USDT');
    assert.equal(networkCalled, false, 'DRY_RUN must not send network cancel requests');
    assert.equal(cancelResult, true);
  });

  it('getContractPrice NEVER fabricates a price when no real one is available', async () => {
    // Regression guard: a previous revision returned a hard-coded 500 for a
    // "listed" contract. That invented number could become an entry price (wrong
    // SL/PT) or a monitor reading (a FALSE stop-loss that closes a healthy leg).
    global.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/v1/options/positions')) {
        return new Response(JSON.stringify({ status: 'success', data: [] }), { status: 200 });
      }
      if (u.includes('/api/v1/options/margin')) {
        // Preview succeeds (contract IS listed) but carries no mark price.
        return new Response(
          JSON.stringify({ status: 'success', data: { margin: 450, currency: 'INR' } }),
          { status: 200 }
        );
      }
      if (u.includes('/exchange/ticker')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
    const price = await client.getContractPrice('BTC-4OCT26-84750-C-USDT');

    assert.equal(price, 0, 'must return 0 rather than inventing a price');
  });

  it('isContractListed reports listing via the margin preview, independent of price', async () => {
    global.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/v1/options/margin')) {
        return new Response(JSON.stringify({ status: 'success', data: { margin: 450 } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ status: 'error', message: 'not found' }), { status: 404 });
    };
    const listed = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
    assert.equal(await listed.isContractListed('BTC-4OCT26-84750-C-USDT'), true);

    global.fetch = async () =>
      new Response(JSON.stringify({ status: 'error', error: { code: 422, message: 'Invalid' } }), {
        status: 200,
      });
    const notListed = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
    assert.equal(await notListed.isContractListed('BTC-9DEC26-99999-C-USDT'), false);
  });

  describe('placeOptionsOrder & payload verification', () => {
    it('creates the live-verified Limit order payload including the required conversionRate', async () => {
      let interceptedUrl = '';
      let interceptedBody: Record<string, unknown> = {};

      global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        interceptedUrl = String(url);
        if (init?.body && typeof init.body === 'string') {
          interceptedBody = JSON.parse(init.body) as Record<string, unknown>;
        }
        return new Response(
          JSON.stringify({ status: 'success', data: { id: 'ord-v2-100', status: 'filled' } }),
          { status: 200 }
        );
      };

      const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
      const outcome = await client.placeOptionsOrder(
        'BTC-4OCT26-85000-C-USDT',
        'sell',
        0.01,
        'Limit',
        416.0,
        '832.00',
        ''
      );

      assert.equal(interceptedUrl, 'https://api.coindcx.com/api/v2/options/order/create');
      assert.equal(interceptedBody.symbol, 'BTC-4OCT26-85000-C-USDT');
      assert.equal(interceptedBody.side, 'sell');
      assert.equal(interceptedBody.orderType, 'Limit');
      assert.equal(interceptedBody.qty, '0.01');
      assert.equal(interceptedBody.price, '416.00');
      assert.equal(interceptedBody.stopLoss, '832.00');
      assert.equal(interceptedBody.takeProfit, '');
      assert.equal(interceptedBody.conversionRate, '102', 'conversionRate IS required by the API (live-verified 400 without it)');

      assert.equal(outcome.success, true);
      assert.equal(outcome.orderId, 'ord-v2-100');
      assert.equal(outcome.limitPrice, 416.0);
    });

    it('defensively extracts order ID from various nested response candidate shapes', async () => {
      const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');

      // Candidate 1: data.order_id
      global.fetch = async () =>
        new Response(JSON.stringify({ status: 'success', data: { order_id: 'cand-1' } }), {
          status: 200,
        });
      const o1 = await client.placeOptionsOrder('BTC-4OCT26-85000-C-USDT', 'sell', 0.01, 'Limit', 400);
      assert.equal(o1.orderId, 'cand-1');

      // Candidate 2: data.orderId
      global.fetch = async () =>
        new Response(JSON.stringify({ status: 'success', data: { orderId: 'cand-2' } }), {
          status: 200,
        });
      const o2 = await client.placeOptionsOrder('BTC-4OCT26-85000-C-USDT', 'sell', 0.01, 'Limit', 400);
      assert.equal(o2.orderId, 'cand-2');

      // Candidate 3: root id
      global.fetch = async () =>
        new Response(JSON.stringify({ status: 'success', id: 9988 }), { status: 200 });
      const o3 = await client.placeOptionsOrder('BTC-4OCT26-85000-C-USDT', 'sell', 0.01, 'Limit', 400);
      assert.equal(o3.orderId, '9988');
    });

    it('DRY_RUN=true returns simulated outcome without network calls', async () => {
      let networkCalled = false;
      global.fetch = async () => {
        networkCalled = true;
        return new Response('{}', { status: 200 });
      };

      const dryClient = new CoinDCXClient(
        'key',
        'secret',
        'https://api.coindcx.com',
        'token',
        undefined,
        true
      );
      const outcome = await dryClient.placeOptionsOrder(
        'BTC-4OCT26-85000-C-USDT',
        'sell',
        0.01,
        'Limit',
        416.0,
        '832.00'
      );

      assert.equal(networkCalled, false, 'DRY_RUN must not invoke network');
      assert.equal(outcome.success, true);
      assert.equal(outcome.limitPrice, 416.0);
      assert.match(outcome.orderId ?? '', /^sim-options-/);
    });

    it('attaches reduceOnly: true to payload when requested and detects OCS-TECH-0013', async () => {
      let interceptedBody: Record<string, unknown> = {};
      global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.body && typeof init.body === 'string') {
          interceptedBody = JSON.parse(init.body) as Record<string, unknown>;
        }
        return new Response(
          JSON.stringify({
            status: 'error',
            code: 422,
            message: 'Failed to submit the reduce-only order! You do not have any open positions.',
            error: {
              code: 'OCS-TECH-0013',
              message: 'Failed to submit the reduce-only order! You do not have any open positions.',
            },
          }),
          { status: 422 }
        );
      };

      const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
      const outcome = await client.placeOptionsOrder(
        'BTC-6OCT26-85750-C-USDT',
        'buy',
        0.01,
        'Market',
        undefined,
        '',
        '',
        '102',
        true
      );

      assert.equal(interceptedBody.reduceOnly, true);
      assert.equal(interceptedBody.side, 'buy');
      assert.equal(outcome.success, false);
      assert.equal(outcome.isAlreadyFlat, true);
    });

    it('rejects BUY payload locally when stopLoss is higher than or equal to price', async () => {
      const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
      await assert.rejects(
        async () => {
          await client.placeOptionsOrder(
            'BTC-6OCT26-85750-C-USDT',
            'buy',
            0.01,
            'Limit',
            155,
            '440', // stopLoss > price -> invalid on BUY
            '',
            '102',
            true
          );
        },
        /StopLoss \(440\) for buy position must be lower than base_price \(155\)/
      );
    });

    it('rejects SELL payload locally when stopLoss is lower than or equal to price', async () => {
      const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
      await assert.rejects(
        async () => {
          await client.placeOptionsOrder(
            'BTC-6OCT26-85750-C-USDT',
            'sell',
            0.01,
            'Limit',
            400,
            '350', // stopLoss < price -> invalid on SELL
            '',
            '102',
            false
          );
        },
        /StopLoss \(350\) for sell position must be higher than base_price \(400\)/
      );
    });
  });

  describe('conversionRate resolution', () => {
    it('uses the live USDT/INR rate, and never invents one', async () => {
      // 1. live rate available -> use it
      global.fetch = async (url: string | URL | Request) => {
        if (String(url).includes('current_prices')) {
          return new Response(JSON.stringify({ USDTINR: '99.45', INRUSDT: '0.01005' }), {
            status: 200,
          });
        }
        return new Response('{}', { status: 404 });
      };
      const live = new CoinDCXClient('k', 's', 'https://api.coindcx.com', 'tok');
      assert.equal(await live.resolveConversionRate(), '99.45');

      // 2. rate endpoint failing -> configured fallback; the order still carries a rate
      global.fetch = async () => new Response('nope', { status: 500 });
      const down = new CoinDCXClient('k', 's', 'https://api.coindcx.com', 'tok', undefined, false, {
        fallbackConversionRate: '101.50',
      });
      assert.equal(await down.resolveConversionRate(), '101.50');

      // 3. an absurd quote is rejected rather than propagated
      global.fetch = async () =>
        new Response(JSON.stringify({ USDTINR: '0.01' }), { status: 200 });
      const absurd = new CoinDCXClient('k', 's', 'https://api.coindcx.com', 'tok', undefined, false, {
        fallbackConversionRate: '99.00',
      });
      assert.equal(await absurd.resolveConversionRate(), '99.00');
    });
  });
});

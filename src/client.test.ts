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

  it('getOptionsPositions maps markPrice correctly', async () => {
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

  it('getContractPrice resolves mark price from positions feed', async () => {
    global.fetch = async (_url: string | URL | Request) => {
      const positionsData = [
        {
          symbol: 'BTC-4OCT26-85000-C-USDT',
          markPrice: 425.5,
        },
      ];
      return new Response(JSON.stringify(positionsData), { status: 200 });
    };

    const client = new CoinDCXClient('key', 'secret', 'https://api.coindcx.com', 'valid-token');
    const markPrice = await client.getContractPrice('BTC-4OCT26-85000-C-USDT');
    assert.equal(markPrice, 425.5);
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
});

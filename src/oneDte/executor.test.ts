import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { roundToTick, executeOneDteEntry } from './executor';
import { OneDteConfig } from './config';
import { CoinDCXClient } from '../client';
import { loadOneDteState } from './stateStore';
import { getTodayDateStringIST } from '../stateStore';

const dummyConfig: OneDteConfig = {
  apiKey: 'test-key',
  apiSecret: 'test-secret',
  bearerToken: 'test-token',
  baseUrl: 'https://api.coindcx.com',
  dryRun: false,
  entryHourIST: 22,
  entryMinuteIST: 45,
  exitHourIST: 17,
  exitMinuteIST: 45,
  minPremium: 100,
  maxPremium: 150,
  orderQuantity: 0.01,
  leverage: 10,
  marginCurrency: 'USDT',
  conversionRate: '102',
  entryOrderType: 'Limit',
  entryFillTimeoutMs: 15000,
  stopLossMultiplier: 2.0,
  pollIntervalMs: 3000,
  slOverrunTolerance: 0.1,
  profitTargetRatio: 0.5,
  priceTick: 5,
};

describe('1 DTE Entry Integrity Tests', () => {
  let tmpDir: string;
  const prevEnv = { ...process.env };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onedte-entry-test-'));
    process.env.BTC_TEST_MODE = '1';
    process.env.ONEDTE_STATE_DIR = path.join(tmpDir, 'state');
    process.env.BTC_ALERTS_DIR = path.join(tmpDir, 'logs');
    fs.mkdirSync(process.env.ONEDTE_STATE_DIR, { recursive: true });
    fs.mkdirSync(process.env.BTC_ALERTS_DIR, { recursive: true });
  });

  after(() => {
    process.env = prevEnv;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // Mock instruments returning 0 DTE and 1 DTE expiries
  const getMockInstruments = () => {
    const now = Date.now();
    const expiry0Dte = now + 15 * 3600 * 1000;
    const expiry1Dte = now + 39 * 3600 * 1000;
    return [
      {
        symbol: 'BTC-TODAY-85000-C-USDT',
        optionsType: 'Call',
        strikePrice: '85000',
        expiryTime: String(expiry0Dte),
        isActive: true,
      },
      {
        symbol: 'BTC-TODAY-85000-P-USDT',
        optionsType: 'Put',
        strikePrice: '85000',
        expiryTime: String(expiry0Dte),
        isActive: true,
      },
      {
        symbol: 'BTC-TOMORROW-85000-C-USDT',
        optionsType: 'Call',
        strikePrice: '85000',
        expiryTime: String(expiry1Dte),
        isActive: true,
      },
      {
        symbol: 'BTC-TOMORROW-85000-P-USDT',
        optionsType: 'Put',
        strikePrice: '85000',
        expiryTime: String(expiry1Dte),
        isActive: true,
      },
    ];
  };

  it('tick rounding meets exact acceptance requirements', () => {
    assert.equal(roundToTick(129.44, 5), 130);
    assert.equal(roundToTick(120.6, 5), 120);
    assert.equal(roundToTick(129.44, 5) % 5, 0);
    assert.equal(roundToTick(120.6, 5) % 5, 0);
    assert.equal(roundToTick(100, 5) % 5, 0);
    assert.equal(roundToTick(102.5, 5) % 5, 0);
  });

  it('opening SELL order payload arms stopLoss at exactly 2x price (> price) and satisfies price % 5 === 0', async () => {
    const placedPayloads: Array<{
      symbol: string;
      side: string;
      qty: number;
      orderType: string;
      price: number | string | undefined;
      stopLoss: string;
      reduceOnly: boolean;
    }> = [];

    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', lastPrice: 129.44 },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', lastPrice: 120.6 },
      ],
      placeOptionsOrder: async (
        symbol: string,
        side: 'buy' | 'sell',
        qty: number,
        orderType: 'Limit' | 'Market',
        price?: number | string,
        stopLoss = '',
        _takeProfit = '',
        _conversionRate?: string,
        reduceOnly = false
      ) => {
        placedPayloads.push({
          symbol,
          side,
          qty,
          orderType,
          price,
          stopLoss,
          reduceOnly,
        });
        return {
          symbol,
          side,
          success: true,
          orderId: `order-${symbol}`,
          limitPrice: typeof price === 'number' ? price : Number(price),
        };
      },
    } as unknown as CoinDCXClient;

    const res = await executeOneDteEntry(mockClient, dummyConfig);
    assert.ok(res);
    assert.equal(res.status, 'active');
    assert.equal(res.entryExecuted, true);

    // Assert on constructed payloads
    assert.equal(placedPayloads.length, 2);

    for (const payload of placedPayloads) {
      assert.equal(payload.side, 'sell', 'Opening orders must be SELL');
      assert.equal(payload.reduceOnly, false, 'Entry orders must not be reduceOnly');

      const priceNum = Number(payload.price);
      assert.equal(priceNum % 5, 0, 'Every limit price in a built entry payload must satisfy price % 5 === 0');

      const slNum = Number(payload.stopLoss);
      assert.equal(slNum, 2 * priceNum, 'stopLoss must equal exactly 2x price');
      assert.ok(slNum > priceNum, 'stopLoss must be strictly greater than price on SELL');
    }

    const callPayload = placedPayloads.find((p) => p.symbol === 'BTC-TOMORROW-85000-C-USDT');
    const putPayload = placedPayloads.find((p) => p.symbol === 'BTC-TOMORROW-85000-P-USDT');

    assert.ok(callPayload);
    assert.ok(putPayload);

    // Call indicative was 129.44 -> rounded to 130 -> SL 260
    assert.equal(callPayload.price, 130);
    assert.equal(callPayload.stopLoss, '260');

    // Put indicative was 120.6 -> rounded to 120 -> SL 240
    assert.equal(putPayload.price, 120);
    assert.equal(putPayload.stopLoss, '240');
  });

  it('half-filled strangle (Call fails, Put succeeds) issues buy-back for Put and finishes flat', async () => {
    const buyBackPayloads: Array<{ symbol: string; side: string; reduceOnly: boolean }> = [];
    let positionsQueryCount = 0;

    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', lastPrice: 125 },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', lastPrice: 125 },
      ],
      placeOptionsOrder: async (
        symbol: string,
        side: 'buy' | 'sell',
        _qty: number,
        _orderType: 'Limit' | 'Market',
        _price?: any,
        _sl = '',
        _tp = '',
        _cr?: any,
        reduceOnly = false
      ) => {
        if (side === 'sell' && symbol.includes('-C-')) {
          return { symbol, side, success: false, message: 'Venue reject on call' };
        }
        if (side === 'sell' && symbol.includes('-P-')) {
          return { symbol, side, success: true, orderId: 'put-filled', limitPrice: 125 };
        }
        if (side === 'buy') {
          buyBackPayloads.push({ symbol, side, reduceOnly });
          return { symbol, side, success: true, orderId: 'buyback-order' };
        }
        return { symbol, side, success: false };
      },
      getOptionsPositions: async () => {
        positionsQueryCount++;
        // On verification query after buy-back, return empty array (verified flat book)
        return [];
      },
    } as unknown as CoinDCXClient;

    const res = await executeOneDteEntry(mockClient, dummyConfig);
    assert.equal(res, null, 'executeOneDteEntry must return null on aborted partial fill');

    // Assert buy-back was issued for Put
    assert.equal(buyBackPayloads.length, 1);
    assert.equal(buyBackPayloads[0].symbol, 'BTC-TOMORROW-85000-P-USDT');
    assert.equal(buyBackPayloads[0].side, 'buy');
    assert.equal(buyBackPayloads[0].reduceOnly, true);

    // Assert positions were queried and verified flat
    assert.ok(positionsQueryCount >= 1);

    // Assert persisted state recorded entryExecuted: false
    const todayStr = getTodayDateStringIST();
    const state = await loadOneDteState(todayStr);
    assert.ok(state);
    assert.equal(state.entryExecuted, false);
    assert.equal(state.status, 'closed');
    assert.ok(state.failureReason?.includes('Partial fill'));
  });

  it('half-filled strangle (Call succeeds, Put fails) issues buy-back for Call and finishes flat', async () => {
    const buyBackPayloads: Array<{ symbol: string; side: string; reduceOnly: boolean }> = [];
    let positionsQueryCount = 0;

    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', lastPrice: 125 },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', lastPrice: 125 },
      ],
      placeOptionsOrder: async (
        symbol: string,
        side: 'buy' | 'sell',
        _qty: number,
        _orderType: 'Limit' | 'Market',
        _price?: any,
        _sl = '',
        _tp = '',
        _cr?: any,
        reduceOnly = false
      ) => {
        if (side === 'sell' && symbol.includes('-C-')) {
          return { symbol, side, success: true, orderId: 'call-filled', limitPrice: 125 };
        }
        if (side === 'sell' && symbol.includes('-P-')) {
          return { symbol, side, success: false, message: 'Venue reject on put' };
        }
        if (side === 'buy') {
          buyBackPayloads.push({ symbol, side, reduceOnly });
          return { symbol, side, success: true, orderId: 'buyback-order' };
        }
        return { symbol, side, success: false };
      },
      getOptionsPositions: async () => {
        positionsQueryCount++;
        // Verified flat book
        return [];
      },
    } as unknown as CoinDCXClient;

    const res = await executeOneDteEntry(mockClient, dummyConfig);
    assert.equal(res, null);

    // Assert buy-back was issued for Call
    assert.equal(buyBackPayloads.length, 1);
    assert.equal(buyBackPayloads[0].symbol, 'BTC-TOMORROW-85000-C-USDT');
    assert.equal(buyBackPayloads[0].side, 'buy');
    assert.equal(buyBackPayloads[0].reduceOnly, true);
    assert.ok(positionsQueryCount >= 1);

    const todayStr = getTodayDateStringIST();
    const state = await loadOneDteState(todayStr);
    assert.ok(state);
    assert.equal(state.entryExecuted, false);
    assert.equal(state.status, 'closed');
  });

  it('total failure (both legs fail) persists entryExecuted: false with venue error', async () => {
    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', lastPrice: 125 },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', lastPrice: 125 },
      ],
      placeOptionsOrder: async (symbol: string, side: 'buy' | 'sell') => {
        return {
          symbol,
          side,
          success: false,
          message: '422 OCS-TECH-0013: Min tick size error',
        };
      },
    } as unknown as CoinDCXClient;

    const res = await executeOneDteEntry(mockClient, dummyConfig);
    assert.equal(res, null);

    const todayStr = getTodayDateStringIST();
    const state = await loadOneDteState(todayStr);
    assert.ok(state);
    assert.equal(state.entryExecuted, false, 'Persisted state must have entryExecuted: false');
    assert.equal(state.status, 'closed');
    assert.ok(state.failureReason?.includes('Both legs failed'));
    assert.ok(state.failureReason?.includes('422 OCS-TECH-0013'));
  });
});

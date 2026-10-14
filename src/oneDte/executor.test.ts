import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { roundToTick, entryLimitFromBid, executeOneDteEntry } from './executor';
import { selectOneDteContracts } from './selector';
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
  premiumSource: 'bid',
  allowOutOfBandFallback: false,
  requoteAfterMs: 5000,
  maxRequotes: 2,
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
    // FLOOR, not nearest: a marketable ask must not sit above the market or the leg never fills
    // (live proof 2026-10-12: a 105 limit rested unfilled while a 100 limit crossed and filled at 105).
    assert.equal(roundToTick(129.44, 5), 125);
    assert.equal(roundToTick(120.6, 5), 120);
    assert.equal(roundToTick(107.69, 5), 105);
    assert.equal(roundToTick(129.44, 5) % 5, 0);
    assert.equal(roundToTick(120.6, 5) % 5, 0);
    assert.equal(roundToTick(100, 5) % 5, 0);
    assert.equal(roundToTick(102.5, 5) % 5, 0);

    // Acceptance 1: Pricing helper entryLimitFromBid
    assert.equal(entryLimitFromBid(90, 5), 90);
    assert.equal(entryLimitFromBid(93.2, 5), 90);
    assert.equal(entryLimitFromBid(92.5, 5), 90);
    assert.equal(entryLimitFromBid(90, 5) % 5, 0);
    assert.equal(entryLimitFromBid(93.2, 5) % 5, 0);
    assert.equal(entryLimitFromBid(92.5, 5) % 5, 0);
    // Math.round(93.2/5)*5 is 95, so an assertion using Math.round semantics must fail:
    assert.notEqual(entryLimitFromBid(93.2, 5), Math.round(93.2 / 5) * 5);
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
        { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: '125', lastPrice: 129.44 },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: '120', lastPrice: 120.6 },
      ],
      // The venue's own fills: 128 / 122, deliberately different from the 125 / 120 limits we quoted,
      // so the test proves the record uses the fill and not the quote.
      getOptionsPositions: async () =>
        [
          { symbol: 'BTC-TOMORROW-85000-C-USDT', positionValue: '-0.0125', avgPrice: '128', markPrice: '128' },
          { symbol: 'BTC-TOMORROW-85000-P-USDT', positionValue: '-0.012', avgPrice: '122', markPrice: '122' },
        ] as unknown as Awaited<ReturnType<CoinDCXClient['getOptionsPositions']>>,
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

    // The recorded entry price is the VENUE's fill, not our quoted limit
    assert.equal(res.callLeg.entryPrice, 128);
    assert.equal(res.putLeg.entryPrice, 122);

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

    // Call indicative was 129.44 -> FLOORED to 125 -> SL 250 (a marketable ask; the nearest 130 would
    // rest above the market and leave the other side naked until it fills)
    assert.equal(callPayload.price, 125);
    assert.equal(callPayload.stopLoss, '250');

    // Put indicative was 120.6 -> floored to 120 -> SL 240
    assert.equal(putPayload.price, 120);
    assert.equal(putPayload.stopLoss, '240');
  });

  it('a leg accepted but never filled is cancelled and the filled leg unwound — no entry recorded', async () => {
    const cancelled: string[] = [];
    const buyBacks: string[] = [];
    let putStillOpen = true;

    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: '125', lastPrice: 129.44 },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: '120', lastPrice: 120.6 },
      ],
      placeOptionsOrder: async (symbol: string, side: 'buy' | 'sell') => {
        if (side === 'sell') {
          return { symbol, side, success: true, orderId: `order-${symbol}`, limitPrice: 125 };
        }
        buyBacks.push(symbol);
        putStillOpen = false;
        return { symbol, side, success: true, orderId: `bb-${symbol}` };
      },
      // The CALL sell was accepted but never becomes a position: exactly the 2026-10-12 failure.
      getOptionsPositions: async () =>
        (putStillOpen
          ? [{ symbol: 'BTC-TOMORROW-85000-P-USDT', positionValue: '-0.012', avgPrice: '122', markPrice: '122' }]
          : []) as unknown as Awaited<ReturnType<CoinDCXClient['getOptionsPositions']>>,
      cancelOptionsOrder: async (orderId: string) => {
        cancelled.push(orderId);
        return true;
      },
    } as unknown as CoinDCXClient;

    const res = await executeOneDteEntry(mockClient, { ...dummyConfig, entryFillTimeoutMs: 150 });
    assert.equal(res, null, 'an entry whose leg never filled must not return a state');
    assert.ok(
      cancelled.includes('order-BTC-TOMORROW-85000-C-USDT'),
      `the resting CALL order must be cancelled, got: ${cancelled.join(',') || 'nothing'}`
    );
    assert.ok(buyBacks.includes('BTC-TOMORROW-85000-P-USDT'), 'the filled PUT must be bought back');

    const st = await loadOneDteState(getTodayDateStringIST());
    assert.ok(st);
    assert.equal(st.entryExecuted, false);
    assert.equal(st.status, 'closed');
  });

  it('half-filled strangle (Call fails, Put succeeds) issues buy-back for Put and finishes flat', async () => {
    const buyBackPayloads: Array<{ symbol: string; side: string; reduceOnly: boolean }> = [];
    let positionsQueryCount = 0;

    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: '125', lastPrice: 125 },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: '125', lastPrice: 125 },
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
        { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: '125', lastPrice: 125 },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: '125', lastPrice: 125 },
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
        { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: '125', lastPrice: 125 },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: '125', lastPrice: 125 },
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

  // Acceptance 2: Selector picks on the bid
  it('selector picks on the bid and rejects out-of-band contracts when fallback is disabled', async () => {
    const realExcerpt = [
      {
        symbol: 'BTC-16OCT26-84250-C-USDT',
        bidPrice: '90',
        bidSize: '19.26',
        askPrice: '95',
        askSize: '19.95',
        lastPrice: '90',
        markPrice: '104.4239794',
      },
      {
        symbol: 'BTC-16OCT26-79000-P-USDT',
        bidPrice: '170',
        bidSize: '41.81',
        askPrice: '175',
        askSize: '7.06',
        lastPrice: '180',
        markPrice: '137.70673063',
      },
    ];

    const mockClient = {
      getOptionsInstruments: async () => [
        { symbol: 'BTC-TODAY-80000-C-USDT', optionsType: 'Call', expiryTime: String(Date.now() + 15 * 3600 * 1000), isActive: true },
        { symbol: 'BTC-16OCT26-84250-C-USDT', optionsType: 'Call', expiryTime: '1792137600000', isActive: true },
        { symbol: 'BTC-16OCT26-79000-P-USDT', optionsType: 'Put', expiryTime: '1792137600000', isActive: true },
      ],
      getOptionsTicker: async () => realExcerpt,
    } as unknown as CoinDCXClient;

    const cfgNoFallback: OneDteConfig = {
      ...dummyConfig,
      premiumSource: 'bid',
      allowOutOfBandFallback: false,
      minPremium: 100,
      maxPremium: 150,
    };

    const resNoFallback = await selectOneDteContracts(mockClient, cfgNoFallback);
    assert.equal(resNoFallback, null, 'BTC-16OCT26-84250-C-USDT (bid 90, mark 104.42) must NOT be chosen when allowOutOfBandFallback=false');

    // Flip the fixture's bidPrice to 125
    const flippedExcerpt = [
      {
        symbol: 'BTC-16OCT26-84250-C-USDT',
        bidPrice: '125',
        bidSize: '19.26',
        askPrice: '130',
        askSize: '19.95',
        lastPrice: '90',
        markPrice: '104.4239794',
      },
      {
        symbol: 'BTC-16OCT26-79000-P-USDT',
        bidPrice: '125',
        bidSize: '41.81',
        askPrice: '130',
        askSize: '7.06',
        lastPrice: '180',
        markPrice: '137.70673063',
      },
    ];
    const mockClientFlipped = {
      getOptionsInstruments: async () => [
        { symbol: 'BTC-TODAY-80000-C-USDT', optionsType: 'Call', expiryTime: String(Date.now() + 15 * 3600 * 1000), isActive: true },
        { symbol: 'BTC-16OCT26-84250-C-USDT', optionsType: 'Call', expiryTime: '1792137600000', isActive: true },
        { symbol: 'BTC-16OCT26-79000-P-USDT', optionsType: 'Put', expiryTime: '1792137600000', isActive: true },
      ],
      getOptionsTicker: async () => flippedExcerpt,
    } as unknown as CoinDCXClient;

    const resFlipped = await selectOneDteContracts(mockClientFlipped, cfgNoFallback);
    assert.ok(resFlipped);
    assert.equal(resFlipped.call.symbol, 'BTC-16OCT26-84250-C-USDT');
    assert.equal(resFlipped.call.premium, 125);
  });

  // Acceptance 3: A missing bid is never invented
  it('a missing or zero bid is never invented from markPrice or lastPrice', async () => {
    const zeroBidExcerpt = [
      {
        symbol: 'BTC-16OCT26-84250-C-USDT',
        bidPrice: '0',
        bidSize: '0',
        askPrice: '95',
        askSize: '19.95',
        lastPrice: '125',
        markPrice: '125',
      },
      {
        symbol: 'BTC-16OCT26-79000-P-USDT',
        bidPrice: '125',
        bidSize: '41.81',
        askPrice: '130',
        askSize: '7.06',
        lastPrice: '125',
        markPrice: '125',
      },
    ];

    const mockClient = {
      getOptionsInstruments: async () => [
        { symbol: 'BTC-TODAY-80000-C-USDT', optionsType: 'Call', expiryTime: String(Date.now() + 15 * 3600 * 1000), isActive: true },
        { symbol: 'BTC-16OCT26-84250-C-USDT', optionsType: 'Call', expiryTime: '1792137600000', isActive: true },
        { symbol: 'BTC-16OCT26-79000-P-USDT', optionsType: 'Put', expiryTime: '1792137600000', isActive: true },
      ],
      getOptionsTicker: async () => zeroBidExcerpt,
    } as unknown as CoinDCXClient;

    const cfg: OneDteConfig = {
      ...dummyConfig,
      premiumSource: 'bid',
      allowOutOfBandFallback: true, // even with fallback true, bid=0 must not be chosen
    };

    const res = await selectOneDteContracts(mockClient, cfg);
    assert.equal(res, null, 'Selector must reject call with bidPrice 0, never using markPrice/lastPrice');
  });

  // Acceptance 4: Re-quote before giving up
  it('cancels resting order before placing replacement on requote and records venue avgPrice', async () => {
    const cancelledOrders: string[] = [];
    const placedOrders: Array<{ symbol: string; side: string; price: any; stopLoss: string; orderId: string }> = [];
    let orderCounter = 0;
    let positionsCallCount = 0;

    let tickerCallCount = 0;
    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => {
        tickerCallCount++;
        // On re-quote, bid moved from 125 to 120
        const bid = tickerCallCount === 1 ? '125' : '120';
        return [
          { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: bid, askPrice: '130', markPrice: '125', bidSize: '10' },
          { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: bid, askPrice: '130', markPrice: '125', bidSize: '10' },
        ];
      },
      cancelOptionsOrder: async (orderId: string) => {
        cancelledOrders.push(orderId);
        return true;
      },
      placeOptionsOrder: async (symbol: string, side: string, _qty: number, _type: string, price: any, stopLoss: string) => {
        orderCounter++;
        const id = `order-${orderCounter}-${symbol}`;
        placedOrders.push({ symbol, side, price, stopLoss, orderId: id });
        return { symbol, side, success: true, orderId: id, limitPrice: Number(price) };
      },
      getOptionsPositions: async () => {
        positionsCallCount++;
        // First 2 checks: empty (unfilled). On 3rd check (after requote 1): show positions!
        if (positionsCallCount >= 3) {
          return [
            { symbol: 'BTC-TOMORROW-85000-C-USDT', positionValue: '-0.01', avgPrice: '118' },
            { symbol: 'BTC-TOMORROW-85000-P-USDT', positionValue: '-0.01', avgPrice: '119' },
          ];
        }
        return [];
      },
    } as unknown as CoinDCXClient;

    const cfg: OneDteConfig = {
      ...dummyConfig,
      premiumSource: 'bid',
      requoteAfterMs: 50,
      maxRequotes: 2,
      entryFillTimeoutMs: 300,
    };

    const res = await executeOneDteEntry(mockClient, cfg);
    assert.ok(res, 'Entry should succeed after requote');
    assert.equal(res.entryExecuted, true);
    assert.equal(res.status, 'active');

    // Assert cancel before replacement
    assert.ok(cancelledOrders.length >= 2, 'Both resting orders should have been cancelled before replacement');
    // Check call count: exactly 1 cancel + 1 re-place per re-quote
    assert.equal(placedOrders.filter(p => p.symbol.includes('-C-')).length, 2);
    assert.equal(placedOrders.filter(p => p.symbol.includes('-P-')).length, 2);

    // Assert entryPrice is venue avgPrice (118, 119), never the limit
    assert.equal(res.callLeg.entryPrice, 118);
    assert.equal(res.putLeg.entryPrice, 119);
    assert.equal(res.callLeg.stopLossPrice, 240); // 2 * 120 (new limit)
    assert.equal(res.putLeg.stopLossPrice, 240);
  });

  // Acceptance 5: Chase exhaustion stays safe
  it('chase exhaustion ends with entryExecuted: false, resting orders cancelled, and unwound', async () => {
    const cancelledOrders: string[] = [];
    const buyBacks: string[] = [];
    let orderCounter = 0;

    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: '125', askPrice: '130', markPrice: '125' },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: '125', askPrice: '130', markPrice: '125' },
      ],
      cancelOptionsOrder: async (orderId: string) => {
        cancelledOrders.push(orderId);
        return true;
      },
      placeOptionsOrder: async (symbol: string, side: string, _qty: number, _type: string, price: any, _sl: string, _tp: string, _cr: any, _reduceOnly = false) => {
        if (side === 'buy') {
          buyBacks.push(symbol);
          return { symbol, side, success: true, orderId: `bb-${symbol}` };
        }
        orderCounter++;
        return { symbol, side, success: true, orderId: `order-${orderCounter}`, limitPrice: Number(price) };
      },
      getOptionsPositions: async () => [], // Always empty
    } as unknown as CoinDCXClient;

    const cfg: OneDteConfig = {
      ...dummyConfig,
      premiumSource: 'bid',
      requoteAfterMs: 50,
      maxRequotes: 2,
      entryFillTimeoutMs: 150,
    };

    const res = await executeOneDteEntry(mockClient, cfg);
    assert.equal(res, null);

    const todayStr = getTodayDateStringIST();
    const st = await loadOneDteState(todayStr);
    assert.ok(st);
    assert.equal(st.entryExecuted, false);
    assert.equal(st.status, 'closed');
    assert.ok(cancelledOrders.length >= 2, 'Resting orders must be cancelled upon exhaustion');
  });

  // Acceptance 6: Invariants that must not break
  it('enforces invariants: no entryExecuted without venue positions, SL === 2x limit, safe unwind', async () => {
    let orderCounter = 0;
    const placedPayloads: any[] = [];
    const buyBacks: string[] = [];
    let callFilledOnVenue = true;
    let putFilledOnVenue = false;

    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: '125', askPrice: '130', markPrice: '125' },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: '125', askPrice: '130', markPrice: '125' },
      ],
      cancelOptionsOrder: async () => true,
      placeOptionsOrder: async (symbol: string, side: string, _qty: number, _orderType: string, price: any, stopLoss: string, _tp: string, _cr: any, reduceOnly = false) => {
        placedPayloads.push({ symbol, side, price: Number(price), stopLoss: Number(stopLoss), reduceOnly });
        if (side === 'buy') {
          buyBacks.push(symbol);
          callFilledOnVenue = false; // bought back!
          return { symbol, side, success: true, orderId: `bb-${symbol}` };
        }
        orderCounter++;
        return { symbol, side, success: true, orderId: `order-${orderCounter}`, limitPrice: Number(price) };
      },
      getOptionsPositions: async () => {
        const pos = [];
        if (callFilledOnVenue) pos.push({ symbol: 'BTC-TOMORROW-85000-C-USDT', positionValue: '-0.01', avgPrice: '125' });
        if (putFilledOnVenue) pos.push({ symbol: 'BTC-TOMORROW-85000-P-USDT', positionValue: '-0.01', avgPrice: '125' });
        return pos;
      },
    } as unknown as CoinDCXClient;

    const cfg: OneDteConfig = {
      ...dummyConfig,
      premiumSource: 'bid',
      requoteAfterMs: 50,
      maxRequotes: 1,
      entryFillTimeoutMs: 120,
    };

    const res = await executeOneDteEntry(mockClient, cfg);
    assert.equal(res, null);

    // Invariant: every entry sell payload carries stopLoss strictly above its limit, stopLoss === 2 * limit
    const sellPayloads = placedPayloads.filter((p) => p.side === 'sell');
    for (const p of sellPayloads) {
      assert.equal(p.stopLoss, 2 * p.price);
      assert.ok(p.stopLoss > p.price);
    }

    // Invariant: no persisted state records entryExecuted: true unless venue showed both
    const todayStr = getTodayDateStringIST();
    const st = await loadOneDteState(todayStr);
    assert.ok(st);
    assert.equal(st.entryExecuted, false);

    // Invariant: a leg that filled is bought back before attempt ends
    assert.ok(buyBacks.includes('BTC-TOMORROW-85000-C-USDT'));
  });

  it('a FAILED cancel of the resting order withholds the replacement sell — no double sell', async () => {
    const placed: Array<{ symbol: string; price: any }> = [];
    let orderCounter = 0;
    let cancelCalls = 0;

    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: '125', askPrice: '130', markPrice: '125', bidSize: '10' },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: '125', askPrice: '130', markPrice: '125', bidSize: '10' },
      ],
      // The venue refuses the cancel (already filled, not found, or a network fault): nothing was
      // cancelled and the previous order may still be resting.
      cancelOptionsOrder: async () => {
        cancelCalls++;
        return false;
      },
      placeOptionsOrder: async (symbol: string, _side: string, _q: number, _t: string, price: any) => {
        orderCounter++;
        placed.push({ symbol, price });
        return { symbol, side: 'sell', success: true, orderId: `order-${orderCounter}-${symbol}`, limitPrice: Number(price) };
      },
      // Never fills: this is the case that triggers the re-quote.
      getOptionsPositions: async () => [],
    } as unknown as CoinDCXClient;

    const cfg: OneDteConfig = {
      ...dummyConfig,
      premiumSource: 'bid',
      requoteAfterMs: 50,
      maxRequotes: 2,
      entryFillTimeoutMs: 400,
    };

    const res = await executeOneDteEntry(mockClient, cfg);

    assert.ok(cancelCalls > 0, 'SETUP: a cancel must have been attempted');
    const callSells = placed.filter((p) => p.symbol.includes('-C-'));
    const putSells = placed.filter((p) => p.symbol.includes('-P-'));
    assert.equal(
      callSells.length,
      1,
      `a second CALL sell must never be placed while the first may still be resting (placed: ${callSells.map((p) => p.price).join(', ')})`
    );
    assert.equal(putSells.length, 1, 'a second PUT sell must never be placed while the first may still be resting');
    assert.equal(res, null, 'the attempt must abort');
  });

  it('a cancel that fails mid-chase stops further placements for that leg', async () => {
    const placedIds: string[] = [];
    let orderCounter = 0;
    let callCancelCalls = 0;

    const mockClient = {
      getOptionsInstruments: async () => getMockInstruments(),
      getOptionsTicker: async () => [
        { symbol: 'BTC-TOMORROW-85000-C-USDT', bidPrice: '125', askPrice: '130', markPrice: '125', bidSize: '10' },
        { symbol: 'BTC-TOMORROW-85000-P-USDT', bidPrice: '125', askPrice: '130', markPrice: '125', bidSize: '10' },
      ],
      // CALL: the first cancel succeeds (so one replacement is placed), the second fails — after which no
      // further sell may be placed, because the previous one may still be resting. PUT: cancels succeed.
      cancelOptionsOrder: async (orderId: string) => {
        if (orderId.includes('-C-')) {
          callCancelCalls++;
          return callCancelCalls === 1;
        }
        return true;
      },
      placeOptionsOrder: async (symbol: string, _side: string, _q: number, _t: string, price: any) => {
        orderCounter++;
        const id = `order-${orderCounter}-${symbol}`;
        placedIds.push(id);
        return { symbol, side: 'sell', success: true, orderId: id, limitPrice: Number(price) };
      },
      getOptionsPositions: async () => [],
    } as unknown as CoinDCXClient;

    const cfg: OneDteConfig = {
      ...dummyConfig,
      premiumSource: 'bid',
      requoteAfterMs: 50,
      maxRequotes: 2,
      entryFillTimeoutMs: 400,
    };

    await executeOneDteEntry(mockClient, cfg);

    const callPlacements = placedIds.filter((id) => id.includes('-C-')).length;
    const putPlacements = placedIds.filter((id) => id.includes('-P-')).length;
    assert.equal(callPlacements, 2, `the CALL must stop at 2 placements once a cancel fails (got ${callPlacements})`);
    assert.equal(putPlacements, 3, `the PUT, whose cancels succeed, must still use all 3 placements (got ${putPlacements})`);
  });
});


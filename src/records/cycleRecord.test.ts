import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CycleRecordWriter, scrubCredentials } from './cycleRecordWriter';
import { getRecordJsonlPath, getRecordMtmPath, getRecordSummaryPath } from './cycleRecordPaths';
import { verifyCycleAgainstVenue } from './venueVerification';
import { backfillHistoricalCycle } from './cycleBackfill';

test('CycleRecordWriter — Append-only event ledger and atomic snapshot', async (t) => {
  const testCycle = '2099-01-01';
  const writer = new CycleRecordWriter(testCycle);

  const jsonlPath = getRecordJsonlPath(testCycle);
  const mtmPath = getRecordMtmPath(testCycle);
  const summaryPath = getRecordSummaryPath(testCycle);

  // Clean up any test leftovers
  if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);
  if (fs.existsSync(mtmPath)) fs.unlinkSync(mtmPath);
  if (fs.existsSync(summaryPath)) fs.unlinkSync(summaryPath);

  await t.test('appends events in order without overwriting', () => {
    writer.appendEvent('CYCLE_START', { strike: 90000, callSymbol: 'BTC-CALL', putSymbol: 'BTC-PUT' });
    writer.appendEvent('ORDER_PLACED', { legType: 'CALL', price: 400 });

    assert.ok(fs.existsSync(jsonlPath), 'jsonl file should exist');
    const content = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    assert.equal(content.length, 2, 'should have 2 lines');

    const first = JSON.parse(content[0]);
    assert.equal(first.event, 'CYCLE_START');
    assert.equal(first.cycle, testCycle);
    assert.equal(first.data.strike, 90000);

    const second = JSON.parse(content[1]);
    assert.equal(second.event, 'ORDER_PLACED');
    assert.equal(second.data.price, 400);
  });

  await t.test('appends MTM tape samples', () => {
    writer.appendMtmTape({
      ts: '2099-01-01T10:00:00+05:30',
      callMark: 400,
      putMark: 350,
      combinedPts: 50,
    });
    writer.appendMtmTape({
      ts: '2099-01-01T10:05:00+05:30',
      callMark: 380,
      putMark: 340,
      combinedPts: 80,
    });

    assert.ok(fs.existsSync(mtmPath), 'mtm file should exist');
    const lines = fs.readFileSync(mtmPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const parsed = JSON.parse(lines[1]);
    assert.equal(parsed.combinedPts, 80);
  });

  await t.test('atomically writes summary snapshot and reads it back', () => {
    writer.writeSummarySnapshot({
      schemaVersion: 1,
      cycle: testCycle,
      entryDate: '2098-12-31',
      updatedAt: '2099-01-01T13:30:00+05:30',
      status: 'CLOSED',
      atmStrike: 90000,
      totalCreditReceived: 750,
      targetProfitPoints: 412.5,
      callLeg: {
        symbol: 'BTC-CALL',
        entryPrice: 400,
        status: 'closed',
        exitPrice: 200,
        closeReason: 'PROFIT_TARGET_HIT',
      },
      putLeg: {
        symbol: 'BTC-PUT',
        entryPrice: 350,
        status: 'closed',
        exitPrice: 150,
        closeReason: 'PROFIT_TARGET_HIT',
      },
      combinedPnLPoints: 400,
      resolvedScenario: 'PROFIT_TARGET_REACHED',
    });

    assert.ok(fs.existsSync(summaryPath), 'summary file should exist');
    const read = writer.readSummarySnapshot();
    assert.ok(read, 'should read snapshot');
    assert.equal(read?.status, 'CLOSED');
    assert.equal(read?.combinedPnLPoints, 400);
    assert.equal(read?.resolvedScenario, 'PROFIT_TARGET_REACHED');
  });

  // Clean up
  if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);
  if (fs.existsSync(mtmPath)) fs.unlinkSync(mtmPath);
  if (fs.existsSync(summaryPath)) fs.unlinkSync(summaryPath);
});

test('CycleRecordWriter — Secret scrubbing protects against accidental token leaks', () => {
  const dirty = {
    user: 'alice',
    bearerToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThis', // pragma: allowlist secret
    authHeader: 'Bearer secret-key-here',
    nested: {
      session_token: 'valid-session-12345', // pragma: allowlist secret
      regularData: 'harmless string',
    },
  };

  const scrubbed = scrubCredentials(dirty) as any;
  assert.equal(scrubbed.bearerToken, '[SCRUBBED_CREDENTIAL]');
  assert.equal(scrubbed.authHeader, '[SCRUBBED_BEARER]');
  assert.equal(scrubbed.nested.session_token, '[SCRUBBED_CREDENTIAL]');
  assert.equal(scrubbed.nested.regularData, 'harmless string');
});

test('Venue Verification — Matches, Mismatches, and Unverified Handling', async (t) => {
  const cycle = '2099-02-02';

  const mockSnapshot: any = {
    schemaVersion: 1,
    cycle,
    entryDate: '2099-02-01',
    status: 'CLOSED',
    callSymbol: 'BTC-2FEB99-90000-C-USDT',
    putSymbol: 'BTC-2FEB99-90000-P-USDT',
    callLeg: {
      symbol: 'BTC-2FEB99-90000-C-USDT',
      entryPrice: 500,
      venueAvgPrice: 500,
      status: 'closed',
      exitPrice: 300,
      orderId: 'call-ord-1',
      closeOrderId: 'call-close-1',
    },
    putLeg: {
      symbol: 'BTC-2FEB99-90000-P-USDT',
      entryPrice: 400,
      venueAvgPrice: 400,
      status: 'closed',
      exitPrice: 0,
      closeReason: 'EXPIRED',
      orderId: 'put-ord-1',
    },
    combinedPnLPoints: 600,
  };

  await t.test('verifies MATCH when venue ledger agrees exactly', async () => {
    const venueLedger = [
      { orderId: 'call-ord-1', symbol: 'BTC-2FEB99-90000-C-USDT', transactionType: 'TRADE', filledPrice: 500, fee: 10, grossCashFlow: 510, netCashFlow: 500 },
      { orderId: 'put-ord-1', symbol: 'BTC-2FEB99-90000-P-USDT', transactionType: 'TRADE', filledPrice: 400, fee: 10, grossCashFlow: 410, netCashFlow: 400 },
      { orderId: 'call-close-1', symbol: 'BTC-2FEB99-90000-C-USDT', transactionType: 'TRADE', filledPrice: 300, fee: 5, grossCashFlow: -300, netCashFlow: -305 },
      { symbol: 'BTC-2FEB99-90000-P-USDT', transactionType: 'DELIVERY', filledPrice: 0, fee: 0, grossCashFlow: 0, netCashFlow: 0 },
    ];

    const report = await verifyCycleAgainstVenue(cycle, {
      snapshotOverride: mockSnapshot,
      walletTransactionsOverride: venueLedger,
      positionsOverride: [],
      ordersOverride: [],
      tolerance: 0.5,
    });

    assert.equal(report.overallVerdict, 'VERIFIED');
    assert.ok(report.claims.every((c) => c.status === 'MATCH'));
  });

  await t.test('detects MISMATCH with delta when venue entry differs', async () => {
    const venueLedger = [
      { orderId: 'call-ord-1', symbol: 'BTC-2FEB99-90000-C-USDT', transactionType: 'TRADE', filledPrice: 520 }, // 20 pts higher
      { orderId: 'put-ord-1', symbol: 'BTC-2FEB99-90000-P-USDT', transactionType: 'TRADE', filledPrice: 400 },
    ];

    const report = await verifyCycleAgainstVenue(cycle, {
      snapshotOverride: mockSnapshot,
      walletTransactionsOverride: venueLedger,
      positionsOverride: [],
      ordersOverride: [],
      tolerance: 0.5,
    });

    assert.equal(report.overallVerdict, 'FAILED');
    const callEntryClaim = report.claims.find((c) => c.claim.includes('CALL Entry'));
    assert.ok(callEntryClaim);
    assert.equal(callEntryClaim?.status, 'MISMATCH');
    assert.equal(callEntryClaim?.delta, 20);
  });

  await t.test('marks UNVERIFIED when venue ledger is missing without inventing data', async () => {
    const report = await verifyCycleAgainstVenue(cycle, {
      snapshotOverride: mockSnapshot,
      walletTransactionsOverride: [],
      positionsOverride: [],
      ordersOverride: [],
    });

    assert.equal(report.overallVerdict, 'PARTIAL');
    const callEntryClaim = report.claims.find((c) => c.claim.includes('CALL Entry'));
    assert.equal(callEntryClaim?.status, 'UNVERIFIED');
  });

  await t.test('verifies DELIVERY row using netCashFlow (falling back to balanceChange) instead of filledPrice', async () => {
    // Live CoinDCX shape where filledPrice is the underlying spot (~86282) but netCashFlow is 0
    const deliveryRow = {
      transactionType: 'DELIVERY',
      symbol: 'BTC-2FEB99-90000-P-USDT',
      filledPrice: '86282.52872153',
      quantity: '0.01',
      balanceChange: '0',
      netCashFlow: '0',
      grossCashFlow: '0',
      fee: '0',
      orderId: '',
    };

    const venueLedger = [
      { orderId: 'call-ord-1', symbol: 'BTC-2FEB99-90000-C-USDT', transactionType: 'TRADE', filledPrice: 500, fee: 10, grossCashFlow: 510, netCashFlow: 500 },
      { orderId: 'put-ord-1', symbol: 'BTC-2FEB99-90000-P-USDT', transactionType: 'TRADE', filledPrice: 400, fee: 10, grossCashFlow: 410, netCashFlow: 400 },
      { orderId: 'call-close-1', symbol: 'BTC-2FEB99-90000-C-USDT', transactionType: 'TRADE', filledPrice: 300, fee: 5, grossCashFlow: -300, netCashFlow: -305 },
      deliveryRow,
    ];

    const report = await verifyCycleAgainstVenue(cycle, {
      snapshotOverride: mockSnapshot,
      walletTransactionsOverride: venueLedger,
      positionsOverride: [],
      ordersOverride: [],
      tolerance: 0.5,
    });

    const deliveryClaim = report.claims.find((c) => c.claim.includes('PUT Settlement at expiry'));
    assert.ok(deliveryClaim);
    assert.equal(deliveryClaim?.status, 'MATCH');
    assert.equal(deliveryClaim?.venueValue, 0);
  });
});

test('Cycle Backfill — generates reconstructed records for historical cycle', async () => {
  const result = await backfillHistoricalCycle({
    expiryDateStr: '2026-10-05',
    overwrite: true,
  });

  assert.ok(fs.existsSync(result.jsonlPath));
  assert.ok(fs.existsSync(result.mtmPath));
  assert.ok(fs.existsSync(result.summaryPath));
  assert.equal(result.summary.reconstructed, true);
  assert.equal(result.summary.source, 'state+logs');
  assert.equal(result.summary.atmStrike, 85250);
  assert.equal(result.summary.callSymbol, 'BTC-5OCT26-85250-C-USDT');
  assert.equal(result.summary.putSymbol, 'BTC-5OCT26-85250-P-USDT');
  assert.equal(result.summary.callLeg?.exitPrice, 677.28);
  assert.equal(result.summary.callLeg?.closeReason, 'SL_HIT');
  assert.equal(result.summary.callLeg?.pnlPoints, -357.28);
  assert.equal(result.summary.putLeg?.exitPrice, 0);
  assert.equal(result.summary.putLeg?.pnlPoints, 365);
  const pnl = result.summary.combinedPnLPoints ?? 0;
  assert.equal(Math.round(pnl * 100) / 100, 7.72);

  // Clean up backfill test output
  if (fs.existsSync(result.jsonlPath)) fs.unlinkSync(result.jsonlPath);
  if (fs.existsSync(result.mtmPath)) fs.unlinkSync(result.mtmPath);
  if (fs.existsSync(result.summaryPath)) fs.unlinkSync(result.summaryPath);
});

test('CycleRecordWriter — RECORD_DIR isolation prevents writing outside assigned directory', () => {
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-records-test-'));
  const prevEnv = process.env.RECORD_DIR;
  try {
    process.env.RECORD_DIR = customDir;
    const writer = new CycleRecordWriter('2099-05-05');
    writer.appendEvent('CYCLE_START', { test: true });

    const expectedFile = path.join(customDir, '2099-05-05.jsonl');
    assert.ok(fs.existsSync(expectedFile), 'Should write strictly into RECORD_DIR');
    if (fs.existsSync(expectedFile)) fs.unlinkSync(expectedFile);
  } finally {
    process.env.RECORD_DIR = prevEnv;
    if (fs.existsSync(customDir)) {
      try {
        fs.rmSync(customDir, { recursive: true, force: true });
      } catch {
        // cleanup
      }
    }
  }
});

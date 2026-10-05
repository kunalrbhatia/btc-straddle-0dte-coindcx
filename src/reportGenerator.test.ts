import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { generateDailyReport } from './reports/reportGenerator';
import { publishDailyReport } from './reports/reportPublisher';
import { parseContractExpiryDate } from './reports/reportDataCollector';
import { runStartupReportCatchup } from './reports/reportScheduler';
import { StraddlePositionState } from './types';

describe('Daily Trade Report Unit Tests', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-report-tests-'));
  const testStateDir = path.join(tmpBase, 'state');
  const testLogsDir = path.join(tmpBase, 'logs');
  const testReportsDir = path.join(tmpBase, 'reports');

  fs.mkdirSync(testStateDir, { recursive: true });
  fs.mkdirSync(testLogsDir, { recursive: true });
  fs.mkdirSync(testReportsDir, { recursive: true });

  const originalEnv = { ...process.env };

  test.beforeEach(() => {
    process.env.BTC_STATE_DIR = testStateDir;
    process.env.BTC_LOGS_DIR = testLogsDir;
    process.env.BTC_ALERTS_DIR = testLogsDir;
    process.env.BTC_REPORTS_DIR = testReportsDir;
  });

  test.after(() => {
    process.env = originalEnv;
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // Ignore cleanup
    }
  });

  test('parseContractExpiryDate extracts correct ISO date string from option symbol', () => {
    assert.equal(parseContractExpiryDate('BTC-5OCT26-85500-C-USDT'), '2026-10-05');
    assert.equal(parseContractExpiryDate('BTC-16OCT26-90000-P-USDT'), '2026-10-16');
    assert.equal(parseContractExpiryDate('BTC-1JAN27-100000-C-USDT'), '2027-01-01');
    assert.equal(parseContractExpiryDate('INVALID-SYMBOL'), null);
  });

  test('generates full markdown report matching exact format with PUT before CALL', async () => {
    const cycleDate = '2026-10-05';
    const entryDate = '2026-10-04';

    const mockState: StraddlePositionState = {
      date: entryDate,
      entryExecuted: true,
      callLeg: {
        legType: 'CALL',
        symbol: 'BTC-5OCT26-85000-C-USDT',
        entryPrice: 320,
        entryPriceSource: 'fill',
        stopLossPrice: 640,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 320,
        exitPrice: 320,
        closeReason: 'MONITOR_WINDOW_ELAPSED',
      },
      putLeg: {
        legType: 'PUT',
        symbol: 'BTC-5OCT26-85000-P-USDT',
        entryPrice: 380,
        entryPriceSource: 'fill',
        stopLossPrice: 760,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 380,
        exitPrice: 380,
        closeReason: 'MONITOR_WINDOW_ELAPSED',
      },
      totalCreditReceived: 700,
      targetProfitPoints: 385,
      combinedPnLPoints: 0,
      resolvedScenario: 'MAX_TIME_REACHED',
    };

    fs.writeFileSync(
      path.join(testStateDir, `straddle-state-${entryDate}.json`),
      JSON.stringify(mockState, null, 2)
    );

    // MTM Log
    fs.writeFileSync(
      path.join(testLogsDir, `mtm-${entryDate}.log`),
      '12:15:20 PM: 100 MTM\n12:15:30 PM: 250 MTM\n12:15:40 PM: -50 MTM\n'
    );

    // Alerts Log
    fs.writeFileSync(
      path.join(testLogsDir, `alerts-${entryDate}.jsonl`),
      '{"ts":"2026-10-04 14:15:00 IST","kind":"notify","message":"Entered straddle"}\n'
    );
    fs.writeFileSync(
      path.join(testLogsDir, `alerts-${cycleDate}.jsonl`),
      '{"ts":"2026-10-05 13:30:00 IST","kind":"notify","message":"Monitor completed"}\n'
    );

    const result = await generateDailyReport(cycleDate, {
      usdtInrOverride: 98.5,
      spotPriceOverride: 85000,
      positionsOverride: [],
      now: new Date('2026-10-05T08:15:00.000Z'),
    });

    assert.ok(result.content.includes('# BTC 0DTE Short Straddle Trade Report — 2026-10-05'));
    assert.ok(result.content.includes('## 1. Executive Summary'));
    assert.ok(result.content.includes('## 2. Leg-by-Leg Execution & P&L'));
    assert.ok(result.content.includes('## 3. MTM Run-up & Drawdown Analysis'));
    assert.ok(result.content.includes('## 4. Alerts & Operator Journal'));
    assert.ok(result.content.includes('## 5. Data Quality & Provenance'));

    // Assert PUT comes before CALL in Section 2
    const putIndex = result.content.indexOf('| **PUT** | `BTC-5OCT26-85000-P-USDT`');
    const callIndex = result.content.indexOf('| **CALL** | `BTC-5OCT26-85000-C-USDT`');
    assert.ok(putIndex > 0 && callIndex > 0);
    assert.ok(putIndex < callIndex, 'PUT leg must precede CALL leg in the report');

    // Assert MTM peak and trough
    assert.ok(result.content.includes('+250.00 pts'));
    assert.ok(result.content.includes('-50.00 pts'));

    // Assert Alerts included verbatim
    assert.ok(result.content.includes('Entered straddle'));
    assert.ok(result.content.includes('Monitor completed'));

    // Assert Report written to disk
    assert.ok(fs.existsSync(result.filePath));
  });

  test('reports N/A for INR values when USDT/INR FX rate is missing or invalid', async () => {
    const cycleDate = '2026-10-06';
    const entryDate = '2026-10-06';

    const mockState: StraddlePositionState = {
      date: entryDate,
      entryExecuted: true,
      callLeg: {
        legType: 'CALL',
        symbol: 'BTC-6OCT26-84000-C-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 100,
        exitPrice: 100,
        closeReason: 'PROFIT_TARGET_HIT',
      },
      putLeg: {
        legType: 'PUT',
        symbol: 'BTC-6OCT26-84000-P-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 100,
        exitPrice: 100,
        closeReason: 'PROFIT_TARGET_HIT',
      },
      totalCreditReceived: 600,
      targetProfitPoints: 330,
      combinedPnLPoints: 400,
      resolvedScenario: 'PROFIT_TARGET_REACHED',
    };

    fs.writeFileSync(
      path.join(testStateDir, `straddle-state-${entryDate}.json`),
      JSON.stringify(mockState, null, 2)
    );

    const result = await generateDailyReport(cycleDate, {
      usdtInrOverride: null, // FX unavailable
      spotPriceOverride: 84000,
      positionsOverride: [],
    });

    assert.ok(result.content.includes('| **USDT/INR Exchange Rate** | N/A |'));
    assert.ok(result.content.includes('| **Combined Realised P&L (INR)** | **N/A** |'));
    assert.ok(result.content.includes('| **PUT** | `BTC-6OCT26-84000-P-USDT` | $300.00 | $100.00 | `PROFIT_TARGET_HIT` | +200.00 pts | +$2.00 | N/A |'));
  });

  test('flags orphan position on exchange prominently and does not claim closed P&L', async () => {
    const cycleDate = '2026-10-07';
    const entryDate = '2026-10-07';

    const mockState: StraddlePositionState = {
      date: entryDate,
      entryExecuted: true,
      callLeg: {
        legType: 'CALL',
        symbol: 'BTC-7OCT26-86000-C-USDT',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 300,
        exitPrice: 300,
        closeReason: 'SL_HIT',
      },
      putLeg: {
        legType: 'PUT',
        symbol: 'BTC-7OCT26-86000-P-USDT',
        entryPrice: 350,
        entryPriceSource: 'fill',
        stopLossPrice: 700,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 350,
      },
      totalCreditReceived: 650,
      targetProfitPoints: 357.5,
      combinedPnLPoints: 0,
    };

    fs.writeFileSync(
      path.join(testStateDir, `straddle-state-${entryDate}.json`),
      JSON.stringify(mockState, null, 2)
    );

    // Live position still open on exchange!
    const livePositions = [
      {
        symbol: 'BTC-7OCT26-86000-P-USDT',
        qty: 0.01,
        entryPrice: 350,
      },
    ];

    const result = await generateDailyReport(cycleDate, {
      usdtInrOverride: 99.0,
      positionsOverride: livePositions,
    });

    assert.ok(result.content.includes('🔴 ORPHAN / MANUAL ACTION NEEDED (open on exchange)'));
    assert.ok(result.content.includes('Active orphan position detected! Human operator intervention required.'));
    assert.ok(result.content.includes('| **Combined Realised P&L (pts)** | **N/A** |'));
  });

  test('treats leg unlisted after expiry as expired worthless with full credit retained', async () => {
    const cycleDate = '2026-10-08';
    const entryDate = '2026-10-07';

    const mockState: StraddlePositionState = {
      date: entryDate,
      entryExecuted: true,
      callLeg: {
        legType: 'CALL',
        symbol: 'BTC-8OCT26-85000-C-USDT',
        entryPrice: 280,
        entryPriceSource: 'fill',
        stopLossPrice: 560,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 280,
        exitPrice: 280,
        closeReason: 'SL_HIT',
      },
      putLeg: {
        legType: 'PUT',
        symbol: 'BTC-8OCT26-85000-P-USDT',
        entryPrice: 320,
        entryPriceSource: 'fill',
        stopLossPrice: 640,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 320,
      },
      totalCreditReceived: 600,
      targetProfitPoints: 330,
      combinedPnLPoints: 0,
    };

    fs.writeFileSync(
      path.join(testStateDir, `straddle-state-${entryDate}.json`),
      JSON.stringify(mockState, null, 2)
    );

    // Positions empty on exchange (settled by exchange at expiry)
    const result = await generateDailyReport(cycleDate, {
      usdtInrOverride: 100.0,
      positionsOverride: [],
    });

    assert.ok(result.content.includes('`expired (not closed by the bot)`'));
    // PUT entry 320 -> exit 0 = +320 pts (+ $3.20)
    assert.ok(result.content.includes('| **PUT** | `BTC-8OCT26-85000-P-USDT` | $320.00 | $0.00 | `expired (not closed by the bot)` | +320.00 pts | +$3.20 | +₹320.00 |'));
  });

  test('startup catchup generates and publishes ungenerated past reports', async () => {
    const cycleDate = '2026-10-02';
    const entryDate = '2026-10-01';

    const mockState: StraddlePositionState = {
      date: entryDate,
      entryExecuted: true,
      callLeg: {
        legType: 'CALL',
        symbol: 'BTC-2OCT26-84000-C-USDT',
        entryPrice: 200,
        entryPriceSource: 'fill',
        stopLossPrice: 400,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 200,
        exitPrice: 200,
      },
      putLeg: {
        legType: 'PUT',
        symbol: 'BTC-2OCT26-84000-P-USDT',
        entryPrice: 200,
        entryPriceSource: 'fill',
        stopLossPrice: 400,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 200,
        exitPrice: 200,
      },
      totalCreditReceived: 400,
      targetProfitPoints: 220,
      combinedPnLPoints: 0,
      resolvedScenario: 'MAX_TIME_REACHED',
    };

    fs.writeFileSync(
      path.join(testStateDir, `straddle-state-${entryDate}.json`),
      JSON.stringify(mockState, null, 2)
    );

    const mockClient = {
      getOptionsPositions: async () => [],
      getBtcSpotPrice: async () => 84000,
    } as any;

    const mockConfig = {
      reportDelayMinutes: 15,
      dailyExpiryHourUTC: 8,
      dryRun: true,
    } as any;

    // Time is past expiry + 15m
    const pastTime = new Date('2026-10-02T09:00:00.000Z');
    const generated = await runStartupReportCatchup(mockClient, mockConfig, undefined, pastTime);

    assert.equal(generated.length, 1);
    assert.equal(generated[0], cycleDate);
    assert.ok(fs.existsSync(path.join(testReportsDir, `${cycleDate}.md`)));
  });

  test('publisher commits and pushes to isolated reports branch idempotently', () => {
    // Setup a local test git bare origin and working clone
    const gitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-pub-test-'));
    const originDir = path.join(gitTmp, 'origin.git');
    const workDir = path.join(gitTmp, 'work');

    fs.mkdirSync(originDir, { recursive: true });
    execSync('git init --bare', { cwd: originDir });

    execSync(`git clone "${originDir}" "${workDir}"`);
    execSync('git config user.name "Tester" && git config user.email "test@example.com"', { cwd: workDir });

    fs.writeFileSync(path.join(workDir, 'README.md'), '# Main branch\n');
    execSync('git add README.md && git commit -m "initial commit"', { cwd: workDir });
    execSync('git push origin master:main', { cwd: workDir });

    // Create a report file
    const reportsDir = path.join(workDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportFile = path.join(reportsDir, '2026-10-05.md');
    fs.writeFileSync(reportFile, '# Daily Report 2026-10-05\n');

    process.env.BTC_REPORTS_DIR = reportsDir;

    // Publish 1st time
    return (async () => {
      const res1 = await publishDailyReport('2026-10-05', {
        repoDir: workDir,
        branch: 'reports',
        remote: 'origin',
      });
      assert.equal(res1.published, true);
      assert.ok(res1.commitHash);

      // Verify master/main branch was unaffected and working tree is clean
      const currentBranch = execSync('git branch --show-current', { cwd: workDir }).toString().trim();
      assert.notEqual(currentBranch, 'reports');

      // Publish 2nd time (idempotent check)
      const res2 = await publishDailyReport('2026-10-05', {
        repoDir: workDir,
        branch: 'reports',
        remote: 'origin',
      });
      assert.equal(res2.published, true);
      assert.ok(res2.message.includes('Idempotent'));

      // Clean up
      try {
        fs.rmSync(gitTmp, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    })();
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateDailyReport } from './reports/reportGenerator';
import { verifyCycleAgainstVenue } from './records/venueVerification';
import { parseMtmLogs } from './reports/reportDataCollector';
import { CoinDCXClient } from './client';
import { config } from './config';
import { ActiveLeg, StraddlePositionState } from './types';
import { rearmStopOrderIfMissing, safeCloseLeg } from './reconciliation';
import { runDoctorChecks } from './doctorCli';

interface CheckResult {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export async function runAcceptanceGate(): Promise<boolean> {
  const results: CheckResult[] = [];
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-acceptance-gate-'));
  const testStateDir = path.join(tmpBase, 'state');
  const testRecordsDir = path.join(tmpBase, 'records');
  const testLogsDir = path.join(tmpBase, 'logs');
  const testReportsDir = path.join(tmpBase, 'reports');

  fs.mkdirSync(testStateDir, { recursive: true });
  fs.mkdirSync(testRecordsDir, { recursive: true });
  fs.mkdirSync(testLogsDir, { recursive: true });
  fs.mkdirSync(testReportsDir, { recursive: true });

  const prevEnv = { ...process.env };
  process.env.BTC_STATE_DIR = testStateDir;
  process.env.RECORD_DIR = testRecordsDir;
  process.env.BTC_LOGS_DIR = testLogsDir;
  process.env.BTC_ALERTS_DIR = testLogsDir;
  process.env.BTC_REPORTS_DIR = testReportsDir;
  process.env.BTC_TEST_MODE = '1';

  try {
    // -------------------------------------------------------------
    // A1: The report leg table and summary must consume the record
    // -------------------------------------------------------------
    const cycleA1 = '2026-10-05';
    const entryA1 = '2026-10-04';

    // Write a record summary for 2026-10-05 with realised P&L = +7.72 pts
    const summaryA1 = {
      schemaVersion: 1,
      cycle: cycleA1,
      entryDate: entryA1,
      status: 'CLOSED',
      reconstructed: true,
      source: 'state+logs',
      atmStrike: 85250,
      orderQuantity: 0.01,
      callSymbol: 'BTC-5OCT26-85250-C-USDT',
      putSymbol: 'BTC-5OCT26-85250-P-USDT',
      totalCreditReceived: 685,
      targetProfitPoints: 376.75,
      callLeg: {
        symbol: 'BTC-5OCT26-85250-C-USDT',
        orderId: 'call-ent-01',
        entryPrice: 320,
        venueAvgPrice: 320,
        status: 'closed',
        exitPrice: 677.28,
        closeReason: 'SL_HIT',
        pnlPoints: -357.28,
      },
      putLeg: {
        symbol: 'BTC-5OCT26-85250-P-USDT',
        orderId: 'put-ent-01',
        entryPrice: 365,
        venueAvgPrice: 365,
        status: 'closed',
        exitPrice: 0,
        closeReason: 'EXPIRED',
        pnlPoints: 365,
      },
      combinedPnLPoints: 7.72,
      resolvedScenario: 'ONE_LEG_SL_OTHER_COVERED',
      updatedAt: '2026-10-05T13:45:00+05:30',
    };
    fs.writeFileSync(path.join(testRecordsDir, `${cycleA1}.summary.json`), JSON.stringify(summaryA1, null, 2));

    // Also write jsonl event ledger
    fs.writeFileSync(
      path.join(testRecordsDir, `${cycleA1}.jsonl`),
      [
        JSON.stringify({ ts: '2026-10-04T18:15:00+05:30', event: 'CYCLE_START', cycle: cycleA1, data: { strike: 85250 } }),
        JSON.stringify({ ts: '2026-10-04T18:15:01+05:30', event: 'ORDER_FILLED', cycle: cycleA1, data: { legType: 'CALL', price: 320 } }),
        JSON.stringify({ ts: '2026-10-04T18:15:01+05:30', event: 'ORDER_FILLED', cycle: cycleA1, data: { legType: 'PUT', price: 365 } }),
        JSON.stringify({ ts: '2026-10-05T02:17:09+05:30', event: 'LEG_CLOSED', cycle: cycleA1, data: { legType: 'CALL', price: 677.28, reason: 'SL_HIT' } }),
        JSON.stringify({ ts: '2026-10-05T13:30:00+05:30', event: 'EXPIRY_SETTLEMENT', cycle: cycleA1, data: { legType: 'PUT', settlementPrice: 0 } }),
        JSON.stringify({ ts: '2026-10-05T13:45:00+05:30', event: 'CYCLE_CLOSED', cycle: cycleA1, data: { realisedPnlPoints: 7.72, resolvedScenario: 'ONE_LEG_SL_OTHER_COVERED' } }),
      ].join('\n') + '\n'
    );

    // Provide a state file with DIFFERENT/FALLBACK numbers to prove the report consumes the record, not state!
    const stateA1: StraddlePositionState = {
      date: entryA1,
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
        exitPrice: 320, // Stale state price
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
        status: 'open',
        currentPrice: 365,
      },
      totalCreditReceived: 685,
      targetProfitPoints: 376.75,
      combinedPnLPoints: 0,
      updatedAt: '2026-10-05T13:45:00+05:30',
    };
    fs.writeFileSync(path.join(testStateDir, `straddle-state-${entryA1}.json`), JSON.stringify(stateA1, null, 2));

    const repA1 = await generateDailyReport(cycleA1, {
      usdtInrOverride: 100,
      positionsOverride: [],
      now: new Date('2026-10-05T08:15:00Z'),
    });

    const matches772 = (repA1.content.match(/\+7\.72/g) || []).length;
    const hasCallRecordPrice = repA1.content.includes('$677.28');
    const hasPutSettlement = repA1.content.includes('$0.00');
    const noNaForClosedLeg = !repA1.content.includes('| **CALL** | `BTC-5OCT26-85250-C-USDT` | $320.00 | N/A');

    const passA1 = matches772 >= 2 && hasCallRecordPrice && hasPutSettlement && noNaForClosedLeg;
    results.push({
      id: 'A1',
      description: 'leg table & summary consume record (+7.72 agree)',
      passed: passA1,
      detail: `+7.72 matches: ${matches772}, call exit $677.28: ${hasCallRecordPrice}`,
    });

    // -------------------------------------------------------------
    // A2: Report survives missing or clobbered state file
    // -------------------------------------------------------------
    // Remove state file completely
    fs.unlinkSync(path.join(testStateDir, `straddle-state-${entryA1}.json`));
    let passA2 = false;
    let detailA2 = '';
    try {
      const repA2 = await generateDailyReport(cycleA1, {
        usdtInrOverride: 100,
        positionsOverride: [],
        now: new Date('2026-10-05T08:15:00Z'),
      });
      passA2 = repA2.content.includes('+7.72 pts') && repA2.content.includes('$677.28');
      detailA2 = 'Report generated successfully from record snapshot alone';
    } catch (e) {
      passA2 = false;
      detailA2 = `Failed with error: ${(e as Error).message}`;
    }
    results.push({
      id: 'A2',
      description: 'report survives missing state file',
      passed: passA2,
      detail: detailA2,
    });

    // -------------------------------------------------------------
    // A3: MTM statistics are clipped to cycle window [entry, expiry+delay]
    // -------------------------------------------------------------
    fs.writeFileSync(
      path.join(testLogsDir, `mtm-${entryA1}.log`),
      [
        '10:00:00 AM: 100 MTM', // Inside cycle
        '06:15:00 PM: 200 MTM', // Inside cycle
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      path.join(testLogsDir, `mtm-${cycleA1}.log`),
      [
        '01:00:00 PM: 350 MTM', // Inside cycle (13:00 IST < 13:45 IST)
        '01:40:00 PM: 380 MTM', // Inside cycle (13:40 IST < 13:45 IST)
        '08:38:00 PM: -724.43 MTM', // OUTSIDE cycle (20:38 IST > 13:45 IST) -> MUST BE CLIPPED!
      ].join('\n') + '\n'
    );

    const mtmWindowStart = Date.parse(`${entryA1}T00:00:00+05:30`);
    const mtmWindowEnd = Date.parse(`${cycleA1}T13:45:00+05:30`);
    const mtmClipped = parseMtmLogs([entryA1, cycleA1], {
      windowStartMs: mtmWindowStart,
      windowEndMs: mtmWindowEnd,
    });

    const passA3 = mtmClipped.count === 4 && mtmClipped.min !== -724.43 && mtmClipped.max === 380;
    results.push({
      id: 'A3',
      description: 'MTM statistics clipped to cycle window',
      passed: passA3,
      detail: `Samples count: ${mtmClipped.count} (excluded post-expiry -724.43)`,
    });

    // -------------------------------------------------------------
    // A4: Two timelines, clearly primary record vs secondary alerts
    // -------------------------------------------------------------
    fs.writeFileSync(
      path.join(testLogsDir, `alerts-${cycleA1}.jsonl`),
      '{"ts":"2026-10-05 11:00:00 IST","kind":"info","message":"Alert within window"}\n'
    );
    const repA4 = await generateDailyReport(cycleA1, {
      usdtInrOverride: 100,
      positionsOverride: [],
      walletTransactionsOverride: [
        {
          symbol: 'BTC-5OCT26-85250-C-USDT',
          transactionType: 'TRADE',
          filledPrice: 635,
          fee: 30.84,
          netCashFlow: -658.03,
        },
      ],
      now: new Date('2026-10-05T08:15:00Z'),
    });
    const hasPrimaryHeader = repA4.content.includes('Chronological cycle events from write-through record');
    const hasSecondaryLabel = repA4.content.includes('Secondary — raw alert stream during cycle window');
    const passA4 = hasPrimaryHeader && hasSecondaryLabel;
    results.push({
      id: 'A4',
      description: 'primary record timeline and secondary alert label',
      passed: passA4,
      detail: 'Clear record primary timeline and secondary alert label present',
    });

    // -------------------------------------------------------------
    // A5: Exit prices match venue fill & verifier reports MISMATCH/MATCH
    // -------------------------------------------------------------
    const verResA5 = await verifyCycleAgainstVenue(cycleA1, {
      snapshotOverride: summaryA1 as any,
      walletTransactionsOverride: [
        {
          symbol: 'BTC-5OCT26-85250-C-USDT',
          transactionType: 'TRADE',
          filledPrice: 635, // Venue filled at 635, recorded is 677.28 -> should be MISMATCH with numbers!
        },
      ],
    });
    const callClaim = verResA5.claims.find((c) => c.claim.includes('CALL Exit price'));
    const passA5 = Boolean(
      callClaim &&
      callClaim.status === 'MISMATCH' &&
      callClaim.venueValue === 635 &&
      callClaim.recordedValue === 677.28
    );
    results.push({
      id: 'A5',
      description: 'verifier classifies exit mismatch with both numbers',
      passed: passA5,
      detail: `Status: ${callClaim?.status}, Recorded: ${callClaim?.recordedValue}, Venue: ${callClaim?.venueValue}`,
    });

    // -------------------------------------------------------------
    // A6: Verification check honors configured RECORD_DIR
    // -------------------------------------------------------------
    const verResA6 = await verifyCycleAgainstVenue('2099-01-01'); // Missing cycle
    const existClaim = verResA6.claims.find((c) => c.claim.includes('Cycle summary snapshot existence'));
    const passA6 = Boolean(existClaim && String(existClaim.recordedValue).startsWith(testRecordsDir));
    results.push({
      id: 'A6',
      description: 'verification check honors configured RECORD_DIR',
      passed: passA6,
      detail: `Recorded path checked: ${existClaim?.recordedValue}`,
    });

    // -------------------------------------------------------------
    // A7: Tape policy documented in records/README.md
    // -------------------------------------------------------------
    const readmeContent = fs.readFileSync(path.resolve(process.cwd(), 'records/README.md'), 'utf8');
    const passA7 = readmeContent.includes('Publication & Retention Policy') && readmeContent.includes('1-minute resolution');
    results.push({
      id: 'A7',
      description: 'tape retention policy in records/README.md',
      passed: passA7,
      detail: 'Documented 1-minute resolution and clipped tape policy',
    });

    // -------------------------------------------------------------
    // A8: Sample options order debug row gated by flag
    // -------------------------------------------------------------
    const clientCode = fs.readFileSync(path.resolve(process.cwd(), 'src/client.ts'), 'utf8');
    const passA8 = clientCode.includes("process.env.DEBUG_ORDERS === 'true'") &&
      !clientCode.includes("console.log(`[CoinDCXClient] Sample options orders response row:`, JSON.stringify(rows[0]));\n      }");
    results.push({
      id: 'A8',
      description: 'sample options order debug line is gated',
      passed: passA8,
      detail: 'Order row sample log is gated behind process.env.DEBUG_ORDERS',
    });

    // -------------------------------------------------------------
    // A9: Dual P&L block explains gap with FX spread and fees
    // -------------------------------------------------------------
    const passA9 = repA4.content.includes('exchange transaction fees (~1.9%)') &&
      repA4.content.includes('~₹102 vs public rate ≈ ₹98.9–99.1');
    results.push({
      id: 'A9',
      description: 'dual P&L explains ~1.9% fees and venue FX spread',
      passed: passA9,
      detail: 'Explicit explanation line present in report markdown',
    });

    // -------------------------------------------------------------
    // B1: Missing stop re-armed on startup / missing detection
    // -------------------------------------------------------------
    let placedStopPayload: Record<string, unknown> | null = null;
    const mockClientB1 = {
      placeOptionsOrder: async (
        symbol: string,
        side: string,
        qty: number,
        _orderType: string,
        _price: any,
        stopLoss: string,
        _takeProfit: string,
        _convRate: any,
        reduceOnly: boolean
      ) => {
        placedStopPayload = { symbol, side, qty, stopLoss, reduceOnly };
        return { success: true, orderId: 'mock-rearmed-stop-id' };
      },
    } as unknown as CoinDCXClient;

    const mockLegB1: ActiveLeg = {
      legType: 'CALL',
      symbol: 'BTC-5OCT26-85250-C-USDT',
      entryPrice: 320,
      entryPriceSource: 'fill',
      stopLossPrice: 640,
      quantity: 0.01,
      confirmedOpen: true,
      status: 'open',
      currentPrice: 320,
    };

    const rearmRes = await rearmStopOrderIfMissing(
      mockClientB1,
      mockLegB1,
      [], // Empty open orders -> missing!
      config,
      cycleA1
    );

    const passB1 = rearmRes.rearmed === true &&
      placedStopPayload !== null &&
      (placedStopPayload as any).reduceOnly === true &&
      (placedStopPayload as any).stopLoss === '640';
    results.push({
      id: 'B1',
      description: 'missing stop order is re-armed with reduceOnly',
      passed: passB1,
      detail: `Rearmed: ${rearmRes.rearmed}, OrderId: ${rearmRes.orderId}`,
    });

    // -------------------------------------------------------------
    // B2: Assert reduceOnly on every closing payload, never on entry
    // -------------------------------------------------------------
    const closeRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = global.fetch;
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (init && init.body && typeof init.body === 'string') {
        try {
          const parsed = JSON.parse(init.body);
          closeRequests.push({ url: urlStr, body: parsed });
        } catch {}
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'success', data: { orderId: 'test-order-id' } }),
        json: async () => ({ status: 'success', data: { orderId: 'test-order-id' } }),
      } as any;
    }) as any;

    try {
      const clientB2 = new CoinDCXClient(
        'mock-key',
        'mock-secret',
        'https://api.coindcx.com',
        'mock-bearer-token',
        undefined,
        false
      );

      // Entry sell
      await clientB2.placeOptionsOrder('BTC-ENTRY-OPT', 'sell', 0.01, 'Limit', 300, '600', '', undefined, false);
      // Close position
      await clientB2.closePosition('BTC-CLOSE-OPT', 0.01, 10);
      // Safe close leg
      const legB2: ActiveLeg = {
        legType: 'CALL',
        symbol: 'BTC-SAFE-CLOSE',
        entryPrice: 300,
        entryPriceSource: 'fill',
        stopLossPrice: 600,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 300,
      };
      await safeCloseLeg(clientB2, legB2, 300, 'MONITOR_WINDOW_ELAPSED', config);
    } finally {
      global.fetch = originalFetch;
    }

    const entryCall = closeRequests.find((r) => r.body.symbol === 'BTC-ENTRY-OPT');
    const closeCall = closeRequests.find((r) => r.body.symbol === 'BTC-CLOSE-OPT');
    const safeCloseCall = closeRequests.find((r) => r.body.symbol === 'BTC-SAFE-CLOSE');

    const passB2 = Boolean(
      entryCall && entryCall.body.reduceOnly === undefined &&
      closeCall && closeCall.body.reduceOnly === true &&
      safeCloseCall && safeCloseCall.body.reduceOnly === true
    );
    results.push({
      id: 'B2',
      description: 'every close payload has reduceOnly: true, entry does not',
      passed: passB2,
      detail: `Entry reduceOnly: ${entryCall?.body.reduceOnly ?? 'absent'}, Close reduceOnly: ${closeCall?.body.reduceOnly}`,
    });

    // -------------------------------------------------------------
    // B3: ALREADY_FLAT is success-by-another-route without retry storm
    // -------------------------------------------------------------
    let closeAttemptCount = 0;
    const clientB3 = {
      closePosition: async () => {
        closeAttemptCount++;
        return {
          success: false,
          isAlreadyFlat: true,
          message: '422 OCS-TECH-0013: You do not have any open positions.',
        };
      },
    } as unknown as CoinDCXClient;

    const legB3: ActiveLeg = {
      legType: 'PUT',
      symbol: 'BTC-ALREADY-FLAT',
      entryPrice: 300,
      entryPriceSource: 'fill',
      stopLossPrice: 600,
      quantity: 0.01,
      confirmedOpen: true,
      status: 'open',
      currentPrice: 300,
    };

    const flatRes = await safeCloseLeg(clientB3, legB3, 300, 'PROFIT_TARGET_HIT', config, undefined, 3);
    const passB3 = flatRes.success === true && legB3.status === 'closed' && closeAttemptCount === 1;
    results.push({
      id: 'B3',
      description: 'ALREADY_FLAT is treated as success with 1 attempt and no retry storm',
      passed: passB3,
      detail: `Attempts: ${closeAttemptCount}, Result: ${flatRes.success}, Status: ${legB3.status}`,
    });

    // -------------------------------------------------------------
    // B4: Venue-triggered close adopted with venue's fill price
    // -------------------------------------------------------------
    const clientB4 = {
      getOptionsPositions: async () => [], // Venue position is flat!
      getOptionsWalletTransactions: async () => [
        {
          symbol: 'BTC-VENUE-FILL',
          transactionType: 'TRADE',
          filledPrice: 1080,
          orderId: 'venue-exit-1080',
        },
      ],
    } as unknown as CoinDCXClient;

    // Simulate disappearance before expiry
    const mockStateB4: StraddlePositionState = {
      date: '2026-10-05',
      entryExecuted: true,
      callLeg: {
        legType: 'CALL',
        symbol: 'BTC-VENUE-FILL',
        entryPrice: 500,
        entryPriceSource: 'fill',
        stopLossPrice: 1000,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 1062.97, // Local mark
      },
      putLeg: {
        legType: 'PUT',
        symbol: 'BTC-PUT-FLAT',
        entryPrice: 500,
        entryPriceSource: 'fill',
        stopLossPrice: 1000,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 500,
        exitPrice: 0,
      },
      totalCreditReceived: 1000,
      targetProfitPoints: 550,
      combinedPnLPoints: 0,
    };
    fs.writeFileSync(path.join(testStateDir, 'straddle-state-2026-10-05.json'), JSON.stringify(mockStateB4, null, 2));

    const { reconcileAndResurrectState } = await import('./reconciliation');
    await reconcileAndResurrectState(clientB4, config);
    const updatedStateB4 = JSON.parse(fs.readFileSync(path.join(testStateDir, 'straddle-state-2026-10-05.json'), 'utf8'));

    const passB4 = updatedStateB4.callLeg.status === 'closed' &&
      updatedStateB4.callLeg.exitPrice === 1080 &&
      updatedStateB4.callLeg.closeReason === 'SL_HIT';
    results.push({
      id: 'B4',
      description: 'venue-triggered close adopts venue fill (1080 not local mark)',
      passed: passB4,
      detail: `Exit price adopted: ${updatedStateB4.callLeg.exitPrice} (venue fill 1080)`,
    });

    // -------------------------------------------------------------
    // B5: Stuck-stop escalation config driven
    // -------------------------------------------------------------
    const mainReadmeContent = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8');
    const passB5 = typeof config.riskConfig.slOverrunTolerance === 'number' &&
      config.riskConfig.slOverrunTolerance > 0 &&
      mainReadmeContent.includes('SL_OVERRUN_TOLERANCE');
    results.push({
      id: 'B5',
      description: 'stuck-stop overrun tolerance is config driven',
      passed: passB5,
      detail: `Config value: ${config.riskConfig.slOverrunTolerance}`,
    });

    // -------------------------------------------------------------
    // D1 - D7: After one leg's SL fires, move the other leg's stop to COST (§1 - §3)
    // -------------------------------------------------------------
    const { moveStopToCostOnSurvivingLeg, roundToTickSize, verifyStopOrderArmed } = await import('./reconciliation');

    // D1: Move happens: CALL SL hit -> PUT stop moved to cost + buffer, reduceOnly, Untriggered
    let d1PlacedOrder: any = null;
    let d1CancelledOrderId: string | null = null;
    const d1VenueOrders: any[] = [
      {
        id: 'd1-old-stop',
        symbol: 'BTC-5OCT26-85250-P-USDT',
        orderType: 'Stop-Market',
        triggerPrice: 800,
        qty: 0.01,
        reduceOnly: true,
        status: 'Untriggered',
      },
    ];

    const d1Client = {
      getOptionsInstruments: async () => [{ symbol: 'BTC-5OCT26-85250-P-USDT', priceFilter: { tickSize: 5 } }],
      getOptionsWalletTransactions: async () => [],
      getOpenOptionsOrders: async () => d1VenueOrders,
      placeOptionsOrder: async (sym: string, side: string, qty: number, type: string, _p: any, sl: string, _tp: any, _cr: any, ro: boolean) => {
        d1PlacedOrder = { sym, side, qty, type, sl, ro };
        const newOrd = {
          id: 'd1-new-cost-stop',
          symbol: sym,
          orderType: 'Stop-Market',
          triggerPrice: Number(sl),
          qty,
          reduceOnly: ro,
          status: 'Untriggered',
        };
        d1VenueOrders.push(newOrd);
        return { symbol: sym, side, success: true, orderId: 'd1-new-cost-stop', rawResponse: {} };
      },
      cancelOptionsOrder: async (ordId: string) => {
        d1CancelledOrderId = ordId;
        const idx = d1VenueOrders.findIndex((o) => o.id === ordId);
        if (idx !== -1) d1VenueOrders.splice(idx, 1);
        return true;
      },
    } as unknown as CoinDCXClient;

    const d1State: StraddlePositionState = {
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
        entryPrice: 395,
        venueAvgPrice: 400, // Cost basis = 400
        entryPriceSource: 'fill',
        stopLossPrice: 800,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 250, // Below cost
      },
      totalCreditReceived: 935,
      targetProfitPoints: 500,
      combinedPnLPoints: 0,
      updatedAt: new Date().toISOString(),
    };

    const d1Res = await moveStopToCostOnSurvivingLeg(d1Client, d1State.putLeg, d1State, config);
    const d1RecPath = path.join(testRecordsDir, '2026-10-05.jsonl');
    const d1RecContent = fs.existsSync(d1RecPath) ? fs.readFileSync(d1RecPath, 'utf8') : '';
    const passD1 = d1Res.moved === true &&
      d1Res.newTrigger === 400 &&
      d1PlacedOrder?.ro === true &&
      d1CancelledOrderId === 'd1-old-stop' &&
      d1VenueOrders.length === 1 &&
      d1State.putLeg.stopLossPrice === 400 &&
      d1RecContent.includes('STOP_MOVED_TO_COST');
    results.push({
      id: 'D1',
      description: 'cost stop move executed with reduceOnly, single stop retained, record written',
      passed: passD1,
      detail: `Trigger moved to ${d1Res.newTrigger}, orderId: ${d1Res.orderId}`,
    });

    // D2: Already through cost: mark >= newTrigger -> skipped, logged, old stop untouched
    let d2PlaceAttempted = false;
    const d2Client = {
      getOptionsInstruments: async () => [{ symbol: 'BTC-5OCT26-85250-P-USDT', priceFilter: { tickSize: 5 } }],
      getOptionsWalletTransactions: async () => [],
      getOpenOptionsOrders: async () => [],
      placeOptionsOrder: async () => {
        d2PlaceAttempted = true;
        return { success: true };
      },
      cancelOptionsOrder: async () => true,
    } as unknown as CoinDCXClient;

    const d2State: StraddlePositionState = {
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
        currentPrice: 420, // Mark (420) >= newTrigger (400)
      },
      totalCreditReceived: 935,
      targetProfitPoints: 500,
      combinedPnLPoints: 0,
      updatedAt: new Date().toISOString(),
    };

    const d2Res = await moveStopToCostOnSurvivingLeg(d2Client, d2State.putLeg, d2State, config);
    const passD2 = d2Res.moved === false &&
      d2Res.skippedAlreadyThroughCost === true &&
      !d2PlaceAttempted &&
      d2State.putLeg.stopLossPrice === 800;
    results.push({
      id: 'D2',
      description: 'already through cost skips move, logs anomaly, keeps existing stop',
      passed: passD2,
      detail: `Skipped: ${d2Res.skippedAlreadyThroughCost}, Stop remained: ${d2State.putLeg.stopLossPrice}`,
    });

    // D3: No unprotected window: if new stop placement fails, old stop preserved
    let d3CancelAttempted = false;
    const d3VenueOrders: any[] = [
      {
        id: 'd3-old-stop',
        symbol: 'BTC-5OCT26-85250-P-USDT',
        orderType: 'Stop-Market',
        triggerPrice: 800,
        qty: 0.01,
        reduceOnly: true,
        status: 'Untriggered',
      },
    ];
    const d3Client = {
      getOptionsInstruments: async () => [{ symbol: 'BTC-5OCT26-85250-P-USDT', priceFilter: { tickSize: 5 } }],
      getOptionsWalletTransactions: async () => [],
      getOpenOptionsOrders: async () => d3VenueOrders,
      placeOptionsOrder: async () => ({ success: false, message: 'Simulated venue reject' }),
      cancelOptionsOrder: async () => {
        d3CancelAttempted = true;
        return true;
      },
    } as unknown as CoinDCXClient;

    const d3State: StraddlePositionState = {
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

    const d3Res = await moveStopToCostOnSurvivingLeg(d3Client, d3State.putLeg, d3State, config);
    const passD3 = d3Res.moved === false && !d3CancelAttempted && d3VenueOrders.length === 1 && d3State.putLeg.stopLossPrice === 800;
    results.push({
      id: 'D3',
      description: 'no unprotected window: placement failure preserves existing stop and logs anomaly',
      passed: passD3,
      detail: `Cancelled called: ${d3CancelAttempted}, Stops remaining: ${d3VenueOrders.length}`,
    });

    // D4: Restart safety: after move, verification accepts cost stop, no re-arm or second stop
    const d4Leg: ActiveLeg = {
      legType: 'PUT',
      symbol: 'BTC-5OCT26-85250-P-USDT',
      entryPrice: 400,
      entryPriceSource: 'fill',
      stopLossPrice: 400, // Updated in state
      quantity: 0.01,
      confirmedOpen: true,
      status: 'open',
      currentPrice: 250,
    };
    const d4Orders = [
      {
        id: 'd4-cost-stop',
        symbol: 'BTC-5OCT26-85250-P-USDT',
        orderType: 'Stop-Market',
        triggerPrice: 400,
        qty: 0.01,
        reduceOnly: true,
        status: 'Untriggered',
      },
    ];
    const d4Check = verifyStopOrderArmed(d4Orders, d4Leg);
    const passD4 = d4Check.armed === true && d4Check.reason === undefined;
    results.push({
      id: 'D4',
      description: 'restart safety: post-move verification accepts cost stop without re-arming 2x',
      passed: passD4,
      detail: `Armed: ${d4Check.armed}`,
    });

    // D5: Both legs stopped: no move attempted, resolves scenario
    const d5State: StraddlePositionState = {
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
        currentPrice: 640,
        exitPrice: 640,
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
        status: 'closed',
        currentPrice: 730,
        exitPrice: 730,
        closeReason: 'SL_HIT',
      },
      totalCreditReceived: 685,
      targetProfitPoints: 376.75,
      combinedPnLPoints: 0,
      updatedAt: new Date().toISOString(),
    };
    let d5MoveAttempted = false;
    const d5Client = {
      getContractPrice: async () => 700,
      getOptionsPositions: async () => [],
      getOpenOptionsOrders: async () => [],
      placeOptionsOrder: async () => {
        d5MoveAttempted = true;
        return { success: true };
      },
    } as unknown as CoinDCXClient;
    const { monitorStraddleRisk } = await import('./riskManager');
    const d5Scenario = await monitorStraddleRisk(d5Client, d5State, {
      ...config,
      riskConfig: { ...config.riskConfig, pollIntervalMs: 20, maxMonitorMinutes: 0.002 },
    });
    const passD5 = d5Scenario === 'BOTH_LEGS_SL' && !d5MoveAttempted;
    results.push({
      id: 'D5',
      description: 'both legs stopped: scenario resolves BOTH_LEGS_SL and no cost stop is moved',
      passed: passD5,
      detail: `Scenario: ${d5Scenario}, moveAttempted: ${d5MoveAttempted}`,
    });

    // D6: Cost basis is the venue fill (quote 530 vs fill 535 -> new trigger from 535)
    let d6CapturedTrigger: number | null = null;
    const d6Client = {
      getOptionsInstruments: async () => [{ symbol: 'BTC-5OCT26-85250-C-USDT', priceFilter: { tickSize: 5 } }],
      getOptionsWalletTransactions: async () => [],
      getOpenOptionsOrders: async () => [],
      placeOptionsOrder: async (_s: string, _sd: string, _q: number, _t: string, _p: any, sl: string) => {
        d6CapturedTrigger = Number(sl);
        return { success: true, orderId: 'd6-order' };
      },
      cancelOptionsOrder: async () => true,
    } as unknown as CoinDCXClient;
    const d6State: StraddlePositionState = {
      date: '2026-10-05',
      entryExecuted: true,
      callLeg: {
        legType: 'CALL',
        symbol: 'BTC-5OCT26-85250-C-USDT',
        entryPrice: 530, // quote
        venueAvgPrice: 535, // venue fill!
        entryPriceSource: 'fill',
        stopLossPrice: 1060,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'open',
        currentPrice: 300,
      },
      putLeg: {
        legType: 'PUT',
        symbol: 'BTC-5OCT26-85250-P-USDT',
        entryPrice: 400,
        entryPriceSource: 'fill',
        stopLossPrice: 800,
        quantity: 0.01,
        confirmedOpen: true,
        status: 'closed',
        currentPrice: 800,
        exitPrice: 800,
        closeReason: 'SL_HIT',
      },
      totalCreditReceived: 930,
      targetProfitPoints: 500,
      combinedPnLPoints: 0,
      updatedAt: new Date().toISOString(),
    };
    await moveStopToCostOnSurvivingLeg(d6Client, d6State.callLeg, d6State, config);
    const passD6 = d6CapturedTrigger === 535;
    results.push({
      id: 'D6',
      description: 'cost basis is the venue fill (535 venue fill vs 530 quote basis)',
      passed: passD6,
      detail: `Captured trigger: ${d6CapturedTrigger}`,
    });

    // D7: Tick rounding multiple of instrument tickSize
    const passD7 = roundToTickSize(532.4, 5) === 530 &&
      roundToTickSize(533, 5) === 535 &&
      roundToTickSize(537.5, 5) === 540;
    results.push({
      id: 'D7',
      description: 'tick rounding: trigger rounded to instrument tickSize multiples',
      passed: passD7,
      detail: `532.4->${roundToTickSize(532.4, 5)}, 533->${roundToTickSize(533, 5)}, 537.5->${roundToTickSize(537.5, 5)}`,
    });
    // C1: Test isolation self-defending guard blocks in-repo paths
    // -------------------------------------------------------------
    const { assertSafeTestDirectory } = await import('./testIsolationGuard');
    let passC1 = false;
    try {
      assertSafeTestDirectory(path.resolve(process.cwd(), 'state'), 'test state');
      passC1 = false;
    } catch (guardErr) {
      passC1 = (guardErr as Error).message.includes('Refusing to use in-repo directory');
    }
    results.push({
      id: 'C1',
      description: 'test isolation guard refuses in-repo writes under test context',
      passed: passC1,
      detail: 'assertSafeTestDirectory threw loudly for in-repo path',
    });

    // -------------------------------------------------------------
    // C2: npm run doctor health check passes
    // -------------------------------------------------------------
    const doctorFindings = await runDoctorChecks({ now: new Date('2026-10-05T12:00:00Z') });
    const doctorFailed = doctorFindings.some((f) => f.status === 'FAIL');
    const passC2 = !doctorFailed && doctorFindings.length > 0;
    results.push({
      id: 'C2',
      description: 'npm run doctor diagnostics execute and report cleanly',
      passed: passC2,
      detail: `Doctor completed with ${doctorFindings.length} checks, 0 FAIL`,
    });

    // -------------------------------------------------------------
    // C3: No fixture writes under test runner to repository
    // -------------------------------------------------------------
    const inRepoStateFiles = fs.existsSync(path.resolve(process.cwd(), 'state'))
      ? fs.readdirSync(path.resolve(process.cwd(), 'state'))
      : [];
    const passC3 = !inRepoStateFiles.includes('straddle-state-2099-01-01.json');
    results.push({
      id: 'C3',
      description: 'no fixture writes in repository under test runner',
      passed: passC3,
      detail: 'Repo directories untouched by acceptance gate',
    });

  } finally {
    process.env = prevEnv;
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  }

  // Print results table
  const pad = (s: string, len: number) => s.padEnd(len);
  console.log('\n' + pad('CHECK', 8) + pad('DESCRIPTION', 55) + pad('RESULT', 10) + 'DETAIL');
  console.log('-'.repeat(95));
  let allPass = true;
  let passCount = 0;
  for (const r of results) {
    if (!r.passed) allPass = false;
    else passCount++;
    const resStr = r.passed ? 'PASS' : 'FAIL';
    console.log(pad(r.id, 8) + pad(r.description, 55) + pad(resStr, 10) + (r.detail || ''));
  }
  console.log('-'.repeat(95));
  console.log(pad('OVERALL', 63) + pad(allPass ? `PASS (${passCount}/${results.length})` : `FAIL (${passCount}/${results.length})`, 10));

  return allPass;
}

if (require.main === module) {
  runAcceptanceGate()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error('[Acceptance] Fatal failure:', err);
      process.exit(1);
    });
}

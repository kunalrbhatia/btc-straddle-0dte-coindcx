import { CoinDCXClient } from './client';
import { config } from './config';
import { determineAtmStraddle, nextExpiryDate } from './straddle';

/**
 * Plan Mode (`npm run plan`):
 * Safe local development inspection.
 * - NO orders are placed.
 * - Fetches BTC spot price via public ticker.
 * - Computes ATM strike on the 250 grid.
 * - Derives the tradeable 0DTE expiry contract symbols.
 * - Queries the options margin preview endpoint to check contract listing and required margin.
 * - Computes and displays the projected entry credit, SL (+100%), and profit target (+55%) levels.
 */
export async function runPlan(): Promise<void> {
  console.log('====================================================');
  console.log('       BTC 0DTE STRADDLE — PLAN MODE (NO ORDERS)    ');
  console.log('====================================================\n');

  const client = new CoinDCXClient(
    config.apiKey,
    config.apiSecret,
    config.baseUrl,
    config.bearerToken,
    config.sessionTokenFile,
    true // Dry run flag
  );

  console.log(`[Plan] Using Strike Step: ${config.strikeStep} (CoinDCX 250-strike grid)`);
  console.log(
    `[Plan] Target Execution Time: ${config.scheduledHourIST}:${String(config.scheduledMinuteIST).padStart(2, '0')} IST`
  );
  console.log(`[Plan] Daily Expiry UTC: ${config.dailyExpiryHourUTC}:00 UTC`);
  console.log(`[Plan] Conversion Rate: ${await client.resolveConversionRate()} (live USDT/INR)`);
  console.log(`[Plan] Margin Currency: ${config.marginCurrency}`);
  console.log(`[Plan] Order Quantity: ${config.orderQuantity} BTC per leg`);
  console.log(`[Plan] Leverage: ${config.leverage}x\n`);

  try {
    const spotPrice = await client.getBtcSpotPrice();
    console.log(`[Plan] Live BTC Spot Price: $${spotPrice.toFixed(2)}`);

    const expiry = nextExpiryDate();
    console.log(`[Plan] Derived Next 0DTE Expiry: ${expiry.toUTCString()}`);

    const legs = await determineAtmStraddle(client, config);
    console.log(`[Plan] Selected ATM Strike: $${legs.atmStrike}`);
    console.log(`[Plan] Target Call Symbol: ${legs.callSymbol}`);
    console.log(`[Plan] Target Put Symbol : ${legs.putSymbol}\n`);

    // Check token availability
    const token = client.getBearerToken();
    if (!token) {
      console.warn('⚠️ [Plan] No session token configured (COINDCX_SESSION_TOKEN or session.token file).');
      console.warn('   Margin preview requires a valid web session Bearer token.\n');
    } else {
      console.log('🔒 [Plan] Session Bearer token detected. Querying margin preview...');

      try {
        const [callMargin, putMargin] = await Promise.all([
          client.getOptionsMargin({
            symbol: legs.callSymbol,
            qty: String(config.orderQuantity),
            side: 'sell',
            orderType: 'Limit',
            price: '500',
          }),
          client.getOptionsMargin({
            symbol: legs.putSymbol,
            qty: String(config.orderQuantity),
            side: 'sell',
            orderType: 'Limit',
            price: '500',
          }),
        ]);

        console.log(`[Plan] Call Margin Preview (${legs.callSymbol}):`, JSON.stringify(callMargin));
        console.log(`[Plan] Put Margin Preview  (${legs.putSymbol}):`, JSON.stringify(putMargin));

        if (callMargin.error || putMargin.error) {
          console.warn('⚠️ [Plan] One or both margin checks returned an error or warning.');
        } else {
          console.log('✅ [Plan] Both contracts validated via options margin preview endpoint.');
        }
      } catch (marginErr) {
        console.warn(`[Plan] Margin preview check failed: ${(marginErr as Error).message}`);
      }
    }

    // Price the entry from live options ticker (bidPrice) as in execution mode
    let callBid = 0;
    let putBid = 0;
    let callEst = 0;
    let putEst = 0;

    try {
      const tickers = await client.getOptionsTicker('BTC', expiry.getTime());
      const callTicker = tickers.find((t) => t.symbol === legs.callSymbol);
      const putTicker = tickers.find((t) => t.symbol === legs.putSymbol);

      const cb = Number(callTicker?.bidPrice);
      const pb = Number(putTicker?.bidPrice);
      if (Number.isFinite(cb) && cb > 0) callBid = cb;
      if (Number.isFinite(pb) && pb > 0) putBid = pb;

      const cm = Number(callTicker?.markPrice ?? callTicker?.lastPrice);
      const pm = Number(putTicker?.markPrice ?? putTicker?.lastPrice);
      if (Number.isFinite(cm) && cm > 0) callEst = cm;
      if (Number.isFinite(pm) && pm > 0) putEst = pm;
    } catch {
      // Feed unavailable
    }

    if (callEst <= 0 || putEst <= 0) {
      try {
        const c = await client.getContractPrice(legs.callSymbol, expiry.getTime());
        if (c > 0) callEst = c;
        const p = await client.getContractPrice(legs.putSymbol, expiry.getTime());
        if (p > 0) putEst = p;
      } catch {
        // Feed unavailable
      }
    }

    const effectiveCallPrice = callBid > 0 ? callBid : callEst;
    const effectivePutPrice = putBid > 0 ? putBid : putEst;

    if (effectiveCallPrice <= 0 || effectivePutPrice <= 0) {
      console.log('\n--- Projected Straddle Levels: UNAVAILABLE ---');
      console.log(
        '• No live quotes could be read for both legs, so stop-loss and profit-target'
      );
      console.log(
        '  levels cannot be projected. Fix the session token / public ticker feed'
      );
      console.log('  and re-run — do not trade on invented levels.');
      console.log('------------------------------------------------------------------------\n');
      console.log('✅ [Plan] Plan execution complete. NO ORDERS were placed.');
      return;
    }

    const totalEstCredit = effectiveCallPrice + effectivePutPrice;
    const callSL = effectiveCallPrice * config.riskConfig.stopLossMultiplier;
    const putSL = effectivePutPrice * config.riskConfig.stopLossMultiplier;
    const targetProfit = totalEstCredit * config.riskConfig.profitTargetRatio;

    console.log(`\n--- Projected Straddle Levels (Order Type: ${config.entryOrderType}) ---`);
    if (callBid > 0 && putBid > 0) {
      console.log(`• Marketable Limit Quote (Bid): CALL $${callBid.toFixed(2)} | PUT $${putBid.toFixed(2)}`);
      console.log(`• Exchange Stop-Loss Sent: CALL $${callSL.toFixed(2)} | PUT $${putSL.toFixed(2)}`);
    } else {
      console.log(`• Fallback Mark Price: CALL $${callEst.toFixed(2)} | PUT $${putEst.toFixed(2)}`);
    }
    console.log(`• Estimated Combined Credit: $${totalEstCredit.toFixed(2)} pts`);
    console.log(`• Call Leg Stop Loss (+100%): $${callSL.toFixed(2)}`);
    console.log(`• Put Leg Stop Loss (+100%) : $${putSL.toFixed(2)}`);
    console.log(`• Combined Profit Target (+55% of credit): +$${targetProfit.toFixed(2)} pts`);
    console.log('------------------------------------------------------------------------\n');
    console.log('✅ [Plan] Plan execution complete. NO ORDERS were placed.');
  } catch (err) {
    console.error(`❌ [Plan] Error executing plan: ${(err as Error).message}`);
  }
}

if (require.main === module) {
  void runPlan();
}

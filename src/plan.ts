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
  console.log(`[Plan] Target Execution Time: ${config.scheduledHourIST}:${String(config.scheduledMinuteIST).padStart(2, '0')} IST`);
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

    // SL and PT calculation based on estimated/sample premium (e.g. 500 pts each or live mark)
    let callEst = 350;
    let putEst = 350;
    try {
      const c = await client.getContractPrice(legs.callSymbol);
      if (c > 0) callEst = c;
      const p = await client.getContractPrice(legs.putSymbol);
      if (p > 0) putEst = p;
    } catch {
      // Keep illustrative defaults if token is expired or feed unavailable
    }

    const totalEstCredit = callEst + putEst;
    const callSL = callEst * config.riskConfig.stopLossMultiplier;
    const putSL = putEst * config.riskConfig.stopLossMultiplier;
    const targetProfit = totalEstCredit * config.riskConfig.profitTargetRatio;

    console.log('\n--- Projected Straddle Levels (Mark: $' + callEst + ' / $' + putEst + ') ---');
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

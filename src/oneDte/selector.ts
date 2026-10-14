import { CoinDCXClient } from '../client';
import { OptionsTickerItem } from '../types';
import { OneDteConfig } from './config';

export interface SelectedOneDteContracts {
  readonly expiryTimeMs: number;
  readonly call: {
    readonly symbol: string;
    readonly strikePrice: number;
    readonly premium: number;
  };
  readonly put: {
    readonly symbol: string;
    readonly strikePrice: number;
    readonly premium: number;
  };
}

/**
 * Discovers the 1 DTE expiry and selects Call and Put options with premiums in [minPremium, maxPremium].
 *
 * Algorithm:
 * 1. Fetch active BTC options instruments.
 * 2. Sort distinct future expiries chronologically:
 *    - expiries[0] is 0 DTE (expiring in < 24h)
 *    - expiries[1] is 1 DTE (expiring next cycle, ~38-40h from 10:45 PM IST)
 * 3. Query public ticker for expiries[1].
 * 4. Filter calls and puts with price in [minPremium, maxPremium].
 *    Priority price = markPrice || lastPrice || ltp || askPrice || bidPrice.
 * 5. Pick the option closest to the midpoint of [minPremium, maxPremium] (default $125).
 *    If none strictly in range, fallback to closest available premium to the range.
 */
export async function selectOneDteContracts(
  client: CoinDCXClient,
  config: OneDteConfig
): Promise<SelectedOneDteContracts | null> {
  const instruments = await client.getOptionsInstruments('BTC');
  const nowMs = Date.now();
  // Filter active instruments with at least 12 hours remaining
  const valid = instruments.filter((inst) => {
    if (!inst.isActive) return false;
    const expMs = Number(inst.expiryTime);
    return Number.isFinite(expMs) && expMs >= nowMs + 12 * 60 * 60 * 1000;
  });

  const distinctExpiries = Array.from(new Set(valid.map((i) => Number(i.expiryTime)))).sort((a, b) => a - b);
  if (distinctExpiries.length < 2) {
    console.error(`[1DTE Discovery] Not enough future expiries found (found ${distinctExpiries.length}, need >= 2 for 1 DTE).`);
    return null;
  }

  // 1 DTE expiry is the second earliest future expiry
  const targetExpiryMs = distinctExpiries[1];
  const expiryDate = new Date(targetExpiryMs);
  console.log(`[1DTE Discovery] Target 1 DTE expiry: ${targetExpiryMs} (${expiryDate.toISOString()})`);

  // Fetch tickers for target expiry
  const tickers = await client.getOptionsTicker('BTC', targetExpiryMs);
  if (tickers.length === 0) {
    console.error(`[1DTE Discovery] No ticker data returned for expiry ${targetExpiryMs}.`);
    return null;
  }

  const targetMid = (config.minPremium + config.maxPremium) / 2;

  function extractPrice(t: OptionsTickerItem): number {
    if (config.premiumSource === 'bid') {
      const val = Number(t.bidPrice);
      return Number.isFinite(val) && val > 0 ? val : 0;
    }
    const raw = t.markPrice ?? t.lastPrice ?? t.ltp ?? t.askPrice ?? t.bidPrice;
    const val = Number(raw);
    return Number.isFinite(val) && val > 0 ? val : 0;
  }

  function parseStrike(sym: string): number {
    const m = sym.match(/-(\d+)-[CP]-/);
    return m ? Number(m[1]) : 0;
  }

  const callTickers = tickers.filter((t) => t.symbol.includes('-C-') && extractPrice(t) > 0);
  const putTickers = tickers.filter((t) => t.symbol.includes('-P-') && extractPrice(t) > 0);

  if (callTickers.length === 0 || putTickers.length === 0) {
    console.error(`[1DTE Discovery] Incomplete strikes: calls=${callTickers.length}, puts=${putTickers.length}`);
    return null;
  }

  // Score candidate by distance from target range / target midpoint
  function pickBestContract(candidates: readonly OptionsTickerItem[], type: 'CALL' | 'PUT') {
    const inRange = candidates.filter((t) => {
      const p = extractPrice(t);
      return p >= config.minPremium && p <= config.maxPremium;
    });

    if (inRange.length > 0) {
      // Pick closest to midpoint
      inRange.sort((a, b) => Math.abs(extractPrice(a) - targetMid) - Math.abs(extractPrice(b) - targetMid));
      const chosen = inRange[0];
      const premium = extractPrice(chosen);
      const strikePrice = parseStrike(chosen.symbol);
      console.log(`[1DTE Discovery] Found ${type} in range [${config.minPremium}, ${config.maxPremium}]: ${chosen.symbol} @ $${premium.toFixed(2)}`);
      return { symbol: chosen.symbol, strikePrice, premium };
    }

    if (!config.allowOutOfBandFallback) {
      // Log best observed bid
      const sortedByDist = candidates.slice().sort((a, b) => {
        const pA = extractPrice(a);
        const pB = extractPrice(b);
        const distA = pA < config.minPremium ? config.minPremium - pA : (pA > config.maxPremium ? pA - config.maxPremium : 0);
        const distB = pB < config.minPremium ? config.minPremium - pB : (pB > config.maxPremium ? pB - config.maxPremium : 0);
        return distA - distB;
      });
      const best = sortedByDist[0];
      const bestBid = extractPrice(best);
      console.warn(`[1DTE Discovery] ⚠️ No ${type} strictly in [${config.minPremium}, ${config.maxPremium}] and out-of-band fallback is disabled. Best observed: ${best?.symbol || 'none'} @ $${bestBid.toFixed(2)}`);
      return null;
    }

    // Fallback: Pick nearest strike to the range
    candidates.slice().sort((a, b) => {
      const pA = extractPrice(a);
      const pB = extractPrice(b);
      const distA = pA < config.minPremium ? config.minPremium - pA : (pA > config.maxPremium ? pA - config.maxPremium : 0);
      const distB = pB < config.minPremium ? config.minPremium - pB : (pB > config.maxPremium ? pB - config.maxPremium : 0);
      return distA - distB;
    });
    const fallback = candidates[0];
    const premium = extractPrice(fallback);
    const strikePrice = parseStrike(fallback.symbol);
    console.warn(`[1DTE Discovery] ⚠️ No ${type} strictly in [${config.minPremium}, ${config.maxPremium}]. Fallback to closest: ${fallback.symbol} @ $${premium.toFixed(2)}`);
    return { symbol: fallback.symbol, strikePrice, premium };
  }

  const chosenCall = pickBestContract(callTickers, 'CALL');
  const chosenPut = pickBestContract(putTickers, 'PUT');

  if (!chosenCall || !chosenPut) {
    console.error(`[1DTE Discovery] Could not select both legs in band (calls=${chosenCall ? 'found' : 'none'}, puts=${chosenPut ? 'found' : 'none'}).`);
    return null;
  }

  return {
    expiryTimeMs: targetExpiryMs,
    call: chosenCall,
    put: chosenPut,
  };
}

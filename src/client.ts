import crypto from 'crypto';
import { getSessionToken } from './config';
import { appendAlert } from './fileAlerter';
import {
  CreateOrderPayload,
  CreateOrderResponse,
  OrderItem,
  OrderPlacementOutcome,
  OptionsMarginRequest,
  OptionsMarginResponse,
  OptionsPosition,
  OptionsTickerItem,
  TickerItem,
} from './types';

// Web session options endpoints captured from CoinDCX web application
export const OPTIONS_ENDPOINTS = {
  positions: '/api/v1/options/positions',
  orders: '/api/v1/options/orders',
  margin: '/api/v1/options/margin',
  // Captured order create / cancel endpoints
  orderCreate: '/api/v2/options/order/create',
  orderCancel: '/api/v1/options/order/cancel',
} as const;

export class SessionTokenExpiredError extends Error {
  constructor(message = 'CoinDCX session token expired/invalid — refresh it from the browser.') {
    super(message);
    this.name = 'SessionTokenExpiredError';
  }
}

/** How long a live USDT/INR rate is trusted before being re-read. */
const LIVE_RATE_TTL_MS = 5 * 60 * 1000;

export class CoinDCXClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private explicitBearerToken: string;
  private readonly sessionTokenFile?: string;
  private readonly dryRun: boolean;
  /** Fallback USDT/INR rate, used only when the live rate cannot be read. */
  private readonly fallbackConversionRate: string;
  private readonly liveConversionRate: boolean;
  private cachedLiveRate: { value: string; at: number } | null = null;

  constructor(
    apiKey: string,
    apiSecret: string,
    baseUrl = 'https://api.coindcx.com',
    bearerToken = '',
    sessionTokenFile?: string,
    dryRun = false,
    opts: { fallbackConversionRate?: string; liveConversionRate?: boolean } = {}
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl;
    this.explicitBearerToken = bearerToken;
    this.sessionTokenFile = sessionTokenFile;
    this.dryRun = dryRun;
    this.fallbackConversionRate = opts.fallbackConversionRate ?? '102';
    this.liveConversionRate = opts.liveConversionRate ?? true;
  }

  /**
   * Resolves the `conversionRate` the options order API requires (USDT -> INR).
   *
   * Live-first: the venue's own USDT/INR rate is read from public market data and
   * cached briefly, because a hardcoded rate silently drifts (a stale 102 against
   * a live 99.45 mis-states INR by ~2.5% on every order). If the rate cannot be
   * read, the configured fallback is used and the fact is logged — an order is
   * never blocked, and a rate is never invented.
   */
  public async resolveConversionRate(): Promise<string> {
    if (!this.liveConversionRate) {
      return this.fallbackConversionRate;
    }
    const now = Date.now();
    if (this.cachedLiveRate && now - this.cachedLiveRate.at < LIVE_RATE_TTL_MS) {
      return this.cachedLiveRate.value;
    }
    const live = await this.fetchUsdtInrRate();
    if (live === null) {
      console.warn(
        `[CoinDCXClient] live USDT/INR unavailable — using configured fallback conversionRate ${this.fallbackConversionRate}`
      );
      return this.fallbackConversionRate;
    }
    const value = live.toFixed(2);
    this.cachedLiveRate = { value, at: now };
    console.log(`[CoinDCXClient] live USDT/INR conversionRate: ${value}`);
    return value;
  }

  /** Reads the venue's own USDT/INR rate. Returns null if unavailable — never guesses. */
  private async fetchUsdtInrRate(): Promise<number | null> {
    try {
      const response = await fetch('https://public.coindcx.com/market_data/current_prices', {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as Record<string, unknown>;
      for (const [key, val] of Object.entries(data ?? {})) {
        if (key.toUpperCase().replace(/_/g, '') === 'USDTINR') {
          const rate = Number(val);
          // Sanity band — reject absurd quotes rather than propagate them.
          if (Number.isFinite(rate) && rate > 40 && rate < 250) {
            return rate;
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves the active session token dynamically on every call
   * from the environment or token file, allowing live token refreshes without restarts.
   */
  public getBearerToken(): string {
    return getSessionToken({
      bearerToken: this.explicitBearerToken,
      sessionTokenFile: this.sessionTokenFile,
    });
  }

  /**
   * Standard headers for CoinDCX session-authenticated options endpoints.
   */
  private getOptionsHeaders(token = this.getBearerToken()): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      Referer: 'https://coindcx.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    };
  }

  /**
   * Generates HMAC-SHA256 signature according to CoinDCX API specification
   */
  private generateSignature(jsonStringPayload: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(jsonStringPayload)
      .digest('hex');
  }

  /**
   * Fetches latest market ticker information for spot and perpetual pairs
   */
  public async getTickers(): Promise<readonly TickerItem[]> {
    const response = await fetch(`${this.baseUrl}/exchange/ticker`);
    if (!response.ok) {
      throw new Error(`Failed to fetch tickers: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('Unexpected ticker response format: expected array');
    }
    return data as readonly TickerItem[];
  }

  /**
   * Fetches the current spot/index price for Bitcoin (BTCUSDT)
   */
  public async getBtcSpotPrice(): Promise<number> {
    const tickers = await this.getTickers();
    const btcTicker = tickers.find(
      (item) => item.market === 'BTCUSDT' || item.market === 'B-BTC_USDT'
    );

    if (!btcTicker) {
      throw new Error('BTC market ticker not found in CoinDCX ticker response');
    }

    const price = Number(btcTicker.last_price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid BTC price received: ${btcTicker.last_price}`);
    }

    return price;
  }

  /**
   * Fetches current open options positions from /api/v1/options/positions
   * Returns positions array including symbol and markPrice.
   * Throws SessionTokenExpiredError on HTTP 401 without retrying in a loop.
   */
  public async getOptionsPositions(): Promise<readonly OptionsPosition[]> {
    const token = this.getBearerToken();
    if (!token) {
      const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
      appendAlert('auth_error', msg);
      throw new SessionTokenExpiredError(msg);
    }

    const endpoint = `${this.baseUrl}${OPTIONS_ENDPOINTS.positions}`;
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: this.getOptionsHeaders(token),
    });

    if (response.status === 401) {
      const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
      console.error(`[CoinDCXClient] 401 Unauthorized fetching positions: ${msg}`);
      appendAlert('auth_error', msg);
      throw new SessionTokenExpiredError(msg);
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch options positions: HTTP ${response.status} ${response.statusText}`);
    }

    const raw = (await response.json()) as unknown;
    if (Array.isArray(raw)) {
      return raw as readonly OptionsPosition[];
    }
    if (typeof raw === 'object' && raw !== null) {
      const rec = raw as Record<string, unknown>;
      if (Array.isArray(rec.data)) {
        return rec.data as readonly OptionsPosition[];
      }
      if (Array.isArray(rec.positions)) {
        return rec.positions as readonly OptionsPosition[];
      }
    }

    return [];
  }

  /**
   * Calls the options margin preview endpoint (POST /api/v1/options/margin)
   * Validates contract and required margin.
   */
  public async getOptionsMargin(req: OptionsMarginRequest): Promise<OptionsMarginResponse> {
    const token = this.getBearerToken();
    if (!token) {
      const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
      appendAlert('auth_error', msg);
      throw new SessionTokenExpiredError(msg);
    }

    const endpoint = `${this.baseUrl}${OPTIONS_ENDPOINTS.margin}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.getOptionsHeaders(token),
      body: JSON.stringify(req),
    });

    if (response.status === 401) {
      const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
      console.error(`[CoinDCXClient] 401 Unauthorized fetching options margin: ${msg}`);
      appendAlert('auth_error', msg);
      throw new SessionTokenExpiredError(msg);
    }

    if (!response.ok) {
      const text = await response.text();
      return {
        status: 'error',
        error: {
          code: response.status,
          message: `HTTP ${response.status}: ${text || response.statusText}`,
        },
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    return data as OptionsMarginResponse;
  }

  /**
   * Fetches the options ticker from public.coindcx.com/api/v1/options/ticker
   */
  public async getOptionsTicker(baseCurrency = 'BTC', expiryTime?: number): Promise<readonly OptionsTickerItem[]> {
    try {
      let url = `https://public.coindcx.com/api/v1/options/ticker?baseCurrency=${encodeURIComponent(baseCurrency)}`;
      if (expiryTime) {
        url += `&expiryTime=${expiryTime}`;
      }
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      });
      if (!response.ok) {
        return [];
      }
      const json = (await response.json()) as unknown;
      if (Array.isArray(json)) {
        return json as readonly OptionsTickerItem[];
      }
      if (typeof json === 'object' && json !== null) {
        const rec = json as Record<string, unknown>;
        if (Array.isArray(rec.data)) {
          return rec.data as readonly OptionsTickerItem[];
        }
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Fetches current market price / mark price for a specific contract symbol.
   * Priority:
   * 1. GET /api/v1/options/positions -> match symbol and extract markPrice/currentPrice/entryPrice/ltp.
   * 2. GET https://public.coindcx.com/api/v1/options/ticker -> match symbol for live mark/last price.
   * 3. POST /api/v1/options/margin -> preview check (can return price / margin calculation).
   * 4. Fallback to public spot ticker/orderbook if derivative happens to be listed.
   * Does NOT fabricate numbers. Returns 0 if not found.
   */
  public async getContractPrice(symbol: string, expiryTime?: number): Promise<number> {
    // 1. Try positions feed (primary options price feed for open positions)
    try {
      const positions = await this.getOptionsPositions();
      const pos = positions.find((p) => p.symbol === symbol);
      if (pos) {
        const candidate = pos.markPrice ?? pos.currentPrice ?? pos.ltp ?? pos.entryPrice;
        if (candidate !== undefined) {
          const num = Number(candidate);
          if (Number.isFinite(num) && num > 0) {
            return num;
          }
        }
      }
    } catch (err) {
      if (err instanceof SessionTokenExpiredError) {
        throw err;
      }
      // If error fetching positions (e.g. no position exists yet during pre-flight), continue to ticker
    }

    // 2. Try the public options ticker endpoint (carries live markPrice and lastPrice for all strikes)
    try {
      const tickers = await this.getOptionsTicker('BTC', expiryTime);
      const match = tickers.find((t) => t.symbol === symbol);
      if (match) {
        const candidate = match.markPrice ?? match.lastPrice ?? match.ltp ?? match.askPrice ?? match.bidPrice;
        if (candidate !== undefined) {
          const num = Number(candidate);
          if (Number.isFinite(num) && num > 0) {
            return num;
          }
        }
      }
    } catch {
      // Continue to margin preview if ticker fetch fails
    }

    // 3. Try the margin preview endpoint — it can carry a real mark price.
    //    NEVER fabricate a price here. An invented number becomes an entry price
    //    (=> wrong SL/PT levels) or a monitor reading (=> a FALSE stop-loss that
    //    closes a healthy leg). Return 0 and let callers decide.
    try {
      const marginRes = await this.getOptionsMargin({
        symbol,
        qty: '0.01',
        side: 'sell',
        orderType: 'Limit',
        price: '500',
      });
      const mark = Number(marginRes.data?.markPrice ?? marginRes.data?.price);
      if (Number.isFinite(mark) && mark > 0) {
        return mark;
      }
    } catch (err) {
      if (err instanceof SessionTokenExpiredError) {
        throw err;
      }
    }

    // 4. Fallback check on spot ticker or orderbook
    try {
      const tickers = await this.getTickers();
      const match = tickers.find((t) => t.market === symbol);
      if (match) {
        const parsed = Number(match.last_price);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    } catch {
      // Ignore
    }

    return 0;
  }

  /**
   * Contract-existence check via the margin preview endpoint.
   *
   * This deliberately does NOT use a price: existence and valuation are different
   * questions. The preview returning a successful margin calculation proves the
   * symbol is listed, which is exactly what the entry pre-flight needs.
   */
  public async isContractListed(symbol: string, qty = '0.01'): Promise<boolean> {
    try {
      const res = await this.getOptionsMargin({
        symbol,
        qty,
        side: 'sell',
        orderType: 'Limit',
        price: '500',
      });
      if (res.status === 'success') return true;
      return Boolean(res.data) && !res.error;
    } catch (err) {
      if (err instanceof SessionTokenExpiredError) {
        throw err;
      }
      return false;
    }
  }

  /**
   * Places an order on CoinDCX using HMAC-SHA256 authenticated request
   */
  public async placeOrder(order: OrderItem): Promise<OrderPlacementOutcome> {
    if (this.dryRun) {
      console.log(`[CoinDCXClient] [DRY RUN] Simulating placeOrder: ${order.side} ${order.total_quantity} ${order.pair}`);
      return {
        symbol: order.pair,
        side: order.side,
        success: true,
        orderId: `sim-order-${Date.now()}`,
        rawResponse: { dryRun: true },
      };
    }

    const timestamp = Math.floor(Date.now());
    const payload: CreateOrderPayload = {
      timestamp,
      order,
    };

    const jsonStringPayload = JSON.stringify(payload);
    const signature = this.generateSignature(jsonStringPayload);

    const endpoint = `${this.baseUrl}/exchange/v1/derivatives/futures/orders/create`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AUTH-APIKEY': this.apiKey,
          'X-AUTH-SIGNATURE': signature,
        },
        body: jsonStringPayload,
      });

      const responseData = (await response.json()) as unknown;
      const parsedRecord =
        typeof responseData === 'object' && responseData !== null
          ? (responseData as Record<string, unknown>)
          : {};

      const typedResponse = parsedRecord as unknown as CreateOrderResponse;

      if (!response.ok) {
        return {
          symbol: order.pair,
          side: order.side,
          success: false,
          message: typedResponse.message || `HTTP ${response.status}: ${response.statusText}`,
          rawResponse: parsedRecord,
        };
      }

      return {
        symbol: order.pair,
        side: order.side,
        success: true,
        orderId: typedResponse.id || typedResponse.client_order_id,
        rawResponse: parsedRecord,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown network error';
      return {
        symbol: order.pair,
        side: order.side,
        success: false,
        message: errorMessage,
        rawResponse: {},
      };
    }
  }

  private hasLoggedOpenOrdersSample = false;

  /**
   * Fetches open options orders via /api/v1/options/orders.
   * Logs sample raw row once defensively to record actual field names in logs.
   */
  public async getOpenOptionsOrders(): Promise<readonly Record<string, unknown>[]> {
    if (this.dryRun) {
      return [];
    }

    const token = this.getBearerToken();
    if (!token) {
      const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
      appendAlert('auth_error', msg);
      throw new SessionTokenExpiredError(msg);
    }

    const endpoint = `${this.baseUrl}${OPTIONS_ENDPOINTS.orders}`;
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: this.getOptionsHeaders(token),
      });

      if (response.status === 401) {
        const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
        console.error(`[CoinDCXClient] 401 Unauthorized fetching options orders: ${msg}`);
        appendAlert('auth_error', msg);
        throw new SessionTokenExpiredError(msg);
      }

      if (!response.ok) {
        // NEVER return [] here. An empty list means "no open orders", and the fill
        // poller treats absence-from-open-orders as FILLED. Returning [] for a
        // failed request would therefore make a transient 5xx/network blip look
        // like "both legs filled", skipping every cancel/unwind branch and
        // starting risk management on a position that may not exist — or worse,
        // leaving a one-sided fill unhedged. Throw so the poller retries instead.
        throw new Error(
          `Failed to fetch open options orders: HTTP ${response.status} ${response.statusText}`
        );
      }

      const json = (await response.json()) as unknown;
      let rows: Record<string, unknown>[] = [];
      if (Array.isArray(json)) {
        rows = json as Record<string, unknown>[];
      } else if (typeof json === 'object' && json !== null) {
        const rec = json as Record<string, unknown>;
        if (Array.isArray(rec.data)) {
          rows = rec.data as Record<string, unknown>[];
        } else if (Array.isArray(rec.orders)) {
          rows = rec.orders as Record<string, unknown>[];
        }
      }

      if (!this.hasLoggedOpenOrdersSample && rows.length > 0) {
        this.hasLoggedOpenOrdersSample = true;
        console.log(`[CoinDCXClient] Sample options orders response row:`, JSON.stringify(rows[0]));
      }

      return rows;
    } catch (err) {
      if (err instanceof SessionTokenExpiredError) {
        throw err;
      }
      // Propagate the failure: "could not read open orders" is NOT "no open orders".
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Places an order via the native CoinDCX Options API (/api/v2/options/order/create).
   *
   * Payload verified against the LIVE API on 2026-10-04 with a real (non-marketable)
   * order that was accepted and then cancelled:
   *
   *   POST /api/v2/options/order/create
   *   { symbol, side, orderType, qty, price, stopLoss, takeProfit, conversionRate }
   *   -> 200 {"status":"success","data":{"orderId":"e77823db-…"}}
   *
   * ⚠️ `conversionRate` IS REQUIRED. Omitting it returns
   *  400 {"message":"conversionRate is required"}
   * An earlier revision of this method dropped it because the app's bundle snippet
   * did not show it — that was wrong and would have failed every entry.
   * The order id comes back as `data.orderId`.
   */
  public async placeOptionsOrder(
    symbol: string,
    side: 'buy' | 'sell',
    qty: number,
    orderType: 'Limit' | 'Market' = 'Limit',
    price?: number | string,
    stopLoss = '',
    takeProfit = '',
    conversionRate?: string
  ): Promise<OrderPlacementOutcome> {
    const numPrice =
      typeof price === 'number'
        ? price
        : price !== undefined && Number.isFinite(Number(price))
        ? Number(price)
        : undefined;

    if (this.dryRun) {
      console.log(
        `[CoinDCXClient] [DRY RUN] Simulating placeOptionsOrder: ${side} ${qty} ${symbol} @ ${price ?? 'Market'} | stopLoss: ${stopLoss || 'none'}`
      );
      return {
        symbol,
        side,
        success: true,
        orderId: `sim-options-${Date.now()}`,
        limitPrice: numPrice,
        rawResponse: { dryRun: true },
      };
    }

    const token = this.getBearerToken();
    if (!token) {
      const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
      appendAlert('auth_error', msg);
      throw new SessionTokenExpiredError(msg);
    }

    const endpoint = `${this.baseUrl}${OPTIONS_ENDPOINTS.orderCreate}`;

    const priceStr =
      price !== undefined && price !== null
        ? typeof price === 'string'
          ? price
          : price.toFixed(2)
        : orderType === 'Limit'
        ? '0.00'
        : '0';

    // Verified against the live API: conversionRate is REQUIRED (its absence is a 400).
    // Resolve it live (USDT -> INR) unless the caller supplied one explicitly.
    const resolvedConversionRate = conversionRate ?? (await this.resolveConversionRate());
    const body: Record<string, string> = {
      symbol,
      side,
      orderType,
      qty: String(qty),
      price: priceStr,
      stopLoss: stopLoss || '',
      takeProfit: takeProfit || '',
      conversionRate: resolvedConversionRate,
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.getOptionsHeaders(token),
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
        console.error(`[CoinDCXClient] 401 Unauthorized placing order: ${msg}`);
        appendAlert('auth_error', msg);
        throw new SessionTokenExpiredError(msg);
      }

      const rawText = await response.text();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        data = { rawText };
      }

      // Log raw response body (never token)
      console.log(`[CoinDCXClient] v2 order create raw response (${symbol}): ${rawText}`);

      // Extract order ID defensively from common candidate fields
      const orderData = data.data as Record<string, unknown> | undefined;
      let orderId: string | undefined;
      let matchedField: string | undefined;

      const candidates: readonly [string, unknown][] = [
        ['data.order_id', orderData?.order_id],
        ['data.orderId', orderData?.orderId],
        ['data.id', orderData?.id],
        ['data.client_order_id', orderData?.client_order_id],
        ['order_id', data.order_id],
        ['orderId', data.orderId],
        ['id', data.id],
        ['client_order_id', data.client_order_id],
      ];

      for (const [key, val] of candidates) {
        if (typeof val === 'string' && val.length > 0) {
          orderId = val;
          matchedField = key;
          break;
        }
        if (typeof val === 'number') {
          orderId = String(val);
          matchedField = key;
          break;
        }
      }

      if (orderId && matchedField) {
        console.log(`[CoinDCXClient] Extracted order ID (${orderId}) from response field '${matchedField}'`);
      }

      const isSuccess =
        response.ok &&
        (data.status === 'success' ||
          data.success === true ||
          (Boolean(orderId) && !data.error && response.status < 400));

      if (isSuccess) {
        return {
          symbol,
          side,
          success: true,
          orderId,
          limitPrice: numPrice,
          rawResponse: data,
        };
      }

      const errObj = data.error as Record<string, unknown> | undefined;
      const errorMsg =
        typeof errObj?.message === 'string'
          ? errObj.message
          : typeof data.message === 'string'
          ? data.message
          : `HTTP ${response.status}: ${response.statusText}`;

      return {
        symbol,
        side,
        success: false,
        orderId,
        limitPrice: numPrice,
        message: errorMsg,
        rawResponse: data,
      };
    } catch (err) {
      if (err instanceof SessionTokenExpiredError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Network error';
      return {
        symbol,
        side,
        success: false,
        limitPrice: numPrice,
        message: msg,
        rawResponse: {},
      };
    }
  }

  /**
   * Cancels an open options order via /api/v1/options/order/cancel.
   */
  public async cancelOptionsOrder(orderId: string, symbol: string): Promise<boolean> {
    if (this.dryRun) {
      console.log(`[CoinDCXClient] [DRY RUN] Simulating cancelOptionsOrder: ${orderId} (${symbol})`);
      return true;
    }

    const token = this.getBearerToken();
    if (!token) {
      const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
      appendAlert('auth_error', msg);
      throw new SessionTokenExpiredError(msg);
    }

    try {
      const res = await fetch(`${this.baseUrl}${OPTIONS_ENDPOINTS.orderCancel}`, {
        method: 'POST',
        headers: this.getOptionsHeaders(token),
        body: JSON.stringify({ orderId, symbol }),
      });

      if (res.status === 401) {
        const msg = 'CoinDCX session token expired/invalid — refresh it from the browser.';
        console.error(`[CoinDCXClient] 401 Unauthorized cancelling order: ${msg}`);
        appendAlert('auth_error', msg);
        throw new SessionTokenExpiredError(msg);
      }

      return res.ok;
    } catch (err) {
      if (err instanceof SessionTokenExpiredError) {
        throw err;
      }
      return false;
    }
  }

  /**
   * Closes an existing short position by executing a BUY order.
   */
  public async closePosition(
    pair: string,
    quantity: number,
    leverage = 10
  ): Promise<OrderPlacementOutcome> {
    const token = this.getBearerToken();
    if (token) {
      // Use native Options API for options contracts
      return this.placeOptionsOrder(pair, 'buy', quantity, 'Market');
    }

    const order: OrderItem = {
      side: 'buy',
      pair,
      order_type: 'market_order',
      price: '0',
      total_quantity: quantity,
      leverage,
      notification: 'email_notification',
      time_in_force: 'immediate_or_cancel',
      hidden: false,
      post_only: false,
      margin_currency_short_name: ['USDT'],
    };

    return this.placeOrder(order);
  }
}



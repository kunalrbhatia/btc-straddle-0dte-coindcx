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

export class CoinDCXClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private explicitBearerToken: string;
  private readonly sessionTokenFile?: string;
  private readonly dryRun: boolean;

  constructor(
    apiKey: string,
    apiSecret: string,
    baseUrl = 'https://api.coindcx.com',
    bearerToken = '',
    sessionTokenFile?: string,
    dryRun = false
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl;
    this.explicitBearerToken = bearerToken;
    this.sessionTokenFile = sessionTokenFile;
    this.dryRun = dryRun;
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
   * Fetches current market price / mark price for a specific contract symbol.
   * Priority:
   * 1. GET /api/v1/options/positions -> match symbol and extract markPrice/currentPrice/entryPrice/ltp.
   * 2. POST /api/v1/options/margin -> preview check (can return price / margin calculation).
   * 3. Fallback to public spot ticker/orderbook if derivative happens to be listed.
   * Does NOT fabricate numbers. Returns 0 if not found.
   */
  public async getContractPrice(symbol: string): Promise<number> {
    // 1. Try positions feed (primary options price feed)
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
      // If error fetching positions (e.g. no position exists yet during pre-flight), continue to preview
    }

    // 2. Try the margin preview endpoint — it can carry a real mark price.
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

    // 3. Fallback check on ticker or orderbook
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

  /**
   * Places an order via the native CoinDCX Options API (/api/v2/options/order/create).
   */
  public async placeOptionsOrder(
    symbol: string,
    side: 'buy' | 'sell',
    qty: number,
    orderType: 'Limit' | 'Market' = 'Market',
    price?: number,
    conversionRate = '102'
  ): Promise<OrderPlacementOutcome> {
    if (this.dryRun) {
      console.log(`[CoinDCXClient] [DRY RUN] Simulating placeOptionsOrder: ${side} ${qty} ${symbol} @ ${price ?? 'Market'}`);
      return {
        symbol,
        side,
        success: true,
        orderId: `sim-options-${Date.now()}`,
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
    const body = {
      symbol,
      side,
      orderType,
      qty: String(qty),
      takeProfit: '',
      stopLoss: '',
      conversionRate,
      price: price ? String(price) : '0',
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

      const data = (await response.json()) as Record<string, unknown>;

      if (response.ok && data.status === 'success') {
        const orderData = data.data as Record<string, unknown> | undefined;
        const orderId = typeof orderData?.orderId === 'string' ? orderData.orderId : undefined;
        return {
          symbol,
          side,
          success: true,
          orderId,
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



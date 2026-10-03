import crypto from 'crypto';
import {
  CreateOrderPayload,
  CreateOrderResponse,
  OrderItem,
  OrderPlacementOutcome,
  TickerItem,
} from './types';

export class CoinDCXClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, apiSecret: string, baseUrl = 'https://api.coindcx.com') {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl;
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
   * Places an order on CoinDCX using HMAC-SHA256 authenticated request
   */
  public async placeOrder(order: OrderItem): Promise<OrderPlacementOutcome> {
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
   * Fetches current market price / LTP for a specific contract symbol.
   * Checks ticker or orderbook endpoint.
   */
  public async getContractPrice(symbol: string): Promise<number> {
    try {
      const tickers = await this.getTickers();
      const match = tickers.find((t) => t.market === symbol);
      if (match) {
        const parsed = Number(match.last_price);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    } catch {
      // Fallback to orderbook if ticker does not list the derivative
    }

    try {
      const bookRes = await fetch(
        `https://public.coindcx.com/market_data/v3/orderbook/${symbol}-futures/50`
      );
      if (bookRes.ok) {
        const bookData = (await bookRes.json()) as {
          asks?: Record<string, string>;
          bids?: Record<string, string>;
        };
        const askKeys = bookData.asks ? Object.keys(bookData.asks) : [];
        const bidKeys = bookData.bids ? Object.keys(bookData.bids) : [];
        if (askKeys.length > 0 && bidKeys.length > 0) {
          const bestAsk = Number(askKeys[0]);
          const bestBid = Number(bidKeys[0]);
          if (Number.isFinite(bestAsk) && Number.isFinite(bestBid)) {
            return (bestAsk + bestBid) / 2;
          }
        }
      }
    } catch {
      // Return 0 if unavailable
    }

    return 0;
  }

  /**
   * Closes an existing short position by executing a market BUY order.
   */
  public async closePosition(
    pair: string,
    quantity: number,
    leverage = 10
  ): Promise<OrderPlacementOutcome> {
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


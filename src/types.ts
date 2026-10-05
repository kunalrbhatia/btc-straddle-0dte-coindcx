/**
 * CoinDCX API & Straddle Trading Types
 * Strictly typed definitions.
 */

export type OrderSide = 'buy' | 'sell';

export type OrderType = 'market_order' | 'limit_order';

export type NotificationPreference =
  | 'no_notification'
  | 'email_notification'
  | 'push_notification';

export type TimeInForce =
  | 'good_till_cancel'
  | 'fill_or_kill'
  | 'immediate_or_cancel';

export type MarginCurrency = 'INR' | 'USDT';

export interface OrderItem {
  readonly side: OrderSide;
  readonly pair: string;
  readonly order_type: OrderType;
  readonly price: string;
  readonly stop_price?: string;
  readonly total_quantity: number;
  readonly leverage: number;
  readonly notification: NotificationPreference;
  readonly time_in_force: TimeInForce;
  readonly hidden: boolean;
  readonly post_only: boolean;
  readonly margin_currency_short_name?: MarginCurrency[];
}

export interface CreateOrderPayload {
  readonly timestamp: number;
  readonly order: OrderItem;
}

export interface CreateOrderResponse {
  readonly id?: string;
  readonly client_order_id?: string;
  readonly status?: string;
  readonly message?: string;
  readonly code?: number;
  readonly orders?: readonly unknown[];
}

export interface OptionsOrderRequest {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly orderType: 'Limit' | 'Market';
  readonly qty: string;
  readonly price?: string;
  readonly takeProfit?: string;
  readonly stopLoss?: string;
}

export interface OptionsPosition {
  readonly symbol: string;
  readonly side?: 'buy' | 'sell' | string;
  readonly qty?: number | string;
  readonly entryPrice?: number | string;
  readonly markPrice?: number | string;
  readonly currentPrice?: number | string;
  readonly ltp?: number | string;
  readonly pnl?: number | string;
  readonly [key: string]: unknown;
}

export interface OptionsMarginRequest {
  readonly symbol: string;
  readonly qty: string;
  readonly side: 'buy' | 'sell';
  readonly orderType: 'Limit' | 'Market';
  readonly price?: string;
}

export interface OptionsMarginResponse {
  readonly status?: string;
  readonly margin?: number | string;
  readonly requiredMargin?: number | string;
  readonly currency?: string;
  readonly marginCurrency?: string;
  readonly data?: {
    readonly margin?: number | string;
    readonly requiredMargin?: number | string;
    readonly currency?: string;
    readonly marginCurrency?: string;
    readonly [key: string]: unknown;
  };
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
  };
  readonly [key: string]: unknown;
}

export interface OptionsTickerItem {
  readonly symbol: string;
  readonly markPrice?: string | number;
  readonly lastPrice?: string | number;
  readonly ltp?: string | number;
  readonly bidPrice?: string | number;
  readonly askPrice?: string | number;
  readonly [key: string]: unknown;
}

export interface OptionsInstrument {
  readonly symbol: string;
  readonly displayName?: string;
  readonly expiryTime: string | number;
  readonly strikePrice: string | number;
  readonly optionsType: 'Call' | 'Put' | string;
  readonly isActive: boolean;
  readonly lotSizeFilter?: Record<string, unknown>;
  readonly priceFilter?: Record<string, unknown>;
  readonly baseCoin?: string;
  readonly quoteCoin?: string;
  readonly settleCoin?: string;
  readonly launchTime?: string | number;
  readonly [key: string]: unknown;
}


export interface TickerItem {
  readonly market: string;
  readonly change_24_hour: string;
  readonly high: string;
  readonly low: string;
  readonly volume: string;
  readonly last_price: string;
  readonly bid: string;
  readonly ask: string;
  readonly timestamp: number;
}

export interface StraddleLegs {
  readonly spotPrice: number;
  readonly atmStrike: number;
  readonly callSymbol: string;
  readonly putSymbol: string;
  readonly expiryTimeMs?: number;
}

export interface OrderPlacementOutcome {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly success: boolean;
  readonly orderId?: string;
  readonly limitPrice?: number;
  readonly message?: string;
  readonly rawResponse: Record<string, unknown>;
  readonly route?: 'V2' | 'V1-fallback' | string;
  readonly traceId?: string;
}

export interface StraddleExecutionResult {
  readonly executedAt: Date;
  readonly success: boolean;
  readonly partialFailure: boolean;
  readonly atmStrike: number;
  readonly spotPrice: number;
  readonly callOutcome: OrderPlacementOutcome;
  readonly putOutcome: OrderPlacementOutcome;
  readonly message?: string;
  readonly unwoundLeg?: string;
}

export type LegStatus = 'open' | 'closed';

export type LegCloseReason =
  | 'SL_HIT'
  | 'PROFIT_TARGET_HIT'
  | 'MANUAL'
  | 'UNWOUND_PARTIAL'
  | 'EXPIRED'
  | 'MONITOR_WINDOW_ELAPSED';

export type TradeScenario =
  | 'PROFIT_TARGET_REACHED'
  | 'ONE_LEG_SL_OTHER_COVERED'
  | 'BOTH_LEGS_SL'
  | 'MAX_TIME_REACHED';

export type EntryPriceSource = 'fill' | 'mark';

export interface ActiveLeg {
  readonly legType: 'CALL' | 'PUT';
  readonly symbol: string;
  readonly entryPrice: number;
  readonly venueAvgPrice?: number;
  readonly entryPriceSource: EntryPriceSource;
  readonly stopLossPrice: number;
  readonly quantity: number;
  readonly orderId?: string;
  readonly confirmedOpen: boolean;
  status: LegStatus;
  currentPrice: number;
  exitPrice?: number;
  closeReason?: LegCloseReason;
  exitOrderId?: string;
  closeAttempts?: number;
}

export interface RiskManagementConfig {
  readonly stopLossMultiplier: number; // 2.0 = 100% SL (sold at 100 -> SL at 200)
  readonly profitTargetRatio: number; // 0.55 = 55% of combined credit
  readonly pollIntervalMs: number;
  readonly maxMonitorMinutes?: number; // End-of-life cutoff for monitor
}

export interface StraddlePositionState {
  readonly date: string;
  readonly entryExecuted: boolean;
  readonly callLeg: ActiveLeg;
  readonly putLeg: ActiveLeg;
  readonly totalCreditReceived: number;
  readonly targetProfitPoints: number;
  combinedPnLPoints: number;
  resolvedScenario?: TradeScenario;
  updatedAt?: string;
}

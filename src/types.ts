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
}

export interface OrderPlacementOutcome {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly success: boolean;
  readonly orderId?: string;
  readonly message?: string;
  readonly rawResponse: Record<string, unknown>;
}

export interface StraddleExecutionResult {
  readonly executedAt: Date;
  readonly atmStrike: number;
  readonly spotPrice: number;
  readonly callOutcome: OrderPlacementOutcome;
  readonly putOutcome: OrderPlacementOutcome;
}

export type LegStatus = 'open' | 'closed';

export type LegCloseReason = 'SL_HIT' | 'PROFIT_TARGET_HIT' | 'MANUAL';

export type TradeScenario =
  | 'PROFIT_TARGET_REACHED'
  | 'ONE_LEG_SL_OTHER_COVERED'
  | 'BOTH_LEGS_SL';

export interface ActiveLeg {
  readonly legType: 'CALL' | 'PUT';
  readonly symbol: string;
  readonly entryPrice: number;
  readonly stopLossPrice: number;
  readonly quantity: number;
  status: LegStatus;
  currentPrice: number;
  exitPrice?: number;
  closeReason?: LegCloseReason;
}

export interface RiskManagementConfig {
  readonly stopLossMultiplier: number; // 2.0 = 100% SL (sold at 100 -> SL at 200)
  readonly profitTargetRatio: number; // 0.55 = 55% of combined credit
  readonly pollIntervalMs: number;
}

export interface StraddlePositionState {
  readonly callLeg: ActiveLeg;
  readonly putLeg: ActiveLeg;
  readonly totalCreditReceived: number;
  readonly targetProfitPoints: number;
  combinedPnLPoints: number;
  resolvedScenario?: TradeScenario;
}

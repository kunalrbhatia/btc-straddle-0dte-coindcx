import { LegCloseReason, LegStatus } from '../types';

export interface OneDteLeg {
  readonly legType: 'CALL' | 'PUT';
  readonly symbol: string;
  readonly strikePrice: number;
  readonly entryPrice: number;
  readonly stopLossPrice: number;
  readonly quantity: number;
  readonly orderId?: string;
  readonly stopOrderId?: string;
  readonly entryBid?: number;
  status: LegStatus;
  currentPrice: number;
  exitPrice?: number;
  closeReason?: LegCloseReason;
  exitOrderId?: string;
}

export interface OneDtePositionState {
  readonly date: string; // Cycle entry date in IST YYYY-MM-DD
  readonly expiryTimeMs: number;
  readonly entryExecuted: boolean;
  readonly targetExitUtcMs: number; // Next day 5:45 PM IST timestamp
  readonly callLeg: OneDteLeg;
  readonly putLeg: OneDteLeg;
  readonly totalCreditReceived: number;
  combinedPnLPoints: number;
  status: 'active' | 'closed';
  failureReason?: string;
  updatedAt?: string;
}

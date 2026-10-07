export type CycleEventType =
  | 'CYCLE_START'
  | 'CONFIG_SNAPSHOT'
  | 'ORDER_PLACED'
  | 'ORDER_FILLED'
  | 'STOPS_ARMED'
  | 'TARGET_ARMED'
  | 'MTM_CHECKPOINT'
  | 'LEG_SL_HIT'
  | 'LEG_CLOSED'
  | 'TARGET_HIT'
  | 'EXPIRY_SETTLEMENT'
  | 'CYCLE_CLOSED'
  | 'STOP_MOVED_TO_COST'
  | 'COST_STOP_REOPENED'
  | 'ANOMALY';

export interface CycleEventPayload {
  readonly ts: string; // ISO-8601 with IST offset
  readonly event: CycleEventType;
  readonly cycle: string; // Expiry date (YYYY-MM-DD)
  readonly schemaVersion: number;
  readonly data: Record<string, unknown>;
}

export interface MtmTapeSample {
  readonly ts: string;
  readonly callMark: number;
  readonly putMark: number;
  readonly combinedPts: number;
}

export interface CycleSummarySnapshot {
  readonly schemaVersion: number;
  readonly cycle: string;
  readonly entryDate: string;
  readonly status: 'OPEN' | 'CLOSED' | 'ADOPTED' | 'RECONSTRUCTED';
  readonly adopted?: boolean;
  readonly reconstructed?: boolean;
  readonly source?: string;
  readonly atmStrike?: number;
  readonly callSymbol?: string;
  readonly putSymbol?: string;
  readonly orderQuantity?: number;
  readonly totalCreditReceived?: number;
  readonly targetProfitPoints?: number;
  readonly callLeg?: {
    readonly symbol: string;
    readonly entryPrice: number;
    readonly venueAvgPrice?: number;
    readonly exitPrice?: number | null;
    readonly closeReason?: string;
    readonly status: string;
    readonly orderId?: string;
    readonly closeOrderId?: string;
    readonly pnlPoints?: number | null;
  };
  readonly putLeg?: {
    readonly symbol: string;
    readonly entryPrice: number;
    readonly venueAvgPrice?: number;
    readonly exitPrice?: number | null;
    readonly closeReason?: string;
    readonly status: string;
    readonly orderId?: string;
    readonly closeOrderId?: string;
    readonly pnlPoints?: number | null;
  };
  readonly combinedPnLPoints?: number | null;
  readonly resolvedScenario?: string;
  readonly lastMtmSample?: MtmTapeSample;
  readonly peakMtmPoints?: number;
  readonly troughMtmPoints?: number;
  readonly mtmObservationCount?: number;
  readonly verificationVerdict?: 'VERIFIED' | 'PARTIAL' | 'FAILED' | 'UNVERIFIED';
  readonly updatedAt: string;
}

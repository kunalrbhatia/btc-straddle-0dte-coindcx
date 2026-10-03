import dotenv from 'dotenv';
import { MarginCurrency, RiskManagementConfig } from './types';

dotenv.config();

export interface AppConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly baseUrl: string;
  readonly scheduledHourIST: number;
  readonly scheduledMinuteIST: number;
  readonly strikeStep: number;
  readonly orderQuantity: number;
  readonly leverage: number;
  readonly marginCurrency: MarginCurrency;
  readonly riskConfig: RiskManagementConfig;
}

const getEnvNumber = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

export const config: AppConfig = {
  apiKey: process.env.COINDCX_API_KEY || '',
  apiSecret: process.env.COINDCX_API_SECRET || '',
  baseUrl: process.env.COINDCX_BASE_URL || 'https://api.coindcx.com',
  scheduledHourIST: getEnvNumber('EXECUTION_HOUR_IST', 18), // 6 PM
  scheduledMinuteIST: getEnvNumber('EXECUTION_MINUTE_IST', 15), // 15 mins -> 6:15 PM IST
  strikeStep: getEnvNumber('STRIKE_STEP', 500), // BTC strikes typically spaced at 500 or 1000
  orderQuantity: getEnvNumber('ORDER_QUANTITY', 1),
  leverage: getEnvNumber('LEVERAGE', 10),
  marginCurrency: (process.env.MARGIN_CURRENCY === 'INR' ? 'INR' : 'USDT') as MarginCurrency,

  // Stop-Loss (100%) and Profit-Target (55% of combined credit)
  riskConfig: {
    stopLossMultiplier: getEnvNumber('SL_MULTIPLIER', 2.0), // 100% loss (entry * 2.0)
    profitTargetRatio: getEnvNumber('PROFIT_TARGET_RATIO', 0.55), // 55% of total credit
    pollIntervalMs: getEnvNumber('POLL_INTERVAL_MS', 2000), // Check positions every 2 seconds
  },
};

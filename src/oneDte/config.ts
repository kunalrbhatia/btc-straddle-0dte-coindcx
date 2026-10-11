import dotenv from 'dotenv';
import { MarginCurrency } from '../types';

dotenv.config();

export interface OneDteConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly bearerToken: string;
  readonly sessionTokenFile?: string;
  readonly baseUrl: string;
  readonly dryRun: boolean;

  // Entry timing: 10:45 PM IST by default
  readonly entryHourIST: number;
  readonly entryMinuteIST: number;

  // Exit timing: 5:45 PM IST next day by default
  readonly exitHourIST: number;
  readonly exitMinuteIST: number;

  // Premium filtering: $100 <= premium <= $150
  readonly minPremium: number;
  readonly maxPremium: number;

  // Order settings
  readonly orderQuantity: number;
  readonly leverage: number;
  readonly marginCurrency: MarginCurrency;
  readonly conversionRate: string;
  readonly entryOrderType: 'Limit' | 'Market';
  readonly entryFillTimeoutMs: number;

  // Risk & SL
  readonly stopLossMultiplier: number; // 2.0 = 100% loss (stop at 2x premium)
  readonly pollIntervalMs: number;
  readonly slOverrunTolerance: number;

  // Profit target: close the cycle once this share of the credit sold has been earned
  // (0.5 = exit as soon as the combined gain reaches 50% of the total credit).
  readonly profitTargetRatio: number;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined || val.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseOptionalIntInRange(key: string, defaultValue: number, min: number, max: number): number {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Environment variable ${key} must be an integer between ${min} and ${max}, but received: "${value}"`);
  }
  return parsed;
}

export const oneDteConfig: OneDteConfig = {
  apiKey: process.env.COINDCX_API_KEY || '',
  apiSecret: process.env.COINDCX_API_SECRET || '',
  bearerToken: process.env.COINDCX_SESSION_TOKEN || process.env.COINDCX_BEARER_TOKEN || '',
  sessionTokenFile: process.env.COINDCX_SESSION_FILE || undefined,
  baseUrl: process.env.COINDCX_BASE_URL || 'https://api.coindcx.com',
  dryRun: process.env.DRY_RUN === 'true',

  // 10:45 PM IST
  entryHourIST: parseOptionalIntInRange('ONEDTE_ENTRY_HOUR_IST', 22, 0, 23),
  entryMinuteIST: parseOptionalIntInRange('ONEDTE_ENTRY_MINUTE_IST', 45, 0, 59),

  // 5:45 PM IST next day
  exitHourIST: parseOptionalIntInRange('ONEDTE_EXIT_HOUR_IST', 17, 0, 23),
  exitMinuteIST: parseOptionalIntInRange('ONEDTE_EXIT_MINUTE_IST', 45, 0, 59),

  // Premium threshold: 100 to 150
  minPremium: getEnvNumber('ONEDTE_MIN_PREMIUM', 100),
  maxPremium: getEnvNumber('ONEDTE_MAX_PREMIUM', 150),

  orderQuantity: getEnvNumber('ONEDTE_ORDER_QUANTITY', getEnvNumber('ORDER_QUANTITY', 0.01)),
  leverage: getEnvNumber('ONEDTE_LEVERAGE', getEnvNumber('LEVERAGE', 10)),
  marginCurrency: (process.env.MARGIN_CURRENCY === 'INR' ? 'INR' : 'USDT') as MarginCurrency,
  conversionRate: process.env.CONVERSION_RATE || '102',
  entryOrderType: (process.env.ONEDTE_ENTRY_ORDER_TYPE === 'Market' || process.env.ENTRY_ORDER_TYPE === 'Market' ? 'Market' : 'Limit'),
  entryFillTimeoutMs: getEnvNumber('ENTRY_FILL_TIMEOUT_MS', 15000),

  // SL: 2x sold premium
  stopLossMultiplier: getEnvNumber('ONEDTE_SL_MULTIPLIER', 2.0),
  pollIntervalMs: getEnvNumber('ONEDTE_POLL_INTERVAL_MS', 3000),
  slOverrunTolerance: getEnvNumber('SL_OVERRUN_TOLERANCE', 0.10),

  // Exit once this share of the credit sold has been earned (0.5 = 50%).
  profitTargetRatio: getEnvNumber('ONEDTE_PROFIT_TARGET_RATIO', 0.5),
};

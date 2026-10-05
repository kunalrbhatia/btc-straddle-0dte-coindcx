import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { MarginCurrency, RiskManagementConfig } from './types';

dotenv.config();

export interface AppConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly bearerToken: string;
  readonly sessionTokenFile?: string;
  readonly baseUrl: string;
  readonly dryRun: boolean;
  readonly scheduledHourIST: number;
  readonly scheduledMinuteIST: number;
  readonly dailyExpiryHourUTC: number;
  readonly expiryMinLeadMinutes?: number;
  readonly strikeStep: number;
  readonly orderQuantity: number;
  readonly leverage: number;
  readonly marginCurrency: MarginCurrency;
  readonly conversionRate: string;
  readonly entryOrderType: 'Limit' | 'Market';
  readonly entryFillTimeoutMs: number;
  readonly riskConfig: RiskManagementConfig;
  readonly customCallSymbol?: string;
  readonly customPutSymbol?: string;
}

export function parseRequiredIntInRange(key: string, min: number, max: number): number {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Environment variable ${key} is required but missing.`);
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Environment variable ${key} must be an integer between ${min} and ${max}, but received: "${value}"`
    );
  }
  return parsed;
}

export function parseOptionalIntInRange(
  key: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Environment variable ${key} must be an integer between ${min} and ${max}, but received: "${value}"`
    );
  }
  return parsed;
}

const getEnvNumber = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

/**
 * Reads session token from environment or token file dynamically.
 */
export function getSessionToken(explicitConfig?: Partial<AppConfig>): string {
  // 1. Dynamic token file takes priority so automated refreshes work immediately
  const filePath =
    explicitConfig?.sessionTokenFile ||
    process.env.COINDCX_SESSION_FILE ||
    path.resolve(process.cwd(), 'session.token');

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content.length > 0) {
        return content;
      }
    }
  } catch {
    // Fall back if file read fails
  }

  // 2. Explicit config if supplied
  if (explicitConfig?.bearerToken && explicitConfig.bearerToken.trim().length > 0) {
    return explicitConfig.bearerToken.trim();
  }

  // 3. Fall back to environment variable
  const envToken = process.env.COINDCX_SESSION_TOKEN || process.env.COINDCX_BEARER_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  return '';
}

export const config: AppConfig = {
  apiKey: process.env.COINDCX_API_KEY || '',
  apiSecret: process.env.COINDCX_API_SECRET || '',
  bearerToken: process.env.COINDCX_SESSION_TOKEN || process.env.COINDCX_BEARER_TOKEN || '',
  sessionTokenFile: process.env.COINDCX_SESSION_FILE || undefined,
  baseUrl: process.env.COINDCX_BASE_URL || 'https://api.coindcx.com',
  dryRun: process.env.DRY_RUN === 'true',
  scheduledHourIST: parseRequiredIntInRange('EXECUTION_HOUR_IST', 0, 23),
  scheduledMinuteIST: parseRequiredIntInRange('EXECUTION_MINUTE_IST', 0, 59),
  dailyExpiryHourUTC: parseOptionalIntInRange('DAILY_EXPIRY_HOUR_UTC', 8, 0, 23),
  expiryMinLeadMinutes: getEnvNumber('EXPIRY_MIN_LEAD_MINUTES', 30),
  strikeStep: getEnvNumber('STRIKE_STEP', 250), // CoinDCX BTC 0DTE options grid is spaced at 250
  orderQuantity: getEnvNumber('ORDER_QUANTITY', 0.01), // CoinDCX options min lot is 0.01 BTC
  leverage: getEnvNumber('LEVERAGE', 10),
  marginCurrency: (process.env.MARGIN_CURRENCY === 'INR' ? 'INR' : 'USDT') as MarginCurrency,
  conversionRate: process.env.CONVERSION_RATE || '102',
  entryOrderType: (process.env.ENTRY_ORDER_TYPE === 'Market' ? 'Market' : 'Limit'),
  entryFillTimeoutMs: getEnvNumber('ENTRY_FILL_TIMEOUT_MS', 15000),

  // Stop-Loss (100%) and Profit-Target (55% of combined credit)
  riskConfig: {
    stopLossMultiplier: getEnvNumber('SL_MULTIPLIER', 2.0), // 100% loss (entry * 2.0)
    profitTargetRatio: getEnvNumber('PROFIT_TARGET_RATIO', 0.55), // 55% of total credit
    pollIntervalMs: getEnvNumber('POLL_INTERVAL_MS', 2000), // Check positions every 2 seconds
    maxMonitorMinutes: getEnvNumber('MAX_MONITOR_MINUTES', 1380), // 23 hours cutoff by default (accommodates 14:15 IST entry to 13:30 IST expiry)
  },
  customCallSymbol: process.env.CUSTOM_CALL_SYMBOL || undefined,
  customPutSymbol: process.env.CUSTOM_PUT_SYMBOL || undefined,
};


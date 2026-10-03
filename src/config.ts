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
  readonly strikeStep: number;
  readonly orderQuantity: number;
  readonly leverage: number;
  readonly marginCurrency: MarginCurrency;
  readonly conversionRate: string;
  readonly riskConfig: RiskManagementConfig;
  readonly customCallSymbol?: string;
  readonly customPutSymbol?: string;
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
  if (explicitConfig?.bearerToken) {
    return explicitConfig.bearerToken.trim();
  }

  // If a specific session token file is explicitly configured, read from it first
  if (explicitConfig?.sessionTokenFile) {
    try {
      if (fs.existsSync(explicitConfig.sessionTokenFile)) {
        const content = fs.readFileSync(explicitConfig.sessionTokenFile, 'utf8').trim();
        if (content.length > 0) {
          return content;
        }
      }
    } catch {
      // Ignore read failure
    }
  }

  const envToken = process.env.COINDCX_SESSION_TOKEN || process.env.COINDCX_BEARER_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  const filePath =
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
    // Return empty string if unable to read
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
  scheduledHourIST: getEnvNumber('EXECUTION_HOUR_IST', 18), // 6 PM
  scheduledMinuteIST: getEnvNumber('EXECUTION_MINUTE_IST', 15), // 15 mins -> 6:15 PM IST
  strikeStep: getEnvNumber('STRIKE_STEP', 250), // CoinDCX BTC 0DTE options grid is spaced at 250
  orderQuantity: getEnvNumber('ORDER_QUANTITY', 0.01), // CoinDCX options min lot is 0.01 BTC
  leverage: getEnvNumber('LEVERAGE', 10),
  marginCurrency: (process.env.MARGIN_CURRENCY === 'INR' ? 'INR' : 'USDT') as MarginCurrency,
  conversionRate: process.env.CONVERSION_RATE || '102',

  // Stop-Loss (100%) and Profit-Target (55% of combined credit)
  riskConfig: {
    stopLossMultiplier: getEnvNumber('SL_MULTIPLIER', 2.0), // 100% loss (entry * 2.0)
    profitTargetRatio: getEnvNumber('PROFIT_TARGET_RATIO', 0.55), // 55% of total credit
    pollIntervalMs: getEnvNumber('POLL_INTERVAL_MS', 2000), // Check positions every 2 seconds
    maxMonitorMinutes: getEnvNumber('MAX_MONITOR_MINUTES', 720), // 12 hours cutoff by default
  },
  customCallSymbol: process.env.CUSTOM_CALL_SYMBOL || undefined,
  customPutSymbol: process.env.CUSTOM_PUT_SYMBOL || undefined,
};


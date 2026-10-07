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
  readonly reportDelayMinutes?: number;
  readonly reportGitAuthorName?: string;
  readonly reportGitAuthorEmail?: string;
  readonly recordDir?: string;
  readonly verificationTolerance?: number;
  readonly checkpointIntervalMs?: number;
  readonly walletPageCap?: number;
  readonly positionTruthGraceMs?: number;
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
    slOverrunTolerance: getEnvNumber('SL_OVERRUN_TOLERANCE', 0.10), // 10% overrun before emergency fallback close
    costStopEnabled: process.env.COST_STOP_ENABLED !== 'false', // Enabled by default
    costStopBufferPoints: (() => {
      const rawVal = process.env.COST_STOP_BUFFER_POINTS;
      if (rawVal !== undefined && rawVal.trim() !== '') {
        const parsed = Number(rawVal.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(
            `COST_STOP_BUFFER_POINTS must be > 0 (buffer of 0 is unconstructible for short stops, received "${rawVal}")`
          );
        }
        return parsed;
      }
      return 20;
    })(),
    costStopOnOverdue: (process.env.COST_STOP_ON_OVERDUE === 'close' ? 'close' : 'keep') as 'keep' | 'close',
  },
  customCallSymbol: process.env.CUSTOM_CALL_SYMBOL || undefined,
  customPutSymbol: process.env.CUSTOM_PUT_SYMBOL || undefined,
  reportDelayMinutes: parseOptionalIntInRange('REPORT_DELAY_MINUTES', 15, 0, 180),
  reportGitAuthorName: process.env.REPORT_GIT_AUTHOR_NAME || 'btc-straddle-0dte bot',
  reportGitAuthorEmail: process.env.REPORT_GIT_AUTHOR_EMAIL || 'bot@straddle-btc-0dte.local',
  recordDir: process.env.RECORD_DIR || undefined,
  verificationTolerance: getEnvNumber('VERIFICATION_TOLERANCE', 1.0),
  checkpointIntervalMs: getEnvNumber('CHECKPOINT_INTERVAL_MS', 300_000), // 5 minutes
  walletPageCap: parseOptionalIntInRange('WALLET_PAGE_CAP', 10, 1, 50),
  positionTruthGraceMs: getEnvNumber('POSITION_TRUTH_GRACE_MS', 60000),
};


import fs from 'fs';
import {
  ensureRecordsDirectory,
  getRecordJsonlPath,
  getRecordMtmPath,
  getRecordSummaryPath,
} from './cycleRecordPaths';
import {
  CycleEventPayload,
  CycleEventType,
  CycleSummarySnapshot,
  MtmTapeSample,
} from './cycleRecordTypes';

const CURRENT_SCHEMA_VERSION = 1;

/**
 * Returns current timestamp in ISO-8601 format with +05:30 (IST offset).
 */
export function formatIstIso(date = new Date()): string {
  const istOffsetMs = 330 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffsetMs);
  const isoStr = istDate.toISOString(); // e.g. 2026-10-05T14:46:12.000Z
  return isoStr.slice(0, 19) + '+05:30';
}

/**
 * Recursively scrubs credentials, auth tokens, and sensitive keys from any recorded payload.
 */
export function scrubCredentials<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Scrub JWT tokens or bearer tokens
    if (/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(obj)) {
      return '[SCRUBBED_JWT]' as unknown as T;
    }
    if (obj.toLowerCase().includes('bearer ')) {
      return '[SCRUBBED_BEARER]' as unknown as T;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => scrubCredentials(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('authorization') ||
        lowerKey.includes('bearertoken') ||
        lowerKey.includes('bearer_token') ||
        lowerKey.includes('sessiontoken') ||
        lowerKey.includes('session_token') ||
        lowerKey.includes('apisecret') ||
        lowerKey.includes('api_secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('totp')
      ) {
        copy[key] = '[SCRUBBED_CREDENTIAL]';
      } else {
        copy[key] = scrubCredentials(val);
      }
    }
    return copy as unknown as T;
  }
  return obj;
}

export class CycleRecordWriter {
  private readonly cycle: string;
  private readonly jsonlPath: string;
  private readonly mtmPath: string;
  private readonly summaryPath: string;

  constructor(expiryDateStr: string) {
    this.cycle = expiryDateStr;
    ensureRecordsDirectory();
    this.jsonlPath = getRecordJsonlPath(expiryDateStr);
    this.mtmPath = getRecordMtmPath(expiryDateStr);
    this.summaryPath = getRecordSummaryPath(expiryDateStr);
  }

  /**
   * Appends an event to records/<expiry>.jsonl.
   * Synchronous atomic append to ensure write order without read-modify-write.
   */
  public appendEvent(
    event: CycleEventType,
    data: Record<string, unknown>,
    ts = formatIstIso()
  ): void {
    const payload: CycleEventPayload = {
      ts,
      event,
      cycle: this.cycle,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      data: scrubCredentials(data),
    };

    const line = JSON.stringify(payload) + '\n';
    try {
      fs.appendFileSync(this.jsonlPath, line, 'utf8');
    } catch (err) {
      console.error(`[CycleRecordWriter] Failed to append event ${event} to ${this.jsonlPath}:`, err);
    }
  }

  /**
   * Appends an MTM observation to records/<expiry>.mtm.jsonl.
   */
  public appendMtmTape(sample: MtmTapeSample): void {
    const scrubbed = scrubCredentials(sample);
    const line = JSON.stringify(scrubbed) + '\n';
    try {
      fs.appendFileSync(this.mtmPath, line, 'utf8');
    } catch (err) {
      console.error(`[CycleRecordWriter] Failed to append MTM sample to ${this.mtmPath}:`, err);
    }
  }

  /**
   * Atomically writes or updates records/<expiry>.summary.json via temp file + rename.
   */
  public writeSummarySnapshot(snapshot: CycleSummarySnapshot): void {
    const scrubbed = scrubCredentials(snapshot);
    const content = JSON.stringify(scrubbed, null, 2);
    const tmpPath = `${this.summaryPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, this.summaryPath);
    } catch (err) {
      console.error(`[CycleRecordWriter] Failed to atomically write summary to ${this.summaryPath}:`, err);
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Ignore unlink error
      }
    }
  }

  /**
   * Reads all parsed events from records/<expiry>.jsonl.
   */
  public readEvents(): CycleEventPayload[] {
    if (!fs.existsSync(this.jsonlPath)) return [];
    try {
      const content = fs.readFileSync(this.jsonlPath, 'utf8');
      const lines = content.split('\n');
      const events: CycleEventPayload[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as CycleEventPayload);
        } catch {
          // Ignore corrupted line
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  /**
   * Reads all MTM tape samples from records/<expiry>.mtm.jsonl.
   */
  public readMtmTape(): MtmTapeSample[] {
    if (!fs.existsSync(this.mtmPath)) return [];
    try {
      const content = fs.readFileSync(this.mtmPath, 'utf8');
      const lines = content.split('\n');
      const samples: MtmTapeSample[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          samples.push(JSON.parse(trimmed) as MtmTapeSample);
        } catch {
          // Ignore corrupted line
        }
      }
      return samples;
    } catch {
      return [];
    }
  }

  /**
   * Reads the materialized summary snapshot if it exists.
   */
  public readSummarySnapshot(): CycleSummarySnapshot | null {
    if (!fs.existsSync(this.summaryPath)) return null;
    try {
      const content = fs.readFileSync(this.summaryPath, 'utf8');
      return JSON.parse(content) as CycleSummarySnapshot;
    } catch {
      return null;
    }
  }
}

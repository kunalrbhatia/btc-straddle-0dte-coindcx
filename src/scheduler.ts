/**
 * Indian Standard Time (IST) scheduler utilities.
 * IST is fixed at UTC+5:30 (no Daylight Saving Time).
 */

const IST_OFFSET_MINUTES = 330; // 5 hours 30 minutes in minutes
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface ScheduledTimeInfo {
  readonly targetUtc: Date;
  readonly delayMs: number;
  readonly istTargetFormatted: string;
}

/**
 * Calculates the exact UTC Date and millisecond delay for the next occurrence
 * of a given time in Indian Standard Time (e.g. 18:15 IST).
 */
export function calculateNextOccurrenceIST(
  targetHourIST: number,
  targetMinuteIST: number,
  targetSecondIST = 0
): ScheduledTimeInfo {
  const nowUtcMs = Date.now();
  const nowIstMs = nowUtcMs + IST_OFFSET_MINUTES * MS_PER_MINUTE;
  const istDateObj = new Date(nowIstMs);

  const istYear = istDateObj.getUTCFullYear();
  const istMonth = istDateObj.getUTCMonth();
  const istDate = istDateObj.getUTCDate();

  // Target time in IST as UTC timestamp representation
  const targetTodayIstMs = Date.UTC(
    istYear,
    istMonth,
    istDate,
    targetHourIST,
    targetMinuteIST,
    targetSecondIST,
    0
  );

  let targetIstMs = targetTodayIstMs;
  if (nowIstMs >= targetTodayIstMs) {
    // Target time for today has already passed, schedule for tomorrow
    targetIstMs += MS_PER_DAY;
  }

  // Convert IST representation back to actual UTC epoch milliseconds
  const targetUtcMs = targetIstMs - IST_OFFSET_MINUTES * MS_PER_MINUTE;
  const delayMs = targetUtcMs - nowUtcMs;

  const targetDateObj = new Date(targetIstMs);
  const istFormatted = `${targetDateObj.getUTCFullYear()}-${String(
    targetDateObj.getUTCMonth() + 1
  ).padStart(2, '0')}-${String(targetDateObj.getUTCDate()).padStart(2, '0')} ` +
    `${String(targetHourIST).padStart(2, '0')}:${String(targetMinuteIST).padStart(2, '0')}:${String(
      targetSecondIST
    ).padStart(2, '0')} IST`;

  return {
    targetUtc: new Date(targetUtcMs),
    delayMs,
    istTargetFormatted: istFormatted,
  };
}

/**
 * Schedules a callback to trigger at the designated IST time — and RE-ARMS
 * itself for the next occurrence after every run.
 *
 * The re-arm matters: this was previously a one-shot setTimeout, so the bot
 * only traded once per process start and relied entirely on the daily PM2
 * `cron_restart` to arm the next day's entry. If that restart is ever removed
 * or retimed, the bot would silently stop trading after day one.
 */
export function scheduleAtIST(
  targetHourIST: number,
  targetMinuteIST: number,
  callback: () => Promise<void>
): void {
  const arm = (): void => {
    const scheduleInfo = calculateNextOccurrenceIST(targetHourIST, targetMinuteIST);

    console.log(`[Scheduler] Next execution set for: ${scheduleInfo.istTargetFormatted}`);
    console.log(`[Scheduler] Waiting ${Math.round(scheduleInfo.delayMs / 1000)} seconds...`);

    setTimeout(() => {
      void (async () => {
        try {
          await callback();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[Scheduler] Scheduled run failed: ${msg}`);
        } finally {
          // Re-arm for the next occurrence (typically tomorrow, if today's
          // target time has already passed).
          arm();
        }
      })();
    }, scheduleInfo.delayMs);
  };

  arm();
}

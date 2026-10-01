import { LOCAL_TIME_PATTERN, isValidTimeZone, toLocalTime, todayIn } from '../lib/local-date.js';
import type { JobLogger } from './nightly-pattern-detection.js';

/**
 * Fires a task once a day at a wall-clock time in one timezone (`CRON_TIMEZONE`, D11).
 *
 * No cron library: a one-minute tick compares the wall clock in that timezone with the
 * target time and fires on the first tick at or after it, once per local date. That is all
 * one daily job needs, and it is DST-safe without special cases — a 02:15 that a spring-forward
 * skips fires at the first tick after it, and a 02:15 that a fall-back repeats fires once,
 * because the date has already fired.
 *
 * - Started after the day's time has passed, it does **not** fire for that day: a deploy at
 *   noon must not trigger a run. The next run is tomorrow's.
 * - It never overlaps itself: a tick while the task is still running does nothing.
 * - `stop()` clears the timer and waits for a running task to finish.
 */
export interface DailyTriggerOptions {
  /** `HH:MM`, 24-hour, in `timeZone`. */
  at: string;
  timeZone: string;
  task: (firedAt: Date) => Promise<unknown>;
  logger: JobLogger;
  now?: () => Date;
  tickMs?: number;
}

export class DailyTrigger {
  private readonly now: () => Date;
  private readonly tickMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private lastFiredDate: string | undefined;

  constructor(private readonly options: DailyTriggerOptions) {
    if (!LOCAL_TIME_PATTERN.test(options.at)) throw new Error(`trigger time must be HH:MM: ${options.at}`);
    if (!isValidTimeZone(options.timeZone)) throw new Error(`not a valid timezone: ${options.timeZone}`);
    this.now = options.now ?? (() => new Date());
    this.tickMs = options.tickMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    const now = this.now();
    // Already past today's time: today's run is not owed to this process.
    if (toLocalTime(now, this.options.timeZone) >= this.options.at) {
      this.lastFiredDate = todayIn(this.options.timeZone, now);
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  /** One check of the clock. Public so a test can drive the trigger without real time. */
  tick(): Promise<void> | undefined {
    if (this.running) return undefined;
    const now = this.now();
    const date = todayIn(this.options.timeZone, now);
    if (date === this.lastFiredDate || toLocalTime(now, this.options.timeZone) < this.options.at) return undefined;

    this.lastFiredDate = date;
    this.running = this.options
      .task(now)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.logger.error(
          { err: error instanceof Error ? { name: error.name, message: error.message } : String(error) },
          'scheduled task failed',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}

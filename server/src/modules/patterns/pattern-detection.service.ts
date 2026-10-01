import { NotFoundError } from '../../lib/errors.js';
import { todayIn } from '../../lib/local-date.js';
import { decideAbsence, isHistoricalRun } from '../../patterns/lifecycle.js';
import { extractDailyFeatures, type DailyFeatures } from '../../patterns/metrics.js';
import { toDetectedPattern } from '../../patterns/persistence.js';
import {
  detectionRange,
  detectorWindowsEnding,
  emittingFamilies,
  runApprovedDetectors,
  type DetectorFamily,
  type DetectorResult,
  type DetectorWindows,
} from '../../patterns/registry.js';
import { assertClosedDay } from '../summaries/closed-day.service.js';
import type { DailySummariesRepository } from '../summaries/daily-summaries.repository.js';
import type { UsersRepository } from '../users/users.repository.js';
import type { DetectionOutcome, PatternsRepository } from './patterns.repository.js';

/**
 * One detection run: one user, one closed local day (PATTERN_ENGINE.md §4, D11, D15).
 *
 * Orchestration only. It reads the user's day features, hands them to the registry's
 * `runApprovedDetectors` — the only place that knows which families and pairs may emit —
 * maps each result with `toDetectedPattern`, and persists through `PatternsRepository`.
 * It computes no statistic, names no metric pair and applies no gate.
 *
 * ## The run
 *
 * 1. `targetDate` must be a real local date **before** the user's today: detection reads
 *    closed days only, and a date that is not closed is refused, never shifted.
 * 2. Day features for the windows ending on `targetDate` are read from `daily_summaries`.
 * 3. The approved detectors run (pure); every result is checked against the persistence
 *    contract before anything is written.
 * 4. In one transaction holding the user's pattern lock: each detection is recorded
 *    (`created`, `redetected`, `reactivated`, `suppressed`, `outdated`), then every
 *    **active** pattern of this user that the run did not return goes stale — unless the
 *    stored evidence is newer than this run.
 *
 * Staleness comes from the run's result set, not from timestamps: a pattern absent from
 * this run is one the data no longer supports at the gates, whatever the reason. Stale and
 * dismissed rows are never touched by reconciliation, and nothing is deleted here.
 *
 * Running the same user and date twice leaves one row per key — `(user_id, key)` and the
 * lifecycle are what make it idempotent; there is no run ledger.
 *
 * ## Historical runs (D17)
 *
 * The user's watermark (`pattern_watermarks.evaluated_through`) is the latest day an
 * authoritative run completed. A run for an **earlier** day is historical: it detects, but
 * records no lifecycle change at all — no creation, no re-detection, no reactivation, no
 * staleness — so older evidence can never override what a newer run decided. A run on or
 * after the watermark is authoritative and moves the watermark to its day. Re-running the
 * watermark's own day is authoritative too: that is how a corrected day is re-evaluated.
 *
 * It reads the summaries as they are. Finalising a closed day first is the caller's step
 * (`ClosedDayPatternProcessor`).
 *
 * A failure — unknown user, a date that is not closed, a read, a detector, a write — throws.
 * A run that found nothing returns a result with zero detections; the two never look alike.
 */

export interface DetectionRunResult {
  userId: string;
  targetDate: string;
  /** The days the run read: the earliest window start to `targetDate`. */
  windowStart: string;
  windowEnd: string;
  /** The families that ran — those the registry lets emit. */
  detectorsRun: DetectorFamily[];
  /** Results that passed every gate in this run. */
  detectionsEmitted: number;
  patternsCreated: number;
  patternsRedetected: number;
  patternsReactivated: number;
  /** Dismissed within the cooldown: the detection was ignored. */
  detectionsSuppressed: number;
  /** Older than the stored evidence: the detection was ignored. */
  detectionsOutdated: number;
  /** Active patterns this run did not return, now stale. */
  patternsStaled: number;
  /**
   * The run's day was before the user's watermark: nothing was written, and every detection
   * is counted in `detectionsOutdated`.
   */
  historical: boolean;
}

/** The structured logger's two calls this service uses (pino / Fastify's logger). */
export interface DetectionLogger {
  info(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface PatternDetectionDeps {
  users: Pick<UsersRepository, 'findActiveById'>;
  summaries: Pick<DailySummariesRepository, 'findRange'>;
  patterns: Pick<PatternsRepository, 'withUserLock'>;
  logger: DetectionLogger;
  /** Defaults to the registry's runner; injectable so a failing detector can be tested. */
  detect?: (features: readonly DailyFeatures[], windows: DetectorWindows) => DetectorResult[];
  now?: () => Date;
}

const OUTCOME_FIELD: Record<DetectionOutcome, keyof DetectionRunResult> = {
  created: 'patternsCreated',
  redetected: 'patternsRedetected',
  reactivated: 'patternsReactivated',
  suppressed: 'detectionsSuppressed',
  outdated: 'detectionsOutdated',
};

export class PatternDetectionService {
  private readonly detect: NonNullable<PatternDetectionDeps['detect']>;
  private readonly now: () => Date;

  constructor(private readonly deps: PatternDetectionDeps) {
    this.detect = deps.detect ?? runApprovedDetectors;
    this.now = deps.now ?? (() => new Date());
  }

  async runForUser(userId: string, targetDate: string): Promise<DetectionRunResult> {
    const user = await this.deps.users.findActiveById(userId);
    if (!user) throw new NotFoundError('User not found');

    const now = this.now();
    assertClosedDay(targetDate, todayIn(user.timezone, now));

    const windows = detectorWindowsEnding(targetDate);
    const range = detectionRange(windows);
    const context = { userId, targetDate, windowStart: range.from, windowEnd: range.to };

    try {
      const rows = await this.deps.summaries.findRange(userId, range.from, range.to);
      const results = this.detect(rows.map(extractDailyFeatures), windows);
      // Checked before the transaction opens: a malformed result writes nothing.
      const detected = results.map(toDetectedPattern);

      const result: DetectionRunResult = {
        userId,
        targetDate,
        windowStart: range.from,
        windowEnd: range.to,
        detectorsRun: emittingFamilies(),
        detectionsEmitted: detected.length,
        patternsCreated: 0,
        patternsRedetected: 0,
        patternsReactivated: 0,
        detectionsSuppressed: 0,
        detectionsOutdated: 0,
        patternsStaled: 0,
        historical: false,
      };

      await this.deps.patterns.withUserLock(userId, async (repository) => {
        if (isHistoricalRun(targetDate, await repository.evaluatedThrough(userId))) {
          result.historical = true;
          result.detectionsOutdated = detected.length;
          return;
        }

        for (const detection of detected) {
          const { outcome } = await repository.recordDetection(userId, detection, now);
          (result[OUTCOME_FIELD[outcome]] as number) += 1;
        }

        const found = new Set(detected.map((detection) => detection.key));
        for (const pattern of await repository.listActive(userId)) {
          if (found.has(pattern.key)) continue;
          if (decideAbsence(pattern, targetDate) === 'outdated') continue;
          if (await repository.markStale(userId, pattern.key, now)) result.patternsStaled += 1;
        }

        await repository.advanceEvaluatedThrough(userId, targetDate, now);
      });

      this.deps.logger.info(
        {
          ...context,
          detectorsRun: result.detectorsRun,
          detectionsEmitted: result.detectionsEmitted,
          patternsCreated: result.patternsCreated,
          patternsRedetected: result.patternsRedetected,
          patternsReactivated: result.patternsReactivated,
          detectionsSuppressed: result.detectionsSuppressed,
          detectionsOutdated: result.detectionsOutdated,
          patternsStaled: result.patternsStaled,
          historical: result.historical,
        },
        'pattern detection run complete',
      );
      return result;
    } catch (error) {
      // The error's name and message only: never the user's day data.
      this.deps.logger.error(
        { ...context, err: error instanceof Error ? { name: error.name, message: error.message } : String(error) },
        'pattern detection run failed',
      );
      throw error;
    }
  }
}

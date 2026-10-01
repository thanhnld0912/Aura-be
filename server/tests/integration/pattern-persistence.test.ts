import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addLocalDays } from '../../src/lib/local-date.js';
import { PatternsRepository } from '../../src/modules/patterns/patterns.repository.js';
import { detectCorrelations } from '../../src/patterns/correlation.js';
import { windowEnding } from '../../src/patterns/coverage.js';
import { METRIC_KEYS, type DailyFeatures, type MetricKey } from '../../src/patterns/metrics.js';
import { toDetectedPattern, type DetectedPattern } from '../../src/patterns/persistence.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * `patterns` and `PatternsRepository` against PostgreSQL: identity, the lifecycle
 * transitions, the table's own constraints, and retention. Detections are real detector
 * output — correlation results from `detectCorrelations`, mapped by `toDetectedPattern` —
 * and the clock is passed explicitly so the 60- and 30-day rules are exact.
 */
describe.skipIf(!hasDatabase)('pattern persistence', () => {
  let harness: DatabaseHarness;
  let repository: PatternsRepository;

  const userA = testUserId('a');
  const userB = testUserId('b');

  const DAY_MS = 86_400_000;
  const T0 = new Date('2026-05-01T02:15:00Z');
  const at = (days: number) => new Date(T0.getTime() + days * DAY_MS);

  const EMPTY = Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<MetricKey, number | null>;

  /**
   * Both approved pairs, strongly correlated, over the 30 days ending `windowEnd`. `shift`
   * varies the values a little so a later detection carries different evidence.
   */
  function detections(windowEnd: string, shift = 0): DetectedPattern[] {
    const window = windowEnding(windowEnd, 30);
    const features: DailyFeatures[] = Array.from({ length: 30 }, (_, i) => {
      const gap = 2 + ((i + shift) % 12);
      const mood = ((i + shift) % 4) + 1;
      return {
        localDate: addLocalDays(window.from, i),
        observed: true,
        values: {
          ...EMPTY,
          logging_gap_hours: gap,
          meals_logged: Math.max(0, 5 - Math.floor(gap / 3)),
          mood_score: mood,
          plan_adherence_pct: mood * 20 + (i % 3) * 5,
        },
      };
    });
    const results = detectCorrelations(features, window);
    expect(results).toHaveLength(2);
    return results.map(toDetectedPattern);
  }

  const gapMeals = (windowEnd = '2026-04-30', shift = 0) =>
    detections(windowEnd, shift).find((d) => d.key === 'correlation:logging_gap_hours:meals_logged')!;
  const moodAdherence = (windowEnd = '2026-04-30') =>
    detections(windowEnd).find((d) => d.key === 'correlation:mood_score:plan_adherence_pct')!;

  const count = async () => (await harness.sql`select count(*)::int as c from patterns`)[0]?.['c'];

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    repository = new PatternsRepository(harness.database.db);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    for (const [sub, email] of [
      [userA, 'a@example.com'],
      [userB, 'b@example.com'],
    ] as const) {
      const token = await signTestToken({ sub, email });
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
    }
  });

  describe('creation', () => {
    it('stores a new detection as one active pattern with all three timestamps set', async () => {
      const detected = gapMeals();
      const { outcome, pattern } = await repository.recordDetection(userA, detected, T0);

      expect(outcome).toBe('created');
      expect(pattern).toMatchObject({
        userId: userA,
        key: 'correlation:logging_gap_hours:meals_logged',
        kind: 'correlation',
        subjectMetric: 'logging_gap_hours',
        objectMetric: 'meals_logged',
        direction: 'negative',
        status: 'active',
        detectorVersion: 'correlation@1',
        windowStart: '2026-04-01',
        windowEnd: '2026-04-30',
        windowDays: 30,
        firstDetectedAt: T0,
        lastDetectedAt: T0,
        statusChangedAt: T0,
      });
      expect(await count()).toBe(1);
    });

    it('stores the detector values exactly — strength, p-value, coverage and evidence round-trip', async () => {
      const detected = gapMeals();
      await repository.recordDetection(userA, detected, T0);
      const stored = await repository.findByUserAndKey(userA, detected.key);

      expect(stored?.strength).toBe(detected.strength);
      expect(stored?.pValue).toBe(detected.pValue);
      expect(stored?.coverage).toBe(detected.coverage);
      expect(stored?.sampleSize).toBe(detected.sampleSize);
      expect(stored?.evidence).toEqual(detected.evidence);
    });
  });

  describe('identity: (user_id, key)', () => {
    it('updates the same row when the same user and key are detected again', async () => {
      const first = await repository.recordDetection(userA, gapMeals(), T0);
      const again = await repository.recordDetection(userA, gapMeals('2026-05-01', 1), at(1));

      expect(again.pattern.id).toBe(first.pattern.id);
      expect(await count()).toBe(1);
    });

    it('keeps one row whatever the window — the window is evidence, not identity', async () => {
      const wider = { ...gapMeals('2026-05-01', 1) };
      await repository.recordDetection(userA, gapMeals(), T0);
      await repository.recordDetection(userA, wider, at(1));
      expect(await count()).toBe(1);
    });

    it('creates a separate row for a different key', async () => {
      await repository.recordDetection(userA, gapMeals(), T0);
      await repository.recordDetection(userA, moodAdherence(), T0);
      expect(await count()).toBe(2);
    });

    it('creates a separate row for each user with the same key', async () => {
      const a = await repository.recordDetection(userA, gapMeals(), T0);
      const b = await repository.recordDetection(userB, gapMeals(), T0);

      expect(a.pattern.id).not.toBe(b.pattern.id);
      expect(await count()).toBe(2);
    });

    it('makes two simultaneous first detections one row', async () => {
      const outcomes = await Promise.all([
        repository.recordDetection(userA, gapMeals(), T0),
        repository.recordDetection(userA, gapMeals(), T0),
      ]);

      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['created', 'redetected']);
      expect(await count()).toBe(1);
    });

    it('refuses a second row for the same user and key at the database', async () => {
      await repository.recordDetection(userA, gapMeals(), T0);
      await expect(
        harness.sql`
          insert into patterns (user_id, key, kind, subject_metric, object_metric, direction, strength, p_value,
            sample_size, coverage, window_start, window_end, window_days, evidence, detector_version,
            first_detected_at, last_detected_at, status_changed_at)
          select user_id, key, kind, subject_metric, object_metric, direction, strength, p_value,
            sample_size, coverage, window_start, window_end, window_days, evidence, detector_version,
            first_detected_at, last_detected_at, status_changed_at
          from patterns`,
      ).rejects.toThrow(/uq_patterns_user_key/);
    });
  });

  describe('re-detection of an active pattern', () => {
    it('moves last_detected_at and the evidence, and nothing else', async () => {
      await repository.recordDetection(userA, gapMeals(), T0);
      const later = gapMeals('2026-05-01', 1);
      const { outcome, pattern } = await repository.recordDetection(userA, later, at(1));

      expect(outcome).toBe('redetected');
      expect(pattern.status).toBe('active');
      expect(pattern.firstDetectedAt).toEqual(T0);
      expect(pattern.lastDetectedAt).toEqual(at(1));
      expect(pattern.statusChangedAt).toEqual(T0);
      expect(pattern.windowEnd).toBe('2026-05-01');
      expect(pattern.evidence).toEqual(later.evidence);
    });

    it('produces the same row when the same detection is recorded twice', async () => {
      await repository.recordDetection(userA, gapMeals(), T0);
      const once = await repository.findByUserAndKey(userA, gapMeals().key);
      await repository.recordDetection(userA, gapMeals(), T0);
      const twice = await repository.findByUserAndKey(userA, gapMeals().key);

      expect(twice).toEqual(once);
    });

    it('ignores a detection whose window ends before the stored one', async () => {
      await repository.recordDetection(userA, gapMeals('2026-05-01', 1), T0);
      const { outcome, pattern } = await repository.recordDetection(userA, gapMeals('2026-04-30'), at(1));

      expect(outcome).toBe('outdated');
      expect(pattern.windowEnd).toBe('2026-05-01');
      expect(pattern.lastDetectedAt).toEqual(T0);
    });
  });

  describe('stale', () => {
    it('marks only an active pattern stale, and moves status_changed_at', async () => {
      await repository.recordDetection(userA, gapMeals(), T0);
      const stale = await repository.markStale(userA, gapMeals().key, at(1));

      expect(stale).toMatchObject({ status: 'stale', statusChangedAt: at(1), lastDetectedAt: T0, firstDetectedAt: T0 });
      expect(await repository.markStale(userA, gapMeals().key, at(2))).toBeUndefined();
      expect(await repository.markStale(userB, gapMeals().key, at(2))).toBeUndefined();
    });

    it('reactivates when detected again, keeping first_detected_at', async () => {
      await repository.recordDetection(userA, gapMeals(), T0);
      await repository.markStale(userA, gapMeals().key, at(1));
      const { outcome, pattern } = await repository.recordDetection(userA, gapMeals('2026-05-03', 3), at(3));

      expect(outcome).toBe('reactivated');
      expect(pattern).toMatchObject({
        status: 'active',
        firstDetectedAt: T0,
        lastDetectedAt: at(3),
        statusChangedAt: at(3),
      });
    });
  });

  describe('dismissal and its 60-day cooldown', () => {
    async function dismissedAt(days: number) {
      const { pattern } = await repository.recordDetection(userA, gapMeals(), T0);
      const dismissed = await repository.dismiss(userA, pattern.id, at(days));
      expect(dismissed).toMatchObject({ status: 'dismissed', statusChangedAt: at(days) });
      return pattern;
    }

    it('leaves a pattern dismissed when it is detected within 60 days of the dismissal', async () => {
      await dismissedAt(1);
      const { outcome, pattern } = await repository.recordDetection(userA, gapMeals('2026-06-29', 2), at(60.99));

      expect(outcome).toBe('suppressed');
      expect(pattern).toMatchObject({ status: 'dismissed', statusChangedAt: at(1), lastDetectedAt: T0 });
      expect(pattern.windowEnd).toBe('2026-04-30');
    });

    it('reactivates it when detected 60 days or more after the dismissal', async () => {
      await dismissedAt(1);
      const later = gapMeals('2026-06-30', 2);
      const { outcome, pattern } = await repository.recordDetection(userA, later, at(61));

      expect(outcome).toBe('reactivated');
      expect(pattern).toMatchObject({
        status: 'active',
        firstDetectedAt: T0,
        lastDetectedAt: at(61),
        statusChangedAt: at(61),
        windowEnd: '2026-06-30',
      });
      expect(pattern.evidence).toEqual(later.evidence);
    });

    it('does not restart the cooldown when dismissed twice', async () => {
      const pattern = await dismissedAt(1);
      const again = await repository.dismiss(userA, pattern.id, at(10));
      expect(again).toMatchObject({ status: 'dismissed', statusChangedAt: at(1) });
    });

    it('dismisses a stale pattern too, and is not overridden by staleness', async () => {
      const { pattern } = await repository.recordDetection(userA, gapMeals(), T0);
      await repository.markStale(userA, pattern.key, at(1));
      expect(await repository.dismiss(userA, pattern.id, at(2))).toMatchObject({ status: 'dismissed' });
      expect(await repository.markStale(userA, pattern.key, at(3))).toBeUndefined();
    });

    it('cannot dismiss another user pattern — the answer is the same as for a missing id', async () => {
      const { pattern } = await repository.recordDetection(userB, gapMeals(), T0);

      expect(await repository.dismiss(userA, pattern.id, at(1))).toBeUndefined();
      expect(await repository.dismiss(userA, '00000000-0000-4000-8000-000000000000', at(1))).toBeUndefined();
      expect((await repository.findByUserAndKey(userB, pattern.key))?.status).toBe('active');
      expect(await repository.findByUserAndKey(userA, pattern.key)).toBeUndefined();
    });
  });

  describe('retention', () => {
    it('deletes patterns stale for 30 days or more — and only those', async () => {
      // A: stale at day 1. B: stale at day 10. A's other key: active. B's other key: dismissed at day 1.
      await repository.recordDetection(userA, gapMeals(), T0);
      await repository.recordDetection(userA, moodAdherence(), T0);
      const { pattern: bDismissed } = await repository.recordDetection(userB, moodAdherence(), T0);
      await repository.recordDetection(userB, gapMeals(), T0);
      await repository.markStale(userA, gapMeals().key, at(1));
      await repository.markStale(userB, gapMeals().key, at(10));
      await repository.dismiss(userB, bDismissed.id, at(1));

      expect(await repository.deleteExpiredStale(at(30.99))).toBe(0);
      expect(await repository.deleteExpiredStale(at(31))).toBe(1);
      expect(await repository.findByUserAndKey(userA, gapMeals().key)).toBeUndefined();
      expect((await repository.findByUserAndKey(userB, gapMeals().key))?.status).toBe('stale');

      expect(await repository.deleteExpiredStale(at(365))).toBe(1);
      const remaining = await harness.sql`select user_id, status from patterns order by user_id`;
      expect(remaining.map((r) => r['status']).sort()).toEqual(['active', 'dismissed']);
    });

    it('goes with the user when the user row is deleted', async () => {
      await repository.recordDetection(userA, gapMeals(), T0);
      await harness.sql`delete from users where id = ${userA}`;
      expect(await count()).toBe(0);
    });
  });

  describe('table constraints', () => {
    /** A valid correlation row for user A, with any column overridden as raw SQL values. */
    async function insertRow(overrides: Record<string, unknown>) {
      const row = {
        user_id: userA,
        key: 'correlation:logging_gap_hours:meals_logged',
        kind: 'correlation',
        subject_metric: 'logging_gap_hours',
        object_metric: 'meals_logged',
        direction: 'negative',
        strength: 0.5,
        p_value: 0.01,
        sample_size: 20,
        coverage: 0.8,
        window_start: '2026-04-01',
        window_end: '2026-04-30',
        window_days: 30,
        evidence: harness.sql.json({ points: [] }),
        detector_version: 'correlation@1',
        first_detected_at: T0,
        last_detected_at: T0,
        status_changed_at: T0,
        ...overrides,
      };
      await harness.sql`insert into patterns ${harness.sql(row)}`;
    }

    it.each([0, 0.5, 1])('accepts strength %s', async (strength) => {
      await insertRow({ strength });
      expect(await count()).toBe(1);
    });

    it.each([-0.62, -0.000001, 1.000001, 2])('rejects strength %s', async (strength) => {
      await expect(insertRow({ strength })).rejects.toThrow(/chk_pattern_strength/);
    });

    it('rejects an out-of-range p-value or coverage, and an empty sample', async () => {
      await expect(insertRow({ p_value: 1.1 })).rejects.toThrow(/chk_pattern_p_value/);
      await expect(insertRow({ coverage: -0.1 })).rejects.toThrow(/chk_pattern_coverage/);
      await expect(insertRow({ sample_size: 0 })).rejects.toThrow(/chk_pattern_sample/);
    });

    it('rejects a window whose length does not match its dates', async () => {
      await expect(insertRow({ window_days: 29 })).rejects.toThrow(/chk_pattern_window/);
    });

    it('requires a p-value exactly for the inferential kinds', async () => {
      await expect(insertRow({ p_value: null })).rejects.toThrow(/chk_pattern_inference/);
      await expect(
        insertRow({ kind: 'streak', key: 'streak:events_logged', object_metric: null, direction: 'none' }),
      ).rejects.toThrow(/chk_pattern_inference/);
      await insertRow({ kind: 'streak', key: 'streak:events_logged', object_metric: null, direction: 'none', p_value: null });
    });

    it('requires an object metric for a correlation and a key that starts with its kind', async () => {
      await expect(insertRow({ object_metric: null })).rejects.toThrow(/chk_pattern_object/);
      await expect(insertRow({ key: 'trend:logging_gap_hours' })).rejects.toThrow(/chk_pattern_key_kind/);
    });

    it('rejects a status outside active, stale and dismissed', async () => {
      for (const status of ['candidate', 'shown', 'deleted']) {
        await expect(insertRow({ status })).rejects.toThrow(/invalid input value for enum pattern_status/);
      }
    });
  });
});

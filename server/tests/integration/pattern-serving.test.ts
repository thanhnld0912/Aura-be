import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PatternEvidenceSource } from '../../src/insights/pattern-evidence.js';
import { selectPatternEvidence } from '../../src/insights/pattern-evidence.js';
import { addLocalDays, startOfLocalWeek, todayIn } from '../../src/lib/local-date.js';
import { PatternsEvidenceSource } from '../../src/modules/patterns/patterns-evidence-source.js';
import { PatternsRepository } from '../../src/modules/patterns/patterns.repository.js';
import { detectCorrelations } from '../../src/patterns/correlation.js';
import { windowEnding } from '../../src/patterns/coverage.js';
import { METRIC_KEYS, type DailyFeatures, type MetricKey } from '../../src/patterns/metrics.js';
import { toDetectedPattern, type DetectedPattern } from '../../src/patterns/persistence.js';
import { scorePattern } from '../../src/patterns/ranking.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * Serving persisted patterns, end to end and without mocks:
 *
 *   patterns row → PatternsRepository → PatternsEvidenceSource → selectPatternEvidence
 *   (ranking) → the weekly report at `GET /api/insights/weekly`.
 *
 * The rows are real detector output (`detectCorrelations` → `toDetectedPattern`) written by
 * the repository. The report runs on the real clock, so dates are taken relative to today.
 */
describe.skipIf(!hasDatabase)('pattern serving', () => {
  let harness: DatabaseHarness;
  let repository: PatternsRepository;
  let source: PatternsEvidenceSource;
  let tokenA: string;
  let tokenB: string;

  const userA = testUserId('a');
  const userB = testUserId('b');
  const TIMEZONE = 'Asia/Ho_Chi_Minh';
  const today = () => todayIn(TIMEZONE);
  const yesterday = () => addLocalDays(today(), -1);

  const EMPTY = Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<MetricKey, number | null>;

  /** Both approved pairs over the 30 days ending `windowEnd`; `weaken` lowers the gap pair's |r|. */
  function detections(windowEnd: string, weaken = false): Record<'gapMeals' | 'moodAdherence', DetectedPattern> {
    const window = windowEnding(windowEnd, 30);
    const features: DailyFeatures[] = Array.from({ length: 30 }, (_, i) => {
      const gap = 2 + (i % 12);
      const mood = (i % 4) + 1;
      return {
        localDate: addLocalDays(window.from, i),
        observed: true,
        values: {
          ...EMPTY,
          logging_gap_hours: gap,
          meals_logged: Math.max(0, 5 - Math.floor(gap / 3)) + (weaken && i % 3 === 0 ? 2 : 0),
          mood_score: mood,
          plan_adherence_pct: mood * 20 + (i % 3) * 5,
        },
      };
    });
    const results = detectCorrelations(features, window).map(toDetectedPattern);
    const byKey = (key: string) => {
      const found = results.find((result) => result.key === key);
      if (!found) throw new Error(`fixture did not produce ${key}`);
      return found;
    };
    return {
      gapMeals: byKey('correlation:logging_gap_hours:meals_logged'),
      moodAdherence: byKey('correlation:mood_score:plan_adherence_pct'),
    };
  }

  const weekly = async (token: string, weekStart?: string) => {
    const response = await harness.app.inject({
      method: 'GET',
      url: weekStart ? `/api/insights/weekly?weekStart=${weekStart}` : '/api/insights/weekly',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  beforeAll(async () => {
    // The source needs the harness's own connection, and the app needs the source — the same
    // one-line indirection the other harness-built collaborators use.
    const lazySource: PatternEvidenceSource = {
      forPeriod: (userId, request) => source.forPeriod(userId, request),
    };
    harness = await createDatabaseHarness({ patternEvidence: lazySource });
    repository = new PatternsRepository(harness.database.db);
    source = new PatternsEvidenceSource(repository);
    tokenA = await signTestToken({ sub: userA, email: 'a@example.com' });
    tokenB = await signTestToken({ sub: userB, email: 'b@example.com' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    for (const token of [tokenA, tokenB]) {
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
    }
  });

  it('serves a stored pattern unchanged: the statistics are the detector output', async () => {
    const { gapMeals } = detections(yesterday());
    const { pattern } = await repository.recordDetection(userA, gapMeals, new Date());

    const served = await source.forPeriod(userA, { from: startOfLocalWeek(today()), to: addLocalDays(startOfLocalWeek(today()), 6), today: today() });
    expect(served).toHaveLength(1);
    expect(served![0]).toEqual({
      id: pattern.id,
      key: gapMeals.key,
      kind: 'correlation',
      subjectMetric: 'logging_gap_hours',
      subjectLabel: 'Longest logging gap',
      objectMetric: 'meals_logged',
      objectLabel: 'Meals logged',
      direction: 'negative',
      strength: gapMeals.strength,
      pValue: gapMeals.pValue,
      sampleSize: gapMeals.sampleSize,
      coverage: gapMeals.coverage,
      windowStart: gapMeals.windowStart,
      windowEnd: gapMeals.windowEnd,
      windowDays: 30,
      evidence: gapMeals.evidence,
      detectorVersion: 'correlation@1',
      status: 'active',
      firstDetectedAt: pattern.firstDetectedAt.toISOString(),
      lastDetectedAt: pattern.lastDetectedAt.toISOString(),
      statusChangedAt: pattern.statusChangedAt.toISOString(),
      caveat: 'This is an association in your own logs, not a cause.',
    });
    expect(served![0]!.strength).toBeGreaterThan(0);
  });

  it('ranks the stored patterns and reports them in the weekly report', async () => {
    const strong = detections(yesterday());
    const weak = detections(yesterday(), true);
    await repository.recordDetection(userA, weak.gapMeals, new Date());
    await repository.recordDetection(userA, strong.moodAdherence, new Date());

    const expected = [weak.gapMeals, strong.moodAdherence]
      .map((d) => ({ key: d.key, score: scorePattern({ ...d, lastDetectedAt: new Date().toISOString() }, today())! }))
      .sort((a, b) => b.score - a.score)
      .map((d) => d.key);

    const body = await weekly(tokenA);
    expect(body.patterns.status).toBe('available');
    expect(body.patterns.items.map((item: { subjectMetric: string; objectMetric: string }) =>
      `correlation:${[item.subjectMetric, item.objectMetric].sort().join(':')}`,
    )).toEqual(expected);
    for (const item of body.patterns.items) {
      expect(item.strength).toBeGreaterThanOrEqual(0);
      expect(item.caveat).toBe('This is an association in your own logs, not a cause.');
    }
    expect(body.dataQuality.limitations).not.toContain('pattern_engine_unavailable');
  });

  it('never serves user B patterns to user A, through the source or the report', async () => {
    const { gapMeals, moodAdherence } = detections(yesterday());
    const { pattern: bPattern } = await repository.recordDetection(userB, gapMeals, new Date());
    await repository.recordDetection(userB, moodAdherence, new Date());

    const week = { from: startOfLocalWeek(today()), to: addLocalDays(startOfLocalWeek(today()), 6), today: today() };
    expect(await source.forPeriod(userA, week)).toEqual([]);

    const bodyA = await weekly(tokenA);
    expect(bodyA.patterns).toEqual({ status: 'none', items: [] });

    const bodyB = await weekly(tokenB);
    expect(bodyB.patterns.items.map((item: { id: string }) => item.id)).toContain(bPattern.id);
  });

  it('serves only active patterns — stale and dismissed are not current', async () => {
    const { gapMeals, moodAdherence } = detections(yesterday());
    const { pattern: stale } = await repository.recordDetection(userA, gapMeals, new Date());
    const { pattern: dismissed } = await repository.recordDetection(userA, moodAdherence, new Date());
    await repository.markStale(userA, stale.key, new Date());
    await repository.dismiss(userA, dismissed.id, new Date());

    const week = { from: startOfLocalWeek(today()), to: addLocalDays(startOfLocalWeek(today()), 6), today: today() };
    expect(await source.forPeriod(userA, week)).toEqual([]);
    expect((await weekly(tokenA)).patterns).toEqual({ status: 'none', items: [] });
  });

  it('cannot say what a past week held, and reports that as unavailable — not as none', async () => {
    const { gapMeals } = detections(yesterday());
    await repository.recordDetection(userA, gapMeals, new Date());

    const lastWeek = addLocalDays(startOfLocalWeek(today()), -7);
    const past = await source.forPeriod(userA, { from: lastWeek, to: addLocalDays(lastWeek, 6), today: today() });
    expect(past).toBeNull();
    expect(selectPatternEvidence(past, today())).toEqual({ status: 'unavailable', items: [] });

    const body = await weekly(tokenA, lastWeek);
    expect(body.patterns).toEqual({ status: 'unavailable', items: [] });
    expect(body.dataQuality.limitations).toContain('pattern_engine_unavailable');
  });
});

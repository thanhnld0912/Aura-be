import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addLocalDays } from '../../src/lib/local-date.js';
import { DailySummariesRepository } from '../../src/modules/summaries/daily-summaries.repository.js';
import { detectCorrelations, evaluateCorrelation } from '../../src/patterns/correlation.js';
import { windowEnding } from '../../src/patterns/coverage.js';
import { extractDailyFeatures } from '../../src/patterns/metrics.js';
import { bearer, signTestToken } from '../helpers/app.js';
import {
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * The correlation detector on real data: plans, events and check-ins written through the
 * API, reconciled and summarised by the server, read back as a window, and evaluated.
 * Nothing is inserted directly and nothing is mocked — this is the path the nightly job
 * will take.
 */
describe.skipIf(!hasDatabase)('pattern engine: correlation on real daily data', () => {
  let harness: DatabaseHarness;
  let token: string;
  let summaries: DailySummariesRepository;
  const userId = testUserId('a');

  // Fixed and in the past, so every day is closed and unmatched plan items are not_logged.
  const FIRST_DAY = '2026-03-01';
  const WINDOW = windowEnding('2026-03-14', 14);

  /** Ho Chi Minh City is UTC+7: a local wall-clock time on a local date, as an instant. */
  const utcAt = (localDate: string, localTime: string): string => {
    const [y, mo, d] = localDate.split('-').map(Number) as [number, number, number];
    const [h, mi] = localTime.split(':').map(Number) as [number, number];
    return new Date(Date.UTC(y, mo - 1, d, h - 7, mi)).toISOString();
  };

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    token = await signTestToken({ sub: userId, email: 'thanh@example.com' });
    summaries = new DailySummariesRepository(harness.database.db);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
  });

  const post = async (url: string, payload: Record<string, unknown>) => {
    const response = await harness.app.inject({ method: 'POST', url, headers: bearer(token), payload });
    expect(response.statusCode, `${url} ${response.body}`).toBeLessThan(300);
  };

  /**
   * One day: a two-item plan, `done` of its items actually logged, and the day's check-in.
   * The check-in is written last, so its recompute sees the finished day.
   */
  const logDay = async (localDate: string, mood: 'low' | 'okay' | 'good' | 'great', done: 0 | 1 | 2) => {
    await post('/api/daily-plan', {
      localDate,
      items: [
        { eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' },
        { eventType: 'water', title: 'Drink water', plannedTime: '10:00' },
      ],
    });
    if (done >= 1) await post('/api/events', { type: 'walk', title: 'Walked', occurredAt: utcAt(localDate, '07:05') });
    if (done >= 2) await post('/api/events', { type: 'water', title: 'Water', occurredAt: utcAt(localDate, '10:05') });
    await post('/api/checkins', { localDate, mood });
  };

  it('finds the mood ↔ plan adherence association the logs contain, and nothing it does not', async () => {
    // Twelve logged days in a fourteen-day window (86% coverage). Days that went to plan
    // are the days with a better mood check-in.
    const pattern: Array<['low' | 'okay' | 'good' | 'great', 0 | 1 | 2]> = [
      ['low', 0],
      ['okay', 1],
      ['good', 1],
      ['great', 2],
    ];
    for (let i = 0; i < 12; i++) {
      const [mood, done] = pattern[i % 4]!;
      await logDay(addLocalDays(FIRST_DAY, i), mood, done);
    }

    const rows = await summaries.findRange(userId, WINDOW.from, WINDOW.to);
    expect(rows).toHaveLength(12);
    const features = rows.map(extractDailyFeatures);
    expect(features.slice(0, 4).map((day) => [day.values.mood_score, day.values.plan_adherence_pct])).toEqual([
      [1, 0],
      [2, 50],
      [3, 50],
      [4, 100],
    ]);

    const results = detectCorrelations(features, WINDOW);
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result).toMatchObject({
      kind: 'correlation',
      key: 'correlation:mood_score:plan_adherence_pct',
      subjectMetric: 'mood_score',
      objectMetric: 'plan_adherence_pct',
      direction: 'positive',
      sampleSize: 12,
      windowDays: 14,
      windowStart: '2026-03-01',
      windowEnd: '2026-03-14',
    });
    expect(result!.strength).toBeGreaterThanOrEqual(0.45);
    expect(result!.pValue).toBeLessThan(0.1);
    expect(result!.coverage).toBeCloseTo(12 / 14, 12);
    expect(result!.evidence).toHaveLength(12);

    // The other pair: a 'low' day has a single event (its check-in), so it has no logging
    // gap — null, not 0 — and only the other nine days pair up. It is refused on sample
    // size before its constant meals_logged (no meal was logged) is even considered.
    expect(features.filter((day) => day.values.logging_gap_hours === null)).toHaveLength(3);
    expect(evaluateCorrelation(features, { subject: 'logging_gap_hours', object: 'meals_logged' }, WINDOW)).toMatchObject({
      outcome: 'rejected',
      reason: 'insufficient_sample',
      sampleSize: 9,
    });
  });

  it('finds nothing when too few days are logged', async () => {
    for (let i = 0; i < 9; i++) await logDay(addLocalDays(FIRST_DAY, i), i % 2 ? 'great' : 'low', i % 2 ? 2 : 0);
    const rows = await summaries.findRange(userId, WINDOW.from, WINDOW.to);
    expect(detectCorrelations(rows.map(extractDailyFeatures), WINDOW)).toEqual([]);
    expect(
      evaluateCorrelation(rows.map(extractDailyFeatures), { subject: 'mood_score', object: 'plan_adherence_pct' }, WINDOW),
    ).toMatchObject({ outcome: 'rejected', reason: 'insufficient_sample', sampleSize: 9 });
  });
});

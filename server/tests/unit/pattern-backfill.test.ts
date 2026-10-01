import { describe, expect, it } from 'vitest';
import { PatternBackfill, type PatternBackfillDeps } from '../../src/jobs/pattern-backfill.js';
import type { JobLogger } from '../../src/jobs/nightly-pattern-detection.js';
import { ValidationError } from '../../src/lib/errors.js';
import type { DetectionRunResult } from '../../src/modules/patterns/pattern-detection.service.js';
import { isHistoricalRun } from '../../src/patterns/lifecycle.js';

/**
 * The backfill's own rules — which days, in which order, for whom, and what a failure does —
 * and the watermark rule. The database-backed run is `tests/integration/pattern-backfill.test.ts`.
 */

const silent: JobLogger = { info: () => {}, error: () => {} };
const run = (overrides: Partial<DetectionRunResult> = {}) => ({ historical: false, ...overrides }) as DetectionRunResult;

describe('the watermark rule (D17)', () => {
  it('makes only a day strictly before the watermark historical', () => {
    expect(isHistoricalRun('2026-09-29', '2026-09-30')).toBe(true);
    expect(isHistoricalRun('2026-09-30', '2026-09-30')).toBe(false);
    expect(isHistoricalRun('2026-10-01', '2026-09-30')).toBe(false);
    expect(isHistoricalRun('2026-01-01', null)).toBe(false);
  });
});

describe('a backfill', () => {
  // 19:15 UTC on 1 October: 2 October 02:15 in Ho Chi Minh City, 1 October 15:15 in New York.
  const NOW = new Date('2026-10-01T19:15:00Z');
  type User = { id: string; timezone: string };

  function backfill(users: User[], process: (userId: string, day: string) => Promise<DetectionRunResult> = async () => run()) {
    const calls: Array<[string, string]> = [];
    const deps: PatternBackfillDeps = {
      users: {
        listActiveTimezones: async (afterId) => (afterId === null ? users : []),
        findActiveById: async (id) => users.find((user) => user.id === id) as never,
      },
      processor: {
        process: async (userId, day) => {
          calls.push([userId, day]);
          return process(userId, day);
        },
      },
      logger: silent,
    };
    return { backfill: new PatternBackfill(deps), calls };
  }

  it('processes each user oldest day first, user by user', async () => {
    const b = backfill([
      { id: 'a', timezone: 'Asia/Ho_Chi_Minh' },
      { id: 'b', timezone: 'Asia/Ho_Chi_Minh' },
    ]);
    const result = await b.backfill.run({ from: '2026-09-01', to: '2026-09-07' }, NOW);

    const days = ['01', '02', '03', '04', '05', '06', '07'].map((d) => `2026-09-${d}`);
    expect(b.calls).toEqual([...days.map((d) => ['a', d]), ...days.map((d) => ['b', d])]);
    expect(result).toMatchObject({ users: 2, daysProcessed: 14, daysFailed: 0, daysSkipped: 0, failures: [] });
  });

  it('reads the range in each user timezone and never processes a day that is not closed', async () => {
    const b = backfill([
      { id: 'vn', timezone: 'Asia/Ho_Chi_Minh' }, // closed through 1 October
      { id: 'ny', timezone: 'America/New_York' }, // closed through 30 September
    ]);
    const result = await b.backfill.run({ from: '2026-09-30', to: '2026-10-03' }, NOW);

    expect(b.calls).toEqual([
      ['vn', '2026-09-30'],
      ['vn', '2026-10-01'],
      ['ny', '2026-09-30'],
    ]);
    // vn: 2–3 October are open or future; ny: 1–3 October.
    expect(result).toMatchObject({ daysProcessed: 3, daysSkipped: 5 });
  });

  it('runs to each user latest closed day when no end is given', async () => {
    const b = backfill([{ id: 'ny', timezone: 'America/New_York' }]);
    await b.backfill.run({ from: '2026-09-28' }, NOW);
    expect(b.calls.map(([, day]) => day)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
  });

  it('does nothing — and fails nothing — when the whole range is still open', async () => {
    const b = backfill([{ id: 'ny', timezone: 'America/New_York' }]);
    const result = await b.backfill.run({ from: '2026-10-01', to: '2026-10-02' }, NOW);
    expect(b.calls).toEqual([]);
    expect(result).toMatchObject({ daysProcessed: 0, daysSkipped: 2, daysFailed: 0 });
  });

  it('records a failing day and carries on with the next day and the next user', async () => {
    const b = backfill(
      [
        { id: 'a', timezone: 'UTC' },
        { id: 'b', timezone: 'UTC' },
      ],
      async (userId, day) => {
        if (userId === 'a' && day === '2026-09-02') throw new Error('summary write failed');
        return run();
      },
    );
    const result = await b.backfill.run({ from: '2026-09-01', to: '2026-09-03' }, NOW);

    expect(b.calls).toHaveLength(6);
    expect(result).toMatchObject({ daysProcessed: 5, daysFailed: 1 });
    expect(result.failures).toEqual([
      { userId: 'a', localDate: '2026-09-02', error: { name: 'Error', message: 'summary write failed' } },
    ]);
  });

  it('counts days before the watermark as historical', async () => {
    const b = backfill([{ id: 'a', timezone: 'UTC' }], async (_userId, day) => run({ historical: day < '2026-09-03' }));
    const result = await b.backfill.run({ from: '2026-09-01', to: '2026-09-04' }, NOW);
    expect(result).toMatchObject({ daysProcessed: 4, daysHistorical: 2 });
  });

  it('reports a named user who is not active, and a user whose timezone cannot be read', async () => {
    const b = backfill([{ id: 'broken', timezone: 'Not/AZone' }]);
    const result = await b.backfill.run({ from: '2026-09-01', to: '2026-09-02', userIds: ['missing', 'broken'] }, NOW);
    expect(b.calls).toEqual([]);
    expect(result.failures.map((f) => [f.userId, f.localDate, f.error.name])).toEqual([
      ['missing', null, 'ValidationError'],
      ['broken', null, 'RangeError'],
    ]);
  });

  it('refuses a malformed or reversed range before processing anything', async () => {
    const b = backfill([{ id: 'a', timezone: 'UTC' }]);
    for (const request of [{ from: '2026-02-30' }, { from: '2026-09-01', to: '01/10/2026' }, { from: '2026-09-05', to: '2026-09-01' }]) {
      await expect(b.backfill.run(request, NOW)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(b.calls).toEqual([]);
  });
});

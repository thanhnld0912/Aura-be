import { describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../src/lib/errors.js';
import { PatternDetectionService, type DetectionLogger, type PatternDetectionDeps } from '../../src/modules/patterns/pattern-detection.service.js';
import type { PatternsRepository } from '../../src/modules/patterns/patterns.repository.js';
import { decideAbsence } from '../../src/patterns/lifecycle.js';
import { PatternContractError } from '../../src/patterns/persistence.js';
import { detectionRange, detectorWindowsEnding, type DetectorResult } from '../../src/patterns/registry.js';

/**
 * The orchestration's own rules, without a database: what counts as a closed day, which
 * days it reads, and that every failure is a failure — never an empty result. Persistence,
 * reconciliation, idempotency and ownership run against PostgreSQL in
 * `tests/integration/pattern-detection.test.ts`.
 */

const USER = '11111111-1111-4111-8111-111111111111';
// 18:00 UTC on 1 October is 01:00 on 2 October in Ho Chi Minh City (UTC+7).
const NOW = new Date('2026-10-01T18:00:00Z');

interface Harness {
  service: PatternDetectionService;
  ranges: Array<[string, string]>;
  transactions: number;
  logs: { info: object[]; error: object[] };
}

function harness(overrides: Partial<PatternDetectionDeps> = {}): Harness {
  const state: Harness = { service: undefined as never, ranges: [], transactions: 0, logs: { info: [], error: [] } };
  const logger: DetectionLogger = {
    info: (context) => state.logs.info.push(context),
    error: (context) => state.logs.error.push(context),
  };
  const repository = {
    recordDetection: async () => ({ outcome: 'created' as const, pattern: {} as never }),
    listActive: async () => [],
    markStale: async () => undefined,
  };
  state.service = new PatternDetectionService({
    users: { findActiveById: async (id) => (id === USER ? ({ id, timezone: 'Asia/Ho_Chi_Minh' } as never) : undefined) },
    summaries: {
      findRange: async (_userId, from, to) => {
        state.ranges.push([from, to]);
        return [];
      },
    },
    patterns: {
      withUserLock: (async (_userId: string, work: (r: PatternsRepository) => Promise<unknown>) => {
        state.transactions += 1;
        return work(repository as unknown as PatternsRepository);
      }) as PatternsRepository['withUserLock'],
    },
    logger,
    now: () => NOW,
    ...overrides,
  });
  return state;
}

describe('closed days', () => {
  it('accepts the day before the user local today, read in the user timezone', async () => {
    // In UTC it is still 1 October; locally it is 2 October, so 1 October is closed.
    const { service } = harness();
    await expect(service.runForUser(USER, '2026-10-01')).resolves.toMatchObject({ targetDate: '2026-10-01' });
  });

  it('refuses the user local today and any later day, without shifting it', async () => {
    for (const date of ['2026-10-02', '2026-10-03']) {
      const state = harness();
      const error = await state.service.runForUser(USER, date).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual([{ path: 'targetDate', issue: 'day_not_closed' }]);
      expect(state.ranges).toEqual([]);
      expect(state.transactions).toBe(0);
    }
  });

  it('refuses something that is not a calendar date', async () => {
    for (const date of ['2026-02-30', '2026-13-01', '01/10/2026', '']) {
      const error = await harness().service.runForUser(USER, date).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual([{ path: 'targetDate', issue: 'invalid_date' }]);
    }
  });

  it('refuses an unknown user before reading anything', async () => {
    const state = harness();
    await expect(state.service.runForUser('22222222-2222-4222-8222-222222222222', '2026-09-30')).rejects.toBeInstanceOf(NotFoundError);
    expect(state.ranges).toEqual([]);
  });
});

describe('what a run reads and runs', () => {
  it('reads the registry windows ending on the target date and runs the emitting families', async () => {
    const state = harness();
    const result = await state.service.runForUser(USER, '2026-09-30');

    expect(detectionRange(detectorWindowsEnding('2026-09-30'))).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(state.ranges).toEqual([['2026-09-01', '2026-09-30']]);
    expect(result).toEqual({
      userId: USER,
      targetDate: '2026-09-30',
      windowStart: '2026-09-01',
      windowEnd: '2026-09-30',
      detectorsRun: ['correlation'],
      detectionsEmitted: 0,
      patternsCreated: 0,
      patternsRedetected: 0,
      patternsReactivated: 0,
      detectionsSuppressed: 0,
      detectionsOutdated: 0,
      patternsStaled: 0,
    });
    expect(state.logs.info).toHaveLength(1);
    expect(state.logs.info[0]).toMatchObject({ userId: USER, targetDate: '2026-09-30', detectionsEmitted: 0 });
  });
});

describe('failures are failures, never an empty run', () => {
  it('throws when a detector throws, and writes nothing', async () => {
    const state = harness({
      detect: () => {
        throw new Error('detector exploded');
      },
    });
    await expect(state.service.runForUser(USER, '2026-09-30')).rejects.toThrow('detector exploded');
    expect(state.transactions).toBe(0);
    expect(state.logs.info).toEqual([]);
    expect(state.logs.error).toEqual([
      expect.objectContaining({ userId: USER, targetDate: '2026-09-30', err: { name: 'Error', message: 'detector exploded' } }),
    ]);
  });

  it('throws when the day features cannot be read', async () => {
    const state = harness({
      summaries: {
        findRange: async () => {
          throw new Error('connection reset');
        },
      },
    });
    await expect(state.service.runForUser(USER, '2026-09-30')).rejects.toThrow('connection reset');
    expect(state.transactions).toBe(0);
  });

  it('refuses a detector result that breaks the persistence contract before writing anything', async () => {
    const malformed = { kind: 'correlation', key: 'correlation:a:b', subjectMetric: 'water_ml', objectMetric: 'mood_score' } as unknown as DetectorResult;
    const state = harness({ detect: () => [malformed] });
    await expect(state.service.runForUser(USER, '2026-09-30')).rejects.toBeInstanceOf(PatternContractError);
    expect(state.transactions).toBe(0);
  });
});

describe('reconciliation rule', () => {
  const active = { status: 'active' as const, statusChangedAt: NOW, windowEnd: '2026-09-29' };

  it('stales an absent active pattern when the run ends on or after its evidence', () => {
    expect(decideAbsence(active, '2026-09-29')).toBe('stale');
    expect(decideAbsence(active, '2026-09-30')).toBe('stale');
  });

  it('leaves it alone when the run ends before its evidence — an older run cannot retire it', () => {
    expect(decideAbsence(active, '2026-09-28')).toBe('outdated');
  });

  it('never applies to a pattern that is not active', () => {
    expect(() => decideAbsence({ ...active, status: 'stale' }, '2026-09-30')).toThrow();
    expect(() => decideAbsence({ ...active, status: 'dismissed' }, '2026-09-30')).toThrow();
  });
});

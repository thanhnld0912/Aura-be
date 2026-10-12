import { describe, expect, it } from 'vitest';
import type { PatternEvidenceAnswer, PatternEvidenceSource } from '../../src/insights/pattern-evidence.js';
import type { WeeklyStoryGenerator } from '../../src/insights/weekly-story-generator.js';
import type { WeeklyEvidence, WeeklyStory } from '../../src/insights/weekly-story.js';
import { ProviderUnavailableError, ValidationError } from '../../src/lib/errors.js';
import type { AuthenticatedUser } from '../../src/modules/auth/auth.service.js';
import type { InsightsRepository } from '../../src/modules/insights/insights.repository.js';
import { InsightsService } from '../../src/modules/insights/insights.service.js';
import { PatternsEvidenceSource } from '../../src/modules/patterns/patterns-evidence-source.js';
import type { UsersService } from '../../src/modules/users/users.service.js';

/**
 * `InsightsService` over in-memory fakes: which week is meant, and when a story is not
 * even attempted. The SQL behind it is covered by `tests/integration/insights-weekly.test.ts`.
 */

const USER: AuthenticatedUser = { id: 'user-a', email: 'a@example.com', timezone: 'Asia/Ho_Chi_Minh' };

interface Calls {
  ranges: Array<[string, string]>;
  generated: WeeklyEvidence[];
  patternUsers: string[];
  warnings: Array<{ context: object; message: string }>;
  errors: Array<{ context: object; message: string }>;
}

function build(options: {
  now: string;
  trackedDays?: string[];
  aiInsightsEnabled?: boolean;
  generator?: boolean;
  /** What the pattern source answers; `null` (no engine) when absent. */
  patterns?: PatternEvidenceAnswer;
  /** The pattern source throws this instead of answering. */
  patternsThrow?: unknown;
  /** A whole source, in place of the scripted answer. */
  source?: PatternEvidenceSource;
  /** The week's own event query throws this. */
  eventsThrow?: Error;
}) {
  const calls: Calls = { ranges: [], generated: [], patternUsers: [], warnings: [], errors: [] };
  const tracked = options.trackedDays ?? [];

  const repository = {
    async eventsByDay(_userId: string, from: string, to: string) {
      calls.ranges.push([from, to]);
      if (options.eventsThrow) throw options.eventsThrow;
      return tracked
        .filter((date) => date >= from && date <= to)
        .map((localDate) => ({ localDate, total: 1, walks: 1, sleepMinutes: null }));
    },
    async distinctFoods() {
      return 0;
    },
    async planItemsByDay() {
      return [];
    },
    async workoutsByDay() {
      return [];
    },
    async habitLogsByDay() {
      return [];
    },
  } as unknown as InsightsRepository;

  const users = {
    async getProfile() {
      return {
        user: { locale: 'vi' },
        preferences: { aiInsightsEnabled: options.aiInsightsEnabled ?? true, goalFocus: 'consistency' },
      };
    },
  } as unknown as Pick<UsersService, 'getProfile'>;

  const patterns: PatternEvidenceSource = {
    async forPeriod(userId) {
      calls.patternUsers.push(userId);
      if ('patternsThrow' in options) throw options.patternsThrow;
      return options.patterns ?? null;
    },
  };

  const story = { headline: 'story' } as WeeklyStory;
  const generator: WeeklyStoryGenerator = {
    name: 'fake',
    async generate(evidence) {
      calls.generated.push(evidence);
      return story;
    },
  };

  const service = new InsightsService({
    repository,
    meals: { async nutritionByDay() { return []; } },
    checkins: { async listRange() { return []; } },
    users,
    patterns: options.source ?? patterns,
    logger: {
      warn: (context, message) => calls.warnings.push({ context, message }),
      error: (context, message) => calls.errors.push({ context, message }),
    },
    ...(options.generator === false ? {} : { storyGenerator: generator }),
    now: () => new Date(options.now),
  });

  return { service, calls, story };
}

describe('insights service — which week', () => {
  it('defaults to the week containing today in the user timezone, not in UTC', async () => {
    // 17:30 UTC on Sunday is 00:30 on Monday in Ho Chi Minh City.
    const { service } = build({ now: '2026-09-13T17:30:00Z' });
    expect((await service.weeklyReport(USER)).period.weekStart).toBe('2026-09-14');

    const utc = build({ now: '2026-09-13T17:30:00Z' });
    expect((await utc.service.weeklyReport({ ...USER, timezone: 'UTC' })).period.weekStart).toBe('2026-09-07');
  });

  it('keeps Sunday 23:59 local in the week that is ending', async () => {
    const { service } = build({ now: '2026-09-13T16:59:00Z' });
    const report = await service.weeklyReport(USER);
    expect(report.period).toMatchObject({ weekStart: '2026-09-07', daysElapsed: 7, isComplete: false });
  });

  it('rejects a weekStart that is not a Monday, or is in the future', async () => {
    const { service } = build({ now: '2026-09-16T03:00:00Z' });

    await expect(service.weeklyReport(USER, '2026-09-08')).rejects.toMatchObject({
      statusCode: 400,
      details: [{ path: 'weekStart', issue: 'not_a_week_start' }],
    });
    await expect(service.weeklyReport(USER, '2026-09-21')).rejects.toBeInstanceOf(ValidationError);
    // Rolls over to Monday 2 March if read leniently; it must be refused, not queried.
    await expect(service.weeklyReport(USER, '2026-02-30')).rejects.toMatchObject({
      statusCode: 400,
      details: [{ path: 'weekStart', issue: 'invalid_date' }],
    });
    await expect(service.weeklyReport(USER, '2026-09-14')).resolves.toBeDefined();
    await expect(service.weeklyReport(USER, '2026-08-31')).resolves.toBeDefined();
  });

  it('never reads past today, and reads the previous week for comparison', async () => {
    const { service, calls } = build({ now: '2026-09-16T03:00:00Z' }); // Wednesday

    await service.weeklyReport(USER, '2026-09-14');

    expect(calls.ranges).toEqual(
      expect.arrayContaining([
        ['2026-09-14', '2026-09-16'],
        ['2026-09-07', '2026-09-13'],
      ]),
    );
    expect(calls.patternUsers).toEqual(['user-a']);
  });
});

describe('insights service — when a story is attempted', () => {
  const WEEK_OVER = '2026-09-15T03:00:00Z';
  const FIVE_DAYS = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

  it('writes a story for a week with enough data, from the report it returns', async () => {
    const { service, calls, story } = build({ now: WEEK_OVER, trackedDays: FIVE_DAYS });

    const result = await service.weeklyStory(USER, '2026-09-07');

    expect(result.status).toBe('ready');
    expect(result.story).toBe(story);
    expect(result.report.coverage.daysTracked).toBe(5);
    expect(calls.generated).toHaveLength(1);
    expect(calls.generated[0]?.locale).toBe('vi');
  });

  it('says nothing, and spends nothing, when the week has too little data', async () => {
    // The hallucination fixture's shape: two tracked days.
    const { service, calls } = build({ now: WEEK_OVER, trackedDays: FIVE_DAYS.slice(0, 2) });

    const result = await service.weeklyStory(USER, '2026-09-07');

    expect(result).toMatchObject({ status: 'insufficient_data', story: null });
    expect(result.report.coverage.status).toBe('insufficient_data');
    expect(calls.generated).toHaveLength(0);
  });

  it('honours the AI insights opt-out before anything else', async () => {
    const { service, calls } = build({ now: WEEK_OVER, trackedDays: FIVE_DAYS, aiInsightsEnabled: false });

    expect(await service.weeklyStory(USER, '2026-09-07')).toMatchObject({ status: 'disabled', story: null });
    expect(calls.generated).toHaveLength(0);
  });

  it('answers 503 without a configured generator — and no templated story', async () => {
    const { service } = build({ now: WEEK_OVER, trackedDays: FIVE_DAYS, generator: false });

    await expect(service.weeklyStory(USER, '2026-09-07')).rejects.toBeInstanceOf(ProviderUnavailableError);
    // The facts are still there on their own.
    await expect(service.weeklyReport(USER, '2026-09-07')).resolves.toMatchObject({
      coverage: { daysTracked: 5 },
    });
  });
});

describe('insights service — why patterns are unavailable', () => {
  const NOW = '2026-09-16T03:00:00Z';
  const PATTERN_CODES = ['pattern_engine_unavailable', 'pattern_evaluation_pending', 'pattern_evaluation_stale'];
  const patternLimitations = (limitations: string[]) => limitations.filter((code) => PATTERN_CODES.includes(code));

  it.each([
    [null, 'pattern_engine_unavailable'],
    [{ unavailable: 'no_engine' }, 'pattern_engine_unavailable'],
    [{ unavailable: 'period_not_current' }, 'pattern_engine_unavailable'],
    [{ unavailable: 'evaluation_invalid' }, 'pattern_engine_unavailable'],
    [{ unavailable: 'source_failed' }, 'pattern_engine_unavailable'],
    [{ unavailable: 'not_evaluated' }, 'pattern_evaluation_pending'],
    [{ unavailable: 'evaluation_stale' }, 'pattern_evaluation_stale'],
  ] as Array<[PatternEvidenceAnswer, string]>)('reports %j as unavailable, with %s', async (answer, limitation) => {
    const { service } = build({ now: NOW, patterns: answer });
    const report = await service.weeklyReport(USER);
    // Ranked patterns and facts come from the one answer and always agree.
    expect(report.patterns).toEqual({ status: 'unavailable', items: [] });
    expect(report.patternFacts).toEqual({ status: 'unavailable', items: [] });
    expect(patternLimitations(report.dataQuality.limitations)).toEqual([limitation]);
  });

  it('reports an evaluation that found nothing as none, with no pattern limitation', async () => {
    const { service } = build({ now: NOW, patterns: [] });
    const report = await service.weeklyReport(USER);
    expect(report.patterns).toEqual({ status: 'none', items: [] });
    expect(report.patternFacts).toEqual({ status: 'none', items: [] });
    expect(patternLimitations(report.dataQuality.limitations)).toEqual([]);
  });

  it('does not read an answer it does not understand as a result', async () => {
    const { service } = build({ now: NOW, patterns: { unavailable: 'something_else' } as unknown as PatternEvidenceAnswer });
    const report = await service.weeklyReport(USER);
    expect(report.patterns.status).toBe('unavailable');
    expect(patternLimitations(report.dataQuality.limitations)).toEqual(['pattern_engine_unavailable']);
  });

  it('gives the story the same report, limitation included', async () => {
    const { service } = build({ now: NOW, patterns: { unavailable: 'evaluation_stale' }, aiInsightsEnabled: false });
    const result = await service.weeklyStory(USER);
    expect(result.report.patterns.status).toBe('unavailable');
    expect(result.report.patternFacts.status).toBe('unavailable');
    expect(result.report.dataQuality.limitations).toContain('pattern_evaluation_stale');
  });
});

describe('insights service — when the pattern source fails', () => {
  const NOW = '2026-09-16T03:00:00Z';
  const TRACKED = ['2026-09-14', '2026-09-15', '2026-09-16'];
  const PATTERN_CODES = ['pattern_engine_unavailable', 'pattern_evaluation_pending', 'pattern_evaluation_stale'];

  it('still returns the week, with patterns unavailable — never none', async () => {
    const { service, calls } = build({ now: NOW, trackedDays: TRACKED, patternsThrow: new Error('connection terminated') });
    const report = await service.weeklyReport(USER);

    expect(report.patterns).toEqual({ status: 'unavailable', items: [] });
    expect(report.patternFacts).toEqual({ status: 'unavailable', items: [] });
    expect(report.dataQuality.limitations.filter((code) => PATTERN_CODES.includes(code))).toEqual([
      'pattern_engine_unavailable',
    ]);
    // The week's own figures are untouched by the failure.
    expect(report.coverage).toMatchObject({ daysTracked: 3, status: 'sufficient' });
    expect(calls.patternUsers).toEqual([USER.id]);
  });

  it('logs the failure once, by name and message, with nothing of the user’s data', async () => {
    const failure = Object.assign(new Error('relation "patterns" does not exist'), { name: 'PostgresError' });
    const { service, calls } = build({ now: NOW, trackedDays: TRACKED, patternsThrow: failure });
    await service.weeklyReport(USER);

    expect(calls.errors).toEqual([
      {
        context: { userId: USER.id, err: { name: 'PostgresError', message: 'relation "patterns" does not exist' } },
        message: 'pattern evidence could not be read; reported as unavailable',
      },
    ]);
    expect(calls.warnings).toEqual([]);
    expect(JSON.stringify(calls.errors)).not.toMatch(/stack|a@example\.com/);
  });

  it('treats a thrown non-Error the same way', async () => {
    const { service, calls } = build({ now: NOW, patternsThrow: 'boom' });
    expect((await service.weeklyReport(USER)).patterns.status).toBe('unavailable');
    expect(calls.errors[0]!.context).toEqual({ userId: USER.id, err: { name: 'NonError', message: 'boom' } });
  });

  it('gives the story endpoint the same degraded report instead of failing it', async () => {
    const { service, calls, story } = build({ now: NOW, trackedDays: TRACKED, patternsThrow: new Error('down') });
    const result = await service.weeklyStory(USER);
    expect(result.status).toBe('ready');
    expect(result.story).toBe(story);
    expect(result.report.patterns.status).toBe('unavailable');
    expect(result.report.patternFacts.status).toBe('unavailable');
    // The model is handed no pattern, and is told patterns are unavailable.
    expect(calls.generated).toHaveLength(1);
    const items = calls.generated[0]!.items;
    expect(items.filter((item) => item.kind === 'pattern')).toEqual([]);
    expect(items.map((item) => item.statement)).toContain(
      'Pattern detection is not available yet, so no patterns can be reported.',
    );
    expect(calls.errors).toHaveLength(1);
  });

  it('does not swallow a failure of the week’s own queries', async () => {
    const { service, calls } = build({ now: NOW, eventsThrow: new Error('database is down') });
    await expect(service.weeklyReport(USER)).rejects.toThrow('database is down');
    // Not a pattern failure, so not logged as one.
    expect(calls.errors).toEqual([]);
  });

  it('logs nothing for the ordinary reasons patterns are unavailable', async () => {
    for (const answer of [null, [], { unavailable: 'not_evaluated' }, { unavailable: 'evaluation_stale' }] as PatternEvidenceAnswer[]) {
      const { service, calls } = build({ now: NOW, patterns: answer });
      await service.weeklyReport(USER);
      expect([calls.warnings, calls.errors]).toEqual([[], []]);
    }
  });

  it('warns — without failing — when the stored evaluation state cannot be trusted', async () => {
    const { service, calls } = build({ now: NOW, patterns: { unavailable: 'evaluation_invalid' } });
    const report = await service.weeklyReport(USER);
    expect(report.patterns.status).toBe('unavailable');
    expect(calls.warnings).toEqual([
      { context: { userId: USER.id, today: '2026-09-16' }, message: 'pattern evaluation state is not trustworthy' },
    ]);
    expect(calls.errors).toEqual([]);
  });
});

/**
 * The date boundary, driven by the service's own injected clock and the real source — no
 * date is read from the wall clock, here or at module load.
 */
describe('insights service — freshness across the user’s midnight', () => {
  const sourceEvaluatedThrough = (evaluatedThrough: string | null) =>
    new PatternsEvidenceSource({
      async currentState() {
        return { evaluatedThrough, active: [] };
      },
    });

  const statusAt = async (now: string, evaluatedThrough: string | null, user = USER) => {
    const { service, calls } = build({ now, source: sourceEvaluatedThrough(evaluatedThrough) });
    const report = await service.weeklyReport(user);
    return {
      patterns: report.patterns.status,
      facts: report.patternFacts.status,
      limitations: report.dataQuality.limitations.filter((code) => code.startsWith('pattern_')),
      warnings: calls.warnings.length,
    };
  };

  // Ho Chi Minh City is UTC+7: 16:59Z is 23:59 on the 16th, 17:00Z is 00:00 on the 17th.
  it('is fresh until midnight, delayed for the next day, and stale the day after', async () => {
    const watermark = '2026-09-15';
    expect(await statusAt('2026-09-16T16:59:59Z', watermark)).toEqual({ patterns: 'none', facts: 'none', limitations: [], warnings: 0 });
    expect(await statusAt('2026-09-16T17:00:00Z', watermark)).toEqual({ patterns: 'none', facts: 'none', limitations: [], warnings: 0 });
    expect(await statusAt('2026-09-17T16:59:59Z', watermark)).toEqual({ patterns: 'none', facts: 'none', limitations: [], warnings: 0 });
    expect(await statusAt('2026-09-17T17:00:00Z', watermark)).toEqual({
      patterns: 'unavailable',
      facts: 'unavailable',
      limitations: ['pattern_evaluation_stale'],
      warnings: 0,
    });
  });

  it('refuses a watermark for the day that is still open, until that day closes', async () => {
    const watermark = '2026-09-16';
    expect(await statusAt('2026-09-16T16:59:59Z', watermark)).toEqual({
      patterns: 'unavailable',
      facts: 'unavailable',
      limitations: ['pattern_engine_unavailable'],
      warnings: 1,
    });
    expect(await statusAt('2026-09-16T17:00:00Z', watermark)).toMatchObject({ patterns: 'none', warnings: 0 });
  });

  it('reads the same instant by each user’s own calendar', async () => {
    // 18:00Z on the 15th: already the 16th in Ho Chi Minh City, still the 15th in Los Angeles.
    const instant = '2026-09-15T18:00:00Z';
    const losAngeles = { ...USER, timezone: 'America/Los_Angeles' };
    expect((await statusAt(instant, '2026-09-13')).limitations).toEqual(['pattern_evaluation_stale']);
    expect((await statusAt(instant, '2026-09-13', losAngeles)).patterns).toBe('none');
  });

  it('says pending, not none, with no watermark at any hour', async () => {
    for (const now of ['2026-09-16T16:59:59Z', '2026-09-16T17:00:00Z']) {
      expect(await statusAt(now, null)).toEqual({
        patterns: 'unavailable',
        facts: 'unavailable',
        limitations: ['pattern_evaluation_pending'],
        warnings: 0,
      });
    }
  });
});

import { describe, expect, it } from 'vitest';
import type { PatternEvidenceSource } from '../../src/insights/pattern-evidence.js';
import type { WeeklyStoryGenerator } from '../../src/insights/weekly-story-generator.js';
import type { WeeklyEvidence, WeeklyStory } from '../../src/insights/weekly-story.js';
import { ProviderUnavailableError, ValidationError } from '../../src/lib/errors.js';
import type { AuthenticatedUser } from '../../src/modules/auth/auth.service.js';
import type { InsightsRepository } from '../../src/modules/insights/insights.repository.js';
import { InsightsService } from '../../src/modules/insights/insights.service.js';
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
}

function build(options: {
  now: string;
  trackedDays?: string[];
  aiInsightsEnabled?: boolean;
  generator?: boolean;
}) {
  const calls: Calls = { ranges: [], generated: [], patternUsers: [] };
  const tracked = options.trackedDays ?? [];

  const repository = {
    async eventsByDay(_userId: string, from: string, to: string) {
      calls.ranges.push([from, to]);
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
      return null;
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
    patterns,
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

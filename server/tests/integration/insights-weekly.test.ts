import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiService } from '../../src/ai/ai.service.js';
import { AiRunsRepository } from '../../src/ai/ai-runs.repository.js';
import { estimateCost } from '../../src/ai/pricing.js';
import type { AiProvider } from '../../src/ai/providers/ai-provider.js';
import { AiProviderFailure, type AiCompletion, type AiRequest } from '../../src/ai/types.js';
import { seedFoods } from '../../src/database/seeds/seed-foods.js';
import type { PatternEvidenceSource } from '../../src/insights/pattern-evidence.js';
import { ClaudeWeeklyStoryGenerator } from '../../src/insights/weekly-story-generator.js';
import { bearer, signTestToken } from '../helpers/app.js';
import {
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * `/api/insights/weekly` and `/api/insights/weekly/story`, end to end.
 *
 * Real routes, real authentication, real SQL and the real `AiService` and ledger; only
 * the vendor is scripted. Data is created through the API wherever the API can create
 * it — events, plans, check-ins, meals — so timezone and reconciliation behaviour is the
 * production code's, not a fixture's. Workout sessions and habit logs have no write
 * endpoint yet, so those two are inserted directly.
 */

const MODEL = 'claude-opus-5';
const WEEK = '2026-03-02'; // a Monday, firmly in the past: every day of it is closed
const NEXT_WEEK = '2026-03-09';

interface EvidenceView {
  facts: Array<{ ref: string; statement: string }>;
  comparisons: Array<{ ref: string; statement: string }>;
  patterns: Array<{ ref: string; statement: string; caveat: string }>;
  limitations: Array<{ ref: string; statement: string }>;
}

type Script =
  | { kind: 'ok'; output: (evidence: EvidenceView) => unknown }
  | { kind: 'fail'; failure: () => AiProviderFailure };

/** A grounded story built from whatever the evidence says: statements copied verbatim. */
function groundedStory(evidence: EvidenceView) {
  const find = (needle: string) => {
    const fact = evidence.facts.find((item) => item.statement.includes(needle));
    if (!fact) throw new Error(`evidence has no fact containing "${needle}"`);
    return fact;
  };
  const days = find('had at least one log');
  const adherence = find('resolved plan items happened');
  const limitation = evidence.limitations[0];

  return {
    headline: 'Một tuần giữ nhịp khá đều',
    summary: { text: `${days.statement}.`, evidenceRefs: [days.ref] },
    highlights: [{ text: `${adherence.statement}.`, evidenceRefs: [adherence.ref] }],
    patterns: evidence.patterns.map((pattern) => ({
      patternRef: pattern.ref,
      statement: 'Walks led to better check-in mood.',
    })),
    interpretations: [],
    suggestions: [{ text: 'Giữ buổi đi bộ vào những ngày lịch cho phép.', evidenceRefs: [adherence.ref] }],
    caveats: limitation ? [{ text: 'Một phần dữ liệu tuần này chưa được ghi nhận.', evidenceRefs: [limitation.ref] }] : [],
  };
}

describe.skipIf(!hasDatabase)('insights — weekly report and story', () => {
  let harness: DatabaseHarness;
  let tokenA: string;
  let tokenB: string;
  const userA = testUserId('a');
  const userB = testUserId('b');

  let script: Script[] = [];
  let requests: AiRequest[] = [];
  let patterns: unknown[] | null = null;
  let patternUsers: string[] = [];

  /** Stands in for `ClaudeProvider`, one layer below everything under test. */
  const provider: AiProvider = {
    name: 'anthropic',
    async complete(request): Promise<AiCompletion> {
      requests.push(request);
      const next = script.shift();
      if (!next) throw new Error('provider called more times than scripted');
      if (next.kind === 'fail') throw next.failure();

      const json = request.user.split('<weekly_evidence>')[1]?.split('</weekly_evidence>')[0] ?? '{}';
      return {
        output: next.output(JSON.parse(json) as EvidenceView),
        provider: 'anthropic',
        model: MODEL,
        usage: { inputTokens: 2_400, outputTokens: 600 },
      };
    },
  };

  const patternEvidence: PatternEvidenceSource = {
    async forPeriod(userId) {
      patternUsers.push(userId);
      return patterns;
    },
  };

  beforeAll(async () => {
    // The harness owns the connection the ledger needs, and the generator must exist
    // before the harness does — the same one-line indirection `meals-claude` uses.
    let recorder: AiRunsRepository | undefined;
    const lazyRecorder = {
      async record(input: Parameters<AiRunsRepository['record']>[0]) {
        if (!recorder) throw new Error('recorder not ready');
        return recorder.record(input);
      },
    };

    harness = await createDatabaseHarness({
      weeklyStoryGenerator: new ClaudeWeeklyStoryGenerator({
        ai: new AiService({ providers: [provider], runs: lazyRecorder, estimateCost, sleep: async () => {} }),
        model: MODEL,
        timeoutMs: 50,
      }),
      patternEvidence,
    });
    recorder = new AiRunsRepository(harness.database.db);

    tokenA = await signTestToken({ sub: userA, email: 'thanh@example.com' });
    tokenB = await signTestToken({ sub: userB, email: 'other@example.com' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    await seedFoods(harness.database.db);
    await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(tokenA) });
    await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(tokenB) });
    script = [];
    requests = [];
    patterns = null;
    patternUsers = [];
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Vietnam is UTC+7, so a local wall-clock time is that time minus seven hours. */
  const at = (localDate: string, time: string): string => {
    const [year, month, date] = localDate.split('-').map(Number) as [number, number, number];
    const [hours, minutes] = time.split(':').map(Number) as [number, number];
    return new Date(Date.UTC(year, month - 1, date, hours - 7, minutes)).toISOString();
  };
  const dayOf = (offset: number, base = WEEK): string => {
    const [year, month, date] = base.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10);
  };

  const post = (token: string, url: string, payload: unknown) =>
    harness.app.inject({ method: 'POST', url, headers: bearer(token), payload: payload as Record<string, unknown> });

  const walk = async (token: string, localDate: string, time: string) => {
    const response = await post(token, '/api/events', { type: 'walk', title: 'Walk', occurredAt: at(localDate, time) });
    expect(response.statusCode).toBe(201);
  };

  const report = (token: string, query = `?weekStart=${WEEK}`) =>
    harness.app.inject({ method: 'GET', url: `/api/insights/weekly${query}`, headers: bearer(token) });

  /**
   * `/weekly/story` is in the `ai-heavy` bucket, keyed by IP, and route-level limits
   * stay on in the test app. Each call gets its own address so the real limiter is not
   * disabled for the suite — the same approach `meals-vision` takes.
   */
  let client = 0;
  const story = (token: string, payload: Record<string, unknown> = { weekStart: WEEK }, remoteAddress?: string) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/insights/weekly/story',
      headers: bearer(token),
      remoteAddress: remoteAddress ?? `10.7.0.${(client += 1)}`,
      payload,
    });

  const runs = () =>
    harness.sql`select user_id, purpose, provider, model, status, attempt, cost_usd, error, request_meta from ai_runs order by created_at, attempt`;

  /**
   * A representative week for user A, built through the API:
   *
   * - walks Mon 07:10, Tue 08:00, Thu 18:00; a sleep log Sun; a confirmed lunch Tue
   * - check-ins Mon (good, energy 4, with a private note) and Wed (okay)
   * - plans: Mon walk 07:00 (on time), Tue workout 18:00 (the Tue walk substitutes),
   *   Wed lunch 12:00 (nothing logged)
   * - a completed workout session Fri and a habit log Sat, inserted directly
   */
  async function seedWeek(token: string, userId: string): Promise<void> {
    await walk(token, dayOf(0), '07:10');
    await walk(token, dayOf(1), '08:00');
    await walk(token, dayOf(3), '18:00');
    expect((await post(token, '/api/events', { type: 'sleep', title: 'Sleep', occurredAt: at(dayOf(6), '22:30'), durationMin: 420 })).statusCode).toBe(201);

    const search = await harness.app.inject({ method: 'GET', url: `/api/nutrition/search?q=${encodeURIComponent('cơm trắng')}` });
    const foodId = search.json().data[0].foodId as string;
    const meal = await post(token, '/api/meals', {
      mealType: 'lunch',
      items: [{ foodId, quantity: 1, unit: 'bowl' }],
      occurredAt: at(dayOf(1), '12:00'),
    });
    expect(meal.statusCode).toBe(201);

    expect((await post(token, '/api/checkins', { localDate: dayOf(0), mood: 'good', energy1to5: 4, note: 'private note about my day' })).statusCode).toBe(201);
    expect((await post(token, '/api/checkins', { localDate: dayOf(2), mood: 'okay' })).statusCode).toBe(201);

    expect((await post(token, '/api/daily-plan', { localDate: dayOf(0), items: [{ eventType: 'walk', title: 'Walk', plannedTime: '07:00' }] })).statusCode).toBe(201);
    expect((await post(token, '/api/daily-plan', { localDate: dayOf(1), items: [{ eventType: 'workout', title: 'Gym', plannedTime: '18:00' }] })).statusCode).toBe(201);
    expect((await post(token, '/api/daily-plan', { localDate: dayOf(2), items: [{ eventType: 'meal', title: 'Lunch', plannedTime: '12:00' }] })).statusCode).toBe(201);

    const [event] = await harness.sql`
      insert into daily_events (user_id, local_date, type, occurred_at, title)
      values (${userId}, ${dayOf(4)}, 'workout', ${at(dayOf(4), '06:30')}, 'Gym') returning id`;
    await harness.sql`
      insert into workout_sessions (event_id, user_id, workout_type, status)
      values (${event?.['id'] as string}, ${userId}, 'gym', 'completed')`;
    const [habit] = await harness.sql`select id from habits where user_id = ${userId} and key = 'workout_consistency'`;
    await harness.sql`
      insert into habit_logs (habit_id, user_id, local_date, status)
      values (${habit?.['id'] as string}, ${userId}, ${dayOf(5)}, 'done')`;
  }

  // ── Authentication and input ────────────────────────────────────────────────

  describe('access', () => {
    it('requires a valid token on both endpoints', async () => {
      const get = await harness.app.inject({ method: 'GET', url: '/api/insights/weekly' });
      const create = await harness.app.inject({ method: 'POST', url: '/api/insights/weekly/story', payload: {} });
      const forged = await harness.app.inject({
        method: 'GET',
        url: '/api/insights/weekly',
        headers: { authorization: 'Bearer not-a-token' },
      });

      for (const response of [get, create, forged]) {
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('UNAUTHENTICATED');
      }
      expect(requests).toHaveLength(0);
    });

    it.each([
      ['a Tuesday', '?weekStart=2026-03-03'],
      ['a malformed date', '?weekStart=2026-3-2'],
      ['an impossible date', '?weekStart=2026-02-30'],
      ['a future week', '?weekStart=2099-01-05'],
      ['a userId in the query', `?weekStart=${WEEK}&userId=${testUserId('b')}`],
    ])('rejects %s', async (_label, query) => {
      const response = await report(tokenA, query);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a userId in the story body, and never calls the model for it', async () => {
      const response = await story(tokenA, { weekStart: WEEK, userId: userB });
      expect(response.statusCode).toBe(400);
      expect(requests).toHaveLength(0);
    });
  });

  // ── The deterministic report ─────────────────────────────────────────────────

  describe('report', () => {
    it('aggregates a week from real rows, keeping missing apart from zero', async () => {
      await seedWeek(tokenA, userA);

      const response = await report(tokenA);
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.period).toEqual({
        weekStart: WEEK,
        weekEnd: '2026-03-08',
        timezone: 'Asia/Ho_Chi_Minh',
        daysInPeriod: 7,
        daysElapsed: 7,
        isComplete: true,
      });
      // Mon, Tue, Wed (check-in), Thu, Fri (workout event), Sun (sleep). Saturday only has
      // a habit log, which is not an event.
      expect(body.coverage).toEqual({ daysTracked: 6, daysElapsed: 7, rate: 0.86, status: 'sufficient' });
      expect(body.days[5]).toEqual({
        localDate: '2026-03-07',
        elapsed: true,
        tracked: false,
        eventsLogged: null,
        mealsLogged: null,
        mood: null,
      });

      expect(body.nutrition).toMatchObject({ status: 'ok', daysWithConfirmedMeals: 1, confirmedMeals: 1, distinctFoods: 1 });
      expect(body.activity).toEqual({
        status: 'ok',
        activeDays: 4,
        walks: 3,
        workoutSessions: { completed: 1, partial: 0, skipped: 0 },
      });
      expect(body.plan).toMatchObject({
        status: 'ok',
        daysWithPlan: 3,
        plannedItems: 3,
        resolvedItems: 3,
        happenedItems: 2,
        adherenceRate: 0.67,
        byAdherence: { pending: 0, on_time: 1, shifted: 0, substituted: 1, not_logged: 1 },
        activity: { planned: 2, resolved: 2, happened: 2, rate: 1 },
      });
      expect(body.habits).toMatchObject({ status: 'ok', trackedHabits: 1, logs: { done: 1, partial: 0, skipped: 0 } });
      expect(body.checkins).toMatchObject({ status: 'ok', daysWithCheckin: 2, averageEnergy: 4, energySamples: 1 });
      expect(body.sleep).toEqual({ status: 'ok', daysWithSleep: 1, averageSleepMinutes: 420 });

      expect(body.comparison.status).toBe('unavailable');
      expect(body.patterns).toEqual({ status: 'unavailable', items: [] });
      expect(body.dataQuality.limitations).toEqual(['pattern_engine_unavailable', 'previous_week_unavailable']);
      // No check-in note in a report, ever.
      expect(response.body).not.toContain('private note');
      expect(requests).toHaveLength(0);
    });

    it('excludes an unconfirmed meal draft', async () => {
      const draft = await harness.app.inject({
        method: 'POST',
        url: '/api/meals/parse',
        headers: bearer(tokenA),
        payload: { text: '1 bát phở', mealType: 'dinner' },
      });
      expect(draft.statusCode).toBe(200);
      expect(draft.json().meal.status).toBe('draft');

      const body = (await report(tokenA, '')).json();
      expect(body.nutrition.status).toBe('no_data');
      expect(body.nutrition.confirmedMeals).toBeNull();
    });

    it('files Sunday 23:59 and Monday 00:00 local into different weeks', async () => {
      // 16:59 and 17:00 UTC on the same UTC day — a UTC truncation would put both in one week.
      await walk(tokenA, '2026-03-08', '23:59');
      await walk(tokenA, NEXT_WEEK, '00:00');

      const ending = (await report(tokenA)).json();
      const starting = (await report(tokenA, `?weekStart=${NEXT_WEEK}`)).json();

      expect(ending.days[6]).toMatchObject({ localDate: '2026-03-08', tracked: true });
      expect(ending.activity.walks).toBe(1);
      expect(starting.days[0]).toMatchObject({ localDate: NEXT_WEEK, tracked: true });
      expect(starting.activity.walks).toBe(1);
      expect(starting.comparison.previousWeekStart).toBe(WEEK);
    });

    it('never mixes one user week with another', async () => {
      await seedWeek(tokenB, userB);

      const a = (await report(tokenA)).json();
      const b = (await report(tokenB)).json();

      expect(a.coverage.daysTracked).toBe(0);
      expect(a.nutrition.status).toBe('no_data');
      expect(a.habits.status).toBe('no_data');
      expect(b.coverage.daysTracked).toBe(6);
      expect(patternUsers).toEqual([userA, userB]);
    });

    it('consumes active pattern evidence and ignores what the engine has not promoted', async () => {
      const base = {
        kind: 'correlation', subjectMetric: 'walks', subjectLabel: 'Walks', objectMetric: 'mood_score',
        objectLabel: 'Check-in mood', direction: 'positive', strength: 0.55, pValue: 0.06, sampleSize: 12,
        windowDays: 30, coverage: 0.8, score: 0.6, caveat: 'An association in your own logs, not a cause.',
      };
      patterns = [
        { ...base, id: 'walk-mood', status: 'active' },
        { ...base, id: 'too-small', status: 'candidate', sampleSize: 5 },
      ];

      const body = (await report(tokenA)).json();
      expect(body.patterns.status).toBe('available');
      expect(body.patterns.items.map((item: { id: string }) => item.id)).toEqual(['walk-mood']);
      expect(body.patterns.items[0].caveat).toBe('An association in your own logs, not a cause.');
    });
  });

  // ── The story ────────────────────────────────────────────────────────────────

  describe('story', () => {
    it('writes a grounded story, meters it, and persists nothing else', async () => {
      await seedWeek(tokenA, userA);
      script = [{ kind: 'ok', output: groundedStory }];
      const summariesBefore = await harness.sql`select count(*)::int as n from daily_summaries`;

      const response = await story(tokenA);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ready');
      expect(body.report.coverage.daysTracked).toBe(6);
      expect(body.story).toMatchObject({
        promptVersion: 'weekly-story-v1',
        headline: 'Một tuần giữ nhịp khá đều',
        summary: { text: '6 of 7 days had at least one log.', evidence: ['metric:logging.days_tracked'] },
        highlights: [
          { type: 'fact', text: '2 of 3 resolved plan items happened (67%).', evidence: ['metric:plan.adherence'] },
        ],
        patterns: [],
      });

      // The model saw statements about this user's week and nothing personal.
      expect(requests).toHaveLength(1);
      const sent = requests[0]?.user ?? '';
      expect(sent).toContain('6 of 7 days had at least one log');
      expect(sent).not.toContain('private note');
      expect(sent).not.toContain(userA);
      expect(sent).not.toContain('thanh@example.com');
      expect(sent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(requests[0]?.system).not.toContain('6 of 7');

      const rows = await runs();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: userA,
        purpose: 'weekly',
        provider: 'anthropic',
        model: MODEL,
        status: 'ok',
        attempt: 1,
        error: null,
      });
      expect(Number(rows[0]?.['cost_usd'])).toBeCloseTo(0.027, 6);
      expect(Object.keys(rows[0]?.['request_meta'] as object).sort()).toEqual(['inputChars', 'promptVersion']);

      const summariesAfter = await harness.sql`select count(*)::int as n from daily_summaries`;
      expect(summariesAfter[0]?.['n']).toBe(summariesBefore[0]?.['n']);
    });

    it('rewrites a causal pattern sentence and attaches the engine caveat', async () => {
      await seedWeek(tokenA, userA);
      patterns = [{
        id: 'walk-mood', kind: 'correlation', subjectMetric: 'walks', subjectLabel: 'Walks', objectMetric: 'mood_score',
        objectLabel: 'Check-in mood', direction: 'positive', strength: 0.55, pValue: 0.06, sampleSize: 12,
        windowDays: 30, coverage: 0.8, status: 'active', score: 0.6, caveat: 'An association in your own logs, not a cause.',
      }];
      script = [{ kind: 'ok', output: groundedStory }];

      const body = (await story(tokenA)).json();

      expect(body.story.patterns).toEqual([
        {
          patternId: 'walk-mood',
          statement: 'Walks often occurred alongside better check-in mood.',
          caveat: 'An association in your own logs, not a cause.',
          evidence: ['pattern:walk-mood'],
        },
      ]);
    });

    it('answers 422 for a hallucinated figure, after exactly one retry', async () => {
      await seedWeek(tokenA, userA);
      const hallucinated = (evidence: EvidenceView) => {
        const sessions = evidence.facts.find((fact) => fact.statement.startsWith('Workout sessions logged'));
        return { ...groundedStory(evidence), highlights: [{ text: 'You completed 5 workouts.', evidenceRefs: [sessions?.ref ?? 'F1'] }] };
      };
      script = [{ kind: 'ok', output: hallucinated }, { kind: 'ok', output: hallucinated }];

      const response = await story(tokenA);

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('AI_SCHEMA_ERROR');
      expect(response.body).not.toContain('5 workouts');
      const rows = await runs();
      expect(rows.map((row) => row['status'])).toEqual(['schema_error', 'schema_error']);
      expect((rows[0]?.['request_meta'] as { schemaErrorPaths: string[] }).schemaErrorPaths).toEqual(['highlights.0.text']);
    });

    it('answers 503 for a provider outage, with no provider detail', async () => {
      await seedWeek(tokenA, userA);
      const outage = () => new AiProviderFailure('provider_error', 'upstream secret detail', { status: 503 });
      script = [{ kind: 'fail', failure: outage }, { kind: 'fail', failure: outage }];

      const response = await story(tokenA);

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(response.body).not.toContain('secret');
      const rows = await runs();
      expect(rows.map((row) => row['status'])).toEqual(['provider_error', 'provider_error']);
      expect(rows.every((row) => !String(row['error']).includes('secret'))).toBe(true);
    });

    it('spends nothing on a week with too little data', async () => {
      await walk(tokenA, dayOf(0), '07:00');
      await walk(tokenA, dayOf(1), '07:00');

      const response = await story(tokenA);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'insufficient_data', story: null });
      expect(requests).toHaveLength(0);
      expect(await runs()).toHaveLength(0);
    });

    it('respects the AI insights opt-out', async () => {
      await seedWeek(tokenA, userA);
      const patch = await harness.app.inject({
        method: 'PATCH',
        url: '/api/users/me/preferences',
        headers: bearer(tokenA),
        payload: { aiInsightsEnabled: false },
      });
      expect(patch.statusCode).toBe(200);

      const response = await story(tokenA);

      expect(response.json()).toMatchObject({ status: 'disabled', story: null });
      expect(requests).toHaveLength(0);
      expect(await runs()).toHaveLength(0);
    });

    it('is bounded by the ai-heavy bucket', async () => {
      const address = '10.8.0.1';
      const codes: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        codes.push((await story(tokenA, { weekStart: WEEK }, address)).statusCode);
      }
      expect(codes).toEqual([200, 200, 200, 429]);
    });
  });

  it('is documented in the OpenAPI document under Insights', async () => {
    const document = (await harness.app.inject({ method: 'GET', url: '/docs/json' })).json();

    expect(document.paths['/api/insights/weekly']?.get?.tags).toEqual(['Insights']);
    expect(document.paths['/api/insights/weekly/story']?.post?.tags).toEqual(['Insights']);
    expect(Object.keys(document.paths['/api/insights/weekly/story'].post.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '429', '500']),
    );
  });
});

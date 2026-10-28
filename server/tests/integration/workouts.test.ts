import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, signTestToken } from '../helpers/app.js';
import {
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * `POST /api/workouts`, end to end: the event and the session are written together, the
 * workout appears on the timeline, it can satisfy a planned workout, and it is the
 * caller's alone.
 */
describe.skipIf(!hasDatabase)('workouts', () => {
  let harness: DatabaseHarness;
  let tokenA: string;
  let tokenB: string;
  const userA = testUserId('a');
  const userB = testUserId('b');
  const DATE = '2026-03-04';

  beforeAll(async () => {
    harness = await createDatabaseHarness();
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

  const logWorkout = (token: string, payload: Record<string, unknown>) =>
    harness.app.inject({ method: 'POST', url: '/api/workouts', headers: bearer(token), payload });

  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/workouts',
      payload: { workoutType: 'gym' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('writes the event and the completed session together', async () => {
    const response = await logWorkout(tokenA, {
      workoutType: 'gym',
      title: 'Strength training',
      occurredAt: '2026-03-04T11:00:00Z',
      durationMin: 45,
      perceivedEffort: 4,
      note: 'Tôi tập gym 45 phút',
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      workoutType: 'gym',
      status: 'completed',
      title: 'Strength training',
      durationMin: 45,
      perceivedEffort: 4,
      note: 'Tôi tập gym 45 phút',
    });

    const sessions = await harness.sql`
      select s.user_id, s.status, s.duration_min, e.type, e.title, e.duration_min as event_duration
      from workout_sessions s join daily_events e on e.id = s.event_id
      where s.id = ${body.id}`;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      user_id: userA,
      status: 'completed',
      duration_min: 45,
      type: 'workout',
      title: 'Strength training',
      event_duration: 45,
    });
  });

  it('satisfies a planned workout', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/daily-plan',
      headers: bearer(tokenA),
      payload: { localDate: DATE, items: [{ eventType: 'workout', title: 'Gym', plannedTime: '18:00' }] },
    });
    // 18:10 in Vietnam (UTC+7), where test users live by default.
    await logWorkout(tokenA, { workoutType: 'gym', occurredAt: '2026-03-04T11:10:00Z', durationMin: 45 });

    const comparison = await harness.app.inject({
      method: 'GET',
      url: `/api/daily-plan/comparison?date=${DATE}`,
      headers: bearer(tokenA),
    });
    expect(comparison.json().items[0].adherence).toBe('on_time');
  });

  it('is invisible to another user', async () => {
    await logWorkout(tokenA, { workoutType: 'run', occurredAt: '2026-03-04T01:00:00Z', note: 'A private run' });

    const listB = await harness.app.inject({
      method: 'GET',
      url: '/api/events?from=2026-03-01&to=2026-03-31',
      headers: bearer(tokenB),
    });
    expect(listB.json().data).toEqual([]);
    expect(listB.body).not.toContain('A private run');
  });

  it('rejects an invalid body without writing anything', async () => {
    const response = await logWorkout(tokenA, { workoutType: 'gym', durationMin: 0 });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');

    const rows = await harness.sql`select count(*)::int as count from workout_sessions`;
    expect(rows[0]?.['count']).toBe(0);
  });
});

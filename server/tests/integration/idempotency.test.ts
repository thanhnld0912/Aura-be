import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/database/client.js';
import { DailyEventsRepository } from '../../src/modules/daily-events/daily-events.repository.js';
import { IdempotencyService } from '../../src/modules/idempotency/idempotency.service.js';
import { bearer, signTestToken } from '../helpers/app.js';
import {
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * `Idempotency-Key` on the three logging writes, against a real PostgreSQL — the guarantees
 * are the database's (a primary key, a transaction), so nothing short of one proves them.
 */
describe.skipIf(!hasDatabase)('Idempotency-Key', () => {
  let harness: DatabaseHarness;
  let tokenA: string;
  let tokenB: string;
  const userA = testUserId('a');
  const userB = testUserId('b');

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

  const post = (url: string, payload: Record<string, unknown>, options: { key?: string; token?: string } = {}) =>
    harness.app.inject({
      method: 'POST',
      url,
      headers: { ...bearer(options.token ?? tokenA), ...(options.key ? { 'idempotency-key': options.key } : {}) },
      payload,
    });

  const count = async (table: 'daily_events' | 'workout_sessions' | 'checkins' | 'idempotency_keys') =>
    (await harness.sql.unsafe(`select count(*)::int as c from ${table}`))[0]?.['c'];

  const WALK = { type: 'walk', title: 'Walk', durationMin: 30, occurredAt: '2026-03-04T01:00:00Z' };

  describe('POST /api/events', () => {
    it('writes once and replays the same answer for a retry with the same key', async () => {
      const first = await post('/api/events', WALK, { key: 'walk-1' });
      const retry = await post('/api/events', WALK, { key: 'walk-1' });

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toEqual(first.json());
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(await count('daily_events')).toBe(1);
    });

    it('treats a new key as a new action', async () => {
      await post('/api/events', WALK, { key: 'walk-1' });
      const second = await post('/api/events', WALK, { key: 'walk-2' });
      expect(second.statusCode).toBe(201);
      expect(await count('daily_events')).toBe(2);
    });

    it('keeps the old behaviour without a key: every request is a write', async () => {
      await post('/api/events', WALK);
      await post('/api/events', WALK);
      expect(await count('daily_events')).toBe(2);
      expect(await count('idempotency_keys')).toBe(0);
    });

    it('refuses the same key with a different payload, and changes nothing', async () => {
      const first = await post('/api/events', WALK, { key: 'walk-1' });
      const reused = await post('/api/events', { ...WALK, durationMin: 45 }, { key: 'walk-1' });

      expect(reused.statusCode).toBe(409);
      expect(reused.json().error.code).toBe('CONFLICT');
      expect(await count('daily_events')).toBe(1);
      const [row] = await harness.sql`select duration_min from daily_events where id = ${first.json().id}`;
      expect(row?.['duration_min']).toBe(30);
    });

    it('writes once when the same request arrives several times at once', async () => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => post('/api/events', WALK, { key: 'burst' })),
      );

      expect(responses.map((r) => r.statusCode)).toEqual(Array(6).fill(201));
      expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
      expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(5);
      expect(await count('daily_events')).toBe(1);
      expect(await count('idempotency_keys')).toBe(1);
    });

    it('scopes a key to its user', async () => {
      const a = await post('/api/events', WALK, { key: 'shared' });
      const b = await post('/api/events', WALK, { key: 'shared', token: tokenB });

      expect(b.statusCode).toBe(201);
      expect(b.headers['idempotent-replayed']).toBeUndefined();
      expect(b.json().id).not.toBe(a.json().id);
      const owners = await harness.sql`select user_id from daily_events order by user_id`;
      expect(owners.map((r) => r['user_id']).sort()).toEqual([userA, userB].sort());
    });

    it('scopes a key to its operation', async () => {
      await post('/api/events', WALK, { key: 'shared' });
      const workout = await post('/api/workouts', { workoutType: 'gym', durationMin: 45 }, { key: 'shared' });
      expect(workout.statusCode).toBe(201);
      expect(await count('workout_sessions')).toBe(1);
    });

    it('frees a key after 24 hours', async () => {
      await post('/api/events', WALK, { key: 'old' });
      await harness.sql`update idempotency_keys set created_at = now() - interval '25 hours'`;

      const later = await post('/api/events', { ...WALK, durationMin: 20 }, { key: 'old' });
      expect(later.statusCode).toBe(201);
      expect(later.headers['idempotent-replayed']).toBeUndefined();
      expect(await count('daily_events')).toBe(2);
      expect(await count('idempotency_keys')).toBe(1);
    });

    it('rejects a malformed key before writing anything', async () => {
      const response = await post('/api/events', WALK, { key: 'not a valid key' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details).toEqual([{ path: 'idempotency-key', issue: 'invalid_string' }]);
      expect(await count('daily_events')).toBe(0);
    });

    it('still validates the body first, and stores no key for a rejected one', async () => {
      const response = await post('/api/events', { ...WALK, durationMin: 0 }, { key: 'bad-body' });
      expect(response.statusCode).toBe(400);
      expect(await count('idempotency_keys')).toBe(0);
    });
  });

  describe('POST /api/workouts', () => {
    it('writes one session and one event however often it is retried', async () => {
      const body = { workoutType: 'gym', durationMin: 45, occurredAt: '2026-03-04T11:00:00Z' };
      const responses = await Promise.all([1, 2, 3].map(() => post('/api/workouts', body, { key: 'gym-1' })));
      const retry = await post('/api/workouts', body, { key: 'gym-1' });

      expect(new Set([...responses, retry].map((r) => r.json().id)).size).toBe(1);
      expect(await count('workout_sessions')).toBe(1);
      expect(await count('daily_events')).toBe(1);
    });
  });

  describe('POST /api/checkins', () => {
    it('replays the first answer — its 201 too — rather than reporting an update', async () => {
      const body = { localDate: '2026-03-04', mood: 'good' };
      const first = await post('/api/checkins', body, { key: 'checkin-1' });
      const retry = await post('/api/checkins', body, { key: 'checkin-1' });

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toEqual(first.json());
      expect(await count('checkins')).toBe(1);
    });

    it('still upserts the day for a new key', async () => {
      await post('/api/checkins', { localDate: '2026-03-04', mood: 'good' }, { key: 'checkin-1' });
      const changed = await post('/api/checkins', { localDate: '2026-03-04', mood: 'great' }, { key: 'checkin-2' });

      expect(changed.statusCode).toBe(200);
      expect(changed.json().mood).toBe('great');
      expect(await count('checkins')).toBe(1);
    });
  });

  /**
   * Failures either side of the commit, through the service itself so the failure can be
   * placed exactly. The write is a real event insert; the refresh is a counter.
   */
  describe('failure and retry', () => {
    const scope = (key: string) => ({ userId: userA, operation: 'POST /api/events', key });
    const write = (fail = false) => async (db: Db) => {
      const row = await new DailyEventsRepository(db).create({
        userId: userA,
        localDate: '2026-03-04',
        type: 'walk',
        occurredAt: new Date('2026-03-04T01:00:00Z'),
        title: 'Walk',
        inputMethod: 'manual',
        source: 'user',
      });
      if (fail) throw new Error('the write failed after its insert');
      return { statusCode: 201, body: { id: row.id }, localDate: row.localDate };
    };

    it('finishes a refresh that failed after the commit, once, and never writes again', async () => {
      const service = new IdempotencyService(harness.database.db);
      const refreshed: string[] = [];
      let refreshFails = true;
      const refresh = async (localDate: string) => {
        refreshed.push(localDate);
        if (refreshFails) throw new Error('summary refresh failed');
      };

      await expect(service.run(scope('k'), 'hash', write(), refresh)).rejects.toThrow('summary refresh failed');
      // The write is committed and its answer stored, but the refresh is not done.
      expect(await count('daily_events')).toBe(1);
      const [pending] = await harness.sql`select completed_at, status_code from idempotency_keys`;
      expect(pending).toMatchObject({ completed_at: null, status_code: 201 });

      refreshFails = false;
      const retry = await service.run(scope('k'), 'hash', write(), refresh);
      expect(retry.replayed).toBe(true);
      expect(refreshed).toEqual(['2026-03-04', '2026-03-04']);
      expect(await count('daily_events')).toBe(1);

      // Completed now: a further retry replays and runs nothing at all.
      const again = await service.run(scope('k'), 'hash', write(), refresh);
      expect(again).toEqual(retry);
      expect(refreshed).toHaveLength(2);
    });

    it('rolls the key back with a write that fails before commit, so a retry writes', async () => {
      const service = new IdempotencyService(harness.database.db);
      const refresh = async () => {};

      await expect(service.run(scope('k'), 'hash', write(true), refresh)).rejects.toThrow('after its insert');
      expect(await count('daily_events')).toBe(0);
      expect(await count('idempotency_keys')).toBe(0);

      const retry = await service.run(scope('k'), 'hash', write(), refresh);
      expect(retry.replayed).toBe(false);
      expect(await count('daily_events')).toBe(1);
    });

    it('runs the refresh once for a fresh write and not at all for its replay', async () => {
      const service = new IdempotencyService(harness.database.db);
      let refreshes = 0;
      const refresh = async () => {
        refreshes += 1;
      };
      await service.run(scope('k'), 'hash', write(), refresh);
      await service.run(scope('k'), 'hash', write(), refresh);
      expect(refreshes).toBe(1);
    });
  });
});

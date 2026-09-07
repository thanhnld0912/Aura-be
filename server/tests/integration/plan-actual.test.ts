import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, signTestToken } from '../helpers/app.js';
import {
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * The Planned-vs-Actual spine, end to end through the API.
 *
 * The unit tests cover the reconciliation algebra; these cover the thing that actually
 * has to hold in production — that logging an event never rewrites the plan, that the
 * comparison reflects reality without a scheduled job, and that the daily summary is
 * recomputed on write.
 */
describe.skipIf(!hasDatabase)('plan vs actual', () => {
  let harness: DatabaseHarness;
  let token: string;
  const userId = testUserId('a');

  // Fixed and firmly in the past, so the local day is always closed and an unmatched
  // item resolves to not_logged rather than pending. Using "today" here would make the
  // suite depend on when it runs.
  const DATE = '2026-03-04';

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    token = await signTestToken({ sub: userId, email: 'thanh@example.com' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
  });

  /** Vietnam is UTC+7, so a local wall-clock time is that time minus seven hours. */
  const utcFor = (localTime: string): string => {
    const [h, m] = localTime.split(':').map(Number) as [number, number];
    return new Date(Date.UTC(2026, 2, 4, h - 7, m)).toISOString();
  };

  const createPlan = (items: unknown[]) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/daily-plan',
      headers: bearer(token),
      payload: { localDate: DATE, items },
    });

  const logEvent = (payload: Record<string, unknown>) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/events',
      headers: bearer(token),
      payload,
    });

  const comparison = () =>
    harness.app.inject({
      method: 'GET',
      url: `/api/daily-plan/comparison?date=${DATE}`,
      headers: bearer(token),
    });

  it('creates a plan, and a closed day with no events resolves to not_logged', async () => {
    const created = await createPlan([
      { eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' },
      { eventType: 'sleep', title: 'Wind down', plannedTime: '22:30', plannedDurationMin: 480 },
    ]);

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.localDate).toBe(DATE);
    expect(body.items).toHaveLength(2);
    // The day is in the past, so with no events these resolve immediately.
    expect(body.items[0].adherence).toBe('not_logged');
    expect(body.items[0].linkedEventId).toBeNull();
  });

  it('rejects a second plan for the same date with 409', async () => {
    await createPlan([{ eventType: 'walk', title: 'Walk', plannedTime: '07:00' }]);
    const second = await createPlan([{ eventType: 'walk', title: 'Walk again', plannedTime: '08:00' }]);

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFLICT');
  });

  it('marks an on-time event on_time and leaves the plan untouched', async () => {
    await createPlan([{ eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' }]);
    await logEvent({ type: 'walk', title: 'Walked to work', occurredAt: utcFor('07:20') });

    const result = await comparison();
    expect(result.statusCode).toBe(200);

    const [item] = result.json().items;
    expect(item.adherence).toBe('on_time');
    expect(item.shiftMinutes).toBe(20);
    expect(item.actual.title).toBe('Walked to work');
    // The intention is unchanged — this is the rule the whole product rests on.
    expect(item.planned.time).toBe('07:00');
    expect(item.planned.title).toBe('Morning walk');
  });

  it('records a late event as shifted without moving the planned time', async () => {
    await createPlan([{ eventType: 'walk', title: 'Evening walk', plannedTime: '18:00' }]);
    await logEvent({ type: 'walk', title: 'Late walk', occurredAt: utcFor('19:10') });

    const [item] = (await comparison()).json().items;
    expect(item.adherence).toBe('shifted');
    expect(item.shiftMinutes).toBe(70);
    expect(item.planned.time).toBe('18:00');

    // And in the database, not just the response.
    const rows = await harness.sql`
      select planned_time, adherence, shift_minutes from plan_items`;
    expect(rows[0]?.['planned_time']).toBe('18:00:00');
    expect(rows[0]?.['adherence']).toBe('shifted');
    expect(rows[0]?.['shift_minutes']).toBe(70);
  });

  it('lists an unrelated event as unplanned rather than forcing a match', async () => {
    await createPlan([{ eventType: 'sleep', title: 'Wind down', plannedTime: '22:30' }]);
    await logEvent({ type: 'water', title: 'Water', occurredAt: utcFor('14:00') });

    const body = (await comparison()).json();
    expect(body.items[0].adherence).toBe('not_logged');
    expect(body.unplanned).toHaveLength(1);
    expect(body.unplanned[0]).toMatchObject({ title: 'Water', time: '14:00', type: 'water' });
  });

  it('reverts a plan item when the linked event is deleted', async () => {
    await createPlan([{ eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' }]);
    const event = await logEvent({
      type: 'walk',
      title: 'Walked',
      occurredAt: utcFor('07:05'),
    });
    const eventId = event.json().id as string;

    expect((await comparison()).json().items[0].adherence).toBe('on_time');

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/events/${eventId}`,
      headers: bearer(token),
    });
    expect(deleted.statusCode).toBe(204);

    const after = (await comparison()).json();
    expect(after.items[0].adherence).toBe('not_logged');
    // The comparison reports the linked event as `actual`, not as a bare id.
    expect(after.items[0].actual).toBeNull();
  });

  it('re-links when an event moves in time', async () => {
    await createPlan([
      { eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' },
      { eventType: 'walk', title: 'Evening walk', plannedTime: '19:00' },
    ]);
    const event = await logEvent({ type: 'walk', title: 'A walk', occurredAt: utcFor('07:05') });
    const eventId = event.json().id as string;

    expect((await comparison()).json().items[0].adherence).toBe('on_time');

    await harness.app.inject({
      method: 'PATCH',
      url: `/api/events/${eventId}`,
      headers: bearer(token),
      payload: { occurredAt: utcFor('19:05') },
    });

    const after = (await comparison()).json();
    expect(after.items[0].adherence).toBe('not_logged');
    expect(after.items[0].actual).toBeNull();
    expect(after.items[1].adherence).toBe('on_time');
    expect(after.items[1].actual.id).toBe(eventId);
  });

  it('reconciles a plan created after the events were logged', async () => {
    await logEvent({ type: 'walk', title: 'Walked', occurredAt: utcFor('07:10') });
    const created = await createPlan([
      { eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' },
    ]);

    expect(created.json().items[0].adherence).toBe('on_time');
  });

  it('does not let a plan edit rewrite reconciliation state', async () => {
    await createPlan([{ eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' }]);
    await logEvent({ type: 'walk', title: 'Walked', occurredAt: utcFor('07:10') });

    const planId = (
      await harness.app.inject({
        method: 'GET',
        url: `/api/daily-plan?date=${DATE}`,
        headers: bearer(token),
      })
    ).json().id as string;

    // A client cannot set adherence, linkedEventId or shiftMinutes — the schema has no
    // such fields, and unknown keys are rejected.
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/daily-plan/${planId}`,
      headers: bearer(token),
      payload: {
        items: [
          {
            eventType: 'walk',
            title: 'Morning walk',
            plannedTime: '07:00',
            adherence: 'on_time',
            linkedEventId: '11111111-1111-4111-8111-111111111111',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  describe('timezone boundaries (§16, §17)', () => {
    it('files a post-midnight local event under the correct local day', async () => {
      // 17:30Z on the 6th is 00:30 on the 7th in Ho Chi Minh City.
      const event = await logEvent({
        type: 'custom',
        title: 'Late night snack run',
        occurredAt: '2026-03-03T17:30:00Z',
      });

      expect(event.statusCode).toBe(201);
      expect(event.json().localDate).toBe('2026-03-04');
    });

    it('files a late-evening local event under the same local day', async () => {
      // 16:59Z on the 7th is 23:59 on the 7th locally.
      const event = await logEvent({
        type: 'custom',
        title: 'Almost midnight',
        occurredAt: '2026-03-04T16:59:00Z',
      });
      expect(event.json().localDate).toBe('2026-03-04');
    });

    it('matches a 00:30 local event against a 00:30 plan item', async () => {
      await createPlan([{ eventType: 'sleep', title: 'Bed', plannedTime: '00:30' }]);
      await logEvent({
        type: 'sleep',
        title: 'Went to bed',
        occurredAt: '2026-03-03T17:30:00Z',
        durationMin: 420,
      });

      const [item] = (await comparison()).json().items;
      expect(item.adherence).toBe('on_time');
      expect(item.shiftMinutes).toBe(0);
      expect(item.actual.time).toBe('00:30');
    });

    it('follows the user timezone when it changes', async () => {
      await harness.app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: bearer(token),
        payload: { timezone: 'UTC' },
      });

      // The same instant is now the 6th, because the user is in UTC.
      const event = await logEvent({
        type: 'custom',
        title: 'Same instant, different day',
        occurredAt: '2026-03-03T17:30:00Z',
      });
      expect(event.json().localDate).toBe('2026-03-03');
    });
  });

  describe('daily summaries', () => {
    it('recomputes on every write without an AI call', async () => {
      await createPlan([
        { eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' },
        { eventType: 'water', title: 'Drink water', plannedTime: '10:00' },
      ]);
      await logEvent({ type: 'walk', title: 'Walked', occurredAt: utcFor('07:10') });
      await logEvent({
        type: 'water',
        title: 'Water',
        occurredAt: utcFor('10:05'),
        metrics: { ml: 500 },
      });
      await logEvent({
        type: 'sleep',
        title: 'Slept',
        occurredAt: utcFor('23:00'),
        durationMin: 430,
      });

      const rows = await harness.sql`
        select * from daily_summaries where user_id = ${userId} and local_date = ${DATE}`;

      expect(rows).toHaveLength(1);
      const summary = rows[0];
      expect(summary?.['events_logged']).toBe(3);
      expect(Number(summary?.['water_ml'])).toBe(500);
      expect(summary?.['sleep_minutes']).toBe(430);
      expect(summary?.['bedtime']).toBe('23:00:00');
      expect(Number(summary?.['plan_adherence_pct'])).toBe(100);
    });

    it('leaves the nutrition fields untouched until Phase 3 has a source', async () => {
      await logEvent({ type: 'walk', title: 'Walked', occurredAt: utcFor('07:10') });

      const rows = await harness.sql`
        select total_kcal, vegetable_servings, protein_servings, distinct_foods
        from daily_summaries where user_id = ${userId}`;

      // Zero and null are accurate: nothing has recorded any of these yet. A fabricated
      // calorie total is exactly what NUTRITION_ARCHITECTURE.md §1 forbids.
      expect(rows[0]?.['total_kcal']).toBeNull();
      expect(rows[0]?.['vegetable_servings']).toBe(0);
      expect(rows[0]?.['distinct_foods']).toBe(0);
    });

    it('records the day mood from the check-in', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/checkins',
        headers: bearer(token),
        payload: { localDate: DATE, mood: 'good', dayTag: 'busy', energy1to5: 4 },
      });
      expect(response.statusCode).toBe(201);

      const rows = await harness.sql`
        select mood, events_logged from daily_summaries where local_date = ${DATE}`;
      expect(rows[0]?.['mood']).toBe('good');
      // The check-in is itself an event on the timeline.
      expect(rows[0]?.['events_logged']).toBe(1);
    });

    it('upserts the check-in per day rather than logging a second one', async () => {
      const payload = { localDate: DATE, mood: 'okay' as const };
      const first = await harness.app.inject({
        method: 'POST',
        url: '/api/checkins',
        headers: bearer(token),
        payload,
      });
      const second = await harness.app.inject({
        method: 'POST',
        url: '/api/checkins',
        headers: bearer(token),
        payload: { ...payload, mood: 'great' as const },
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json().id).toBe(first.json().id);

      const rows = await harness.sql`select count(*)::int as c from checkins`;
      expect(rows[0]?.['c']).toBe(1);

      const events = await harness.sql`
        select count(*)::int as c from daily_events where type = 'checkin'`;
      expect(events[0]?.['c']).toBe(1);
    });

    it('drops the counts again when an event is removed', async () => {
      const event = await logEvent({
        type: 'walk',
        title: 'Walked',
        occurredAt: utcFor('07:10'),
      });

      await harness.app.inject({
        method: 'DELETE',
        url: `/api/events/${event.json().id}`,
        headers: bearer(token),
      });

      const rows = await harness.sql`
        select events_logged from daily_summaries where local_date = ${DATE}`;
      expect(rows[0]?.['events_logged']).toBe(0);
    });
  });

  describe('the timeline', () => {
    it('returns the day events oldest first with their local date', async () => {
      await logEvent({ type: 'walk', title: 'Second', occurredAt: utcFor('12:00') });
      await logEvent({ type: 'walk', title: 'First', occurredAt: utcFor('08:00') });

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/events/today?date=${DATE}`,
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.map((e: { title: string }) => e.title)).toEqual([
        'First',
        'Second',
      ]);
    });

    it('paginates history newest first with an opaque cursor', async () => {
      for (let hour = 8; hour < 14; hour += 1) {
        await logEvent({
          type: 'walk',
          title: `Walk ${hour}`,
          occurredAt: utcFor(`${String(hour).padStart(2, '0')}:00`),
        });
      }

      const first = await harness.app.inject({
        method: 'GET',
        url: '/api/events?limit=4',
        headers: bearer(token),
      });
      expect(first.json().data).toHaveLength(4);
      expect(first.json().nextCursor).toEqual(expect.any(String));

      const second = await harness.app.inject({
        method: 'GET',
        url: `/api/events?limit=4&cursor=${encodeURIComponent(first.json().nextCursor)}`,
        headers: bearer(token),
      });

      expect(second.json().data).toHaveLength(2);
      expect(second.json().nextCursor).toBeNull();

      const ids = [...first.json().data, ...second.json().data].map((e: { id: string }) => e.id);
      expect(new Set(ids).size).toBe(6);
    });

    it('rejects a malformed cursor rather than ignoring it', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/events?cursor=not-a-cursor',
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(400);
    });

    it('refuses event types that own a detail table', async () => {
      // `meal` and `workout` have richer endpoints; accepting them here would create
      // events with no detail row for Phase 3 to clean up.
      for (const type of ['meal', 'workout', 'checkin']) {
        const response = await logEvent({ type, title: 'x', occurredAt: utcFor('12:00') });
        expect(response.statusCode, type).toBe(400);
      }
    });
  });
});

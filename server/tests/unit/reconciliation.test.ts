import { describe, expect, it } from 'vitest';
import {
  ON_TIME_WINDOW_MINUTES,
  reconcile,
  type ReconcilableEvent,
  type ReconcilablePlanItem,
  type ReconciliationInput,
} from '../../src/modules/daily-plans/reconciliation.js';

const VN = 'Asia/Ho_Chi_Minh';

/** 2026-09-07, given as local wall-clock time in Ho Chi Minh City (UTC+7). */
const at = (localTime: string): Date => {
  const [h, m] = localTime.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 8, 7, h - 7, m));
};

const item = (
  id: string,
  eventType: ReconcilablePlanItem['eventType'],
  plannedTime: string,
  sortOrder = 0,
): ReconcilablePlanItem => ({ id, eventType, plannedTime, sortOrder });

const event = (
  id: string,
  type: ReconcilableEvent['type'],
  localTime: string,
): ReconcilableEvent => ({ id, type, occurredAt: at(localTime) });

const run = (partial: Partial<ReconciliationInput>) =>
  reconcile({ items: [], events: [], timeZone: VN, dayClosed: false, ...partial });

describe('reconciliation — the adherence truth table (DATABASE_DESIGN.md §3.3)', () => {
  it('exact match is on_time with zero shift', () => {
    const result = run({
      items: [item('i1', 'workout', '18:00')],
      events: [event('e1', 'workout', '18:00')],
    });
    expect(result.items[0]).toEqual({
      planItemId: 'i1',
      adherence: 'on_time',
      linkedEventId: 'e1',
      shiftMinutes: 0,
    });
  });

  it('treats the plus/minus 45 minute window as inclusive on both sides', () => {
    expect(ON_TIME_WINDOW_MINUTES).toBe(45);

    const late = run({
      items: [item('i1', 'workout', '18:00')],
      events: [event('e1', 'workout', '18:45')],
    });
    expect(late.items[0]?.adherence).toBe('on_time');
    expect(late.items[0]?.shiftMinutes).toBe(45);

    const early = run({
      items: [item('i1', 'workout', '18:00')],
      events: [event('e1', 'workout', '17:15')],
    });
    expect(early.items[0]?.adherence).toBe('on_time');
    expect(early.items[0]?.shiftMinutes).toBe(-45);
  });

  it('one minute outside the window is shifted, and records the shift', () => {
    // The documented example: planned 18:00, actual 19:10 gives shifted — and the plan
    // still says 18:00 afterwards.
    const result = run({
      items: [item('i1', 'workout', '18:00')],
      events: [event('e1', 'workout', '19:10')],
    });
    expect(result.items[0]).toEqual({
      planItemId: 'i1',
      adherence: 'shifted',
      linkedEventId: 'e1',
      shiftMinutes: 70,
    });

    expect(
      run({
        items: [item('i1', 'workout', '18:00')],
        events: [event('e1', 'workout', '18:46')],
      }).items[0]?.adherence,
    ).toBe('shifted');
  });

  it('a different but compatible activity is substituted — planned gym, logged walk', () => {
    const result = run({
      items: [item('i1', 'workout', '17:30')],
      events: [event('e1', 'walk', '18:30')],
    });
    expect(result.items[0]).toMatchObject({
      adherence: 'substituted',
      linkedEventId: 'e1',
      shiftMinutes: 60,
    });
  });

  it('does not substitute across unrelated activity types', () => {
    const result = run({
      items: [item('i1', 'meal', '12:00')],
      events: [event('e1', 'workout', '12:05')],
    });
    expect(result.items[0]?.adherence).toBe('pending');
    expect(result.items[0]?.linkedEventId).toBeNull();
    expect(result.unplannedEventIds).toEqual(['e1']);
  });

  it('prefers a same-type match over a substitute even when the substitute is closer', () => {
    const result = run({
      items: [item('i1', 'workout', '18:00')],
      events: [event('walkEvent', 'walk', '18:05'), event('gymEvent', 'workout', '19:30')],
    });
    expect(result.items[0]).toMatchObject({ adherence: 'shifted', linkedEventId: 'gymEvent' });
    expect(result.unplannedEventIds).toEqual(['walkEvent']);
  });
});

describe('reconciliation — pending vs not_logged', () => {
  it('leaves an unmatched item pending while the day is still open', () => {
    const result = run({ items: [item('i1', 'workout', '18:00')], dayClosed: false });
    expect(result.items[0]?.adherence).toBe('pending');
  });

  it('records not_logged only once the day has closed', () => {
    const result = run({ items: [item('i1', 'workout', '18:00')], dayClosed: true });
    expect(result.items[0]).toEqual({
      planItemId: 'i1',
      adherence: 'not_logged',
      linkedEventId: null,
      shiftMinutes: null,
    });
  });

  it('never produces a judgemental value', () => {
    const result = run({ items: [item('i1', 'workout', '18:00')], dayClosed: true });
    for (const reconciled of result.items) {
      expect(['pending', 'on_time', 'shifted', 'substituted', 'not_logged']).toContain(
        reconciled.adherence,
      );
    }
  });
});

describe('reconciliation — competing candidates', () => {
  it('assigns globally best-first, not in plan order', () => {
    // Greedy in plan order would give the 08:50 event to the 08:00 item as shifted
    // (50 minutes away) and leave the 09:00 item unmatched. Best-first gives it to the
    // 09:00 item as on_time, which is the honest reading of what happened.
    const result = run({
      items: [item('early', 'meal', '08:00'), item('later', 'meal', '09:00')],
      events: [event('e1', 'meal', '08:50')],
      dayClosed: true,
    });

    expect(result.items.find((i) => i.planItemId === 'later')).toMatchObject({
      adherence: 'on_time',
      linkedEventId: 'e1',
    });
    expect(result.items.find((i) => i.planItemId === 'early')).toMatchObject({
      adherence: 'not_logged',
      linkedEventId: null,
    });
  });

  it('matches each plan item to a distinct event', () => {
    const result = run({
      items: [item('i1', 'meal', '08:00'), item('i2', 'meal', '12:00')],
      events: [event('e1', 'meal', '08:10'), event('e2', 'meal', '12:05')],
    });
    expect(result.items.map((i) => i.linkedEventId)).toEqual(['e1', 'e2']);
    expect(result.unplannedEventIds).toEqual([]);
  });

  it('never links one event to two plan items', () => {
    const result = run({
      items: [item('i1', 'meal', '12:00'), item('i2', 'meal', '12:10')],
      events: [event('e1', 'meal', '12:05')],
      dayClosed: true,
    });
    const linked = result.items.filter((i) => i.linkedEventId !== null);
    expect(linked).toHaveLength(1);
    expect(result.items.filter((i) => i.adherence === 'not_logged')).toHaveLength(1);
  });

  it('reports duplicate events beyond the plan as unplanned rather than dropping them', () => {
    const result = run({
      items: [item('i1', 'meal', '12:00')],
      events: [
        event('e1', 'meal', '12:05'),
        event('e2', 'meal', '12:06'),
        event('e3', 'meal', '12:07'),
      ],
    });
    expect(result.items[0]?.linkedEventId).toBe('e1');
    expect(result.unplannedEventIds).toEqual(['e2', 'e3']);
  });

  it('is deterministic for equidistant candidates', () => {
    const input = {
      items: [item('i1', 'meal', '12:00')],
      events: [event('bbb', 'meal', '11:50'), event('aaa', 'meal', '12:10')],
    };
    const first = run(input);
    const second = run(input);
    expect(first).toEqual(second);
    expect(first.items[0]?.linkedEventId).toBe('aaa');
  });

  it('is unaffected by the order events arrive in', () => {
    const a = run({
      items: [item('i1', 'meal', '08:00'), item('i2', 'meal', '19:00')],
      events: [event('morning', 'meal', '08:05'), event('evening', 'meal', '19:05')],
    });
    const b = run({
      items: [item('i2', 'meal', '19:00'), item('i1', 'meal', '08:00')],
      events: [event('evening', 'meal', '19:05'), event('morning', 'meal', '08:05')],
    });
    const byItem = (r: typeof a) =>
      Object.fromEntries(r.items.map((i) => [i.planItemId, i.linkedEventId]));
    expect(byItem(a)).toEqual(byItem(b));
  });
});

describe('reconciliation — timezone', () => {
  it('compares against the user local wall clock, not UTC', () => {
    // 01:00Z on the 8th is 08:00 on the 8th in Ho Chi Minh City. Against a plan item at
    // 08:00 that is an exact match; read as UTC it would be seven hours early.
    const result = reconcile({
      items: [item('i1', 'meal', '08:00')],
      events: [{ id: 'e1', type: 'meal', occurredAt: new Date('2026-09-08T01:00:00Z') }],
      timeZone: VN,
      dayClosed: false,
    });
    expect(result.items[0]).toMatchObject({ adherence: 'on_time', shiftMinutes: 0 });

    const asUtc = reconcile({
      items: [item('i1', 'meal', '08:00')],
      events: [{ id: 'e1', type: 'meal', occurredAt: new Date('2026-09-08T01:00:00Z') }],
      timeZone: 'UTC',
      dayClosed: false,
    });
    expect(asUtc.items[0]?.shiftMinutes).toBe(-420);
  });

  it('matches a just-after-midnight event against an early plan item', () => {
    const result = reconcile({
      items: [item('i1', 'sleep', '00:30')],
      events: [{ id: 'e1', type: 'sleep', occurredAt: new Date('2026-09-06T17:30:00Z') }],
      timeZone: VN,
      dayClosed: false,
    });
    expect(result.items[0]).toMatchObject({ adherence: 'on_time', shiftMinutes: 0 });
  });
});

describe('reconciliation — adherence percentage', () => {
  it('is null while every item is still pending', () => {
    expect(run({ items: [item('i1', 'meal', '08:00')] }).adherencePct).toBeNull();
  });

  it('counts on_time, shifted and substituted alike', () => {
    const result = run({
      items: [
        item('i1', 'meal', '08:00'),
        item('i2', 'meal', '12:00'),
        item('i3', 'workout', '18:00'),
        item('i4', 'meal', '19:00'),
      ],
      events: [
        event('e1', 'meal', '08:00'), // on_time
        event('e2', 'meal', '14:00'), // shifted
        event('e3', 'walk', '18:30'), // substituted
      ],
      dayClosed: true,
    });
    expect(result.adherencePct).toBe(75);
  });

  it('excludes pending items rather than counting them against the user', () => {
    const result = run({
      items: [item('i1', 'meal', '08:00'), item('i2', 'meal', '19:00')],
      events: [event('e1', 'meal', '08:05')],
      dayClosed: false,
    });
    // One resolved item, and it happened. The unlogged evening meal is not yet a fact.
    expect(result.adherencePct).toBe(100);
  });

  it('is 0 when a closed day logged nothing', () => {
    expect(run({ items: [item('i1', 'meal', '08:00')], dayClosed: true }).adherencePct).toBe(0);
  });

  it('is null for an empty plan', () => {
    expect(run({ items: [], dayClosed: true }).adherencePct).toBeNull();
  });
});

describe('reconciliation — the plan is never mutated', () => {
  it('returns instructions without touching its inputs', () => {
    const items = [item('i1', 'workout', '18:00')];
    const events = [event('e1', 'workout', '19:10')];
    const snapshot = structuredClone({ items, events });

    reconcile({ items, events, timeZone: VN, dayClosed: true });

    expect({ items, events }).toEqual(snapshot);
    expect(items[0]?.plannedTime).toBe('18:00');
  });
});

import { minutesSinceLocalMidnight, parseTimeToMinutes } from '../../lib/local-date.js';
import type { eventTypeEnum } from '../../database/schema/enums.js';

export type EventType = (typeof eventTypeEnum.enumValues)[number];
export type Adherence = 'pending' | 'on_time' | 'shifted' | 'substituted' | 'not_logged';

/**
 * Planned vs Actual reconciliation (DATABASE_DESIGN.md §3.3).
 *
 * This is pure, deterministic domain logic. The same plan and the same events always
 * produce the same result — no clock reads, no database, and emphatically no LLM: a
 * statistic the Pattern Engine will later build on has to be reproducible.
 *
 * **It never mutates the plan.** The function returns what to write to
 * `linked_event_id` / `adherence` / `shift_minutes`; `planned_time` and `title` are
 * read-only inputs. A plan is an intention, and rewriting the intention to match what
 * happened would erase the only signal AURA has.
 */

/** DATABASE_DESIGN.md §3.3 — "matching event within ±45 min of planned_time". */
export const ON_TIME_WINDOW_MINUTES = 45;

/**
 * Which event types can stand in for which.
 *
 * §3.3 gives one worked example — "planned gym → logged walk" — without defining the
 * general rule, so this is the smallest rule that covers it: substitution happens only
 * within a named affinity group, and at MVP the only group is movement. Everything else
 * has no substitute, which means a planned meal is never "satisfied" by a workout.
 * Extending it later is one entry in this map.
 */
const SUBSTITUTION_GROUPS: readonly (readonly EventType[])[] = [['workout', 'walk']];

function substitutesFor(type: EventType): readonly EventType[] {
  const group = SUBSTITUTION_GROUPS.find((candidates) => candidates.includes(type));
  return group ? group.filter((candidate) => candidate !== type) : [];
}

export interface ReconcilablePlanItem {
  id: string;
  eventType: EventType;
  /** `HH:mm` or `HH:mm:ss` — Postgres `time` returns seconds. */
  plannedTime: string;
  sortOrder: number;
}

export interface ReconcilableEvent {
  id: string;
  type: EventType;
  occurredAt: Date;
}

export interface ReconciledItem {
  planItemId: string;
  adherence: Adherence;
  linkedEventId: string | null;
  /** Signed: negative is early, positive is late. Recorded whenever an event is linked. */
  shiftMinutes: number | null;
}

export interface ReconciliationInput {
  items: readonly ReconcilablePlanItem[];
  /**
   * Events already narrowed to this plan's user and local date, excluding soft-deleted
   * rows. Scoping is the caller's job — this function has no idea who owns anything.
   */
  events: readonly ReconcilableEvent[];
  /** The user's timezone; event instants are compared in their local wall clock. */
  timeZone: string;
  /**
   * True once the local day is over. Until then an unmatched item is `pending`, not
   * `not_logged` — the day is not finished, and the data model does not editorialise
   * about a plan the user may still act on.
   */
  dayClosed: boolean;
}

export interface ReconciliationResult {
  items: ReconciledItem[];
  /** Events that matched no plan item. A neutral list — not "extras", not "violations". */
  unplannedEventIds: string[];
  /**
   * Share of *resolved* plan items that actually happened, in any form —
   * `on_time`, `shifted` and `substituted` all count, because each of them is the user
   * having done the thing. `pending` items are excluded rather than counted against the
   * user, so a plan does not read as 0% at breakfast time. `null` when nothing has
   * resolved yet.
   *
   * The percentage is a fact the UI may choose not to show (API_DESIGN.md §6).
   */
  adherencePct: number | null;
}

/** Match quality, best first. The tier decides the adherence value. */
const enum Tier {
  SameTypeInWindow = 0,
  SameTypeOutOfWindow = 1,
  Substitute = 2,
}

const TIER_ADHERENCE: Record<Tier, Adherence> = {
  [Tier.SameTypeInWindow]: 'on_time',
  [Tier.SameTypeOutOfWindow]: 'shifted',
  [Tier.Substitute]: 'substituted',
};

interface Candidate {
  tier: Tier;
  itemId: string;
  eventId: string;
  shiftMinutes: number;
  distance: number;
}

export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const { items, events, timeZone, dayClosed } = input;

  const eventMinutes = new Map<string, number>();
  for (const event of events) {
    eventMinutes.set(event.id, minutesSinceLocalMidnight(event.occurredAt, timeZone));
  }

  // Every plausible pairing, scored. Built exhaustively so assignment can be made
  // best-first globally rather than in plan order — otherwise an early item greedily
  // takes an event that a later item matches far better.
  const candidates: Candidate[] = [];

  for (const item of items) {
    const plannedMinutes = parseTimeToMinutes(item.plannedTime);
    const substitutes = substitutesFor(item.eventType);

    for (const event of events) {
      const isSameType = event.type === item.eventType;
      const isSubstitute = !isSameType && substitutes.includes(event.type);
      if (!isSameType && !isSubstitute) continue;

      const shiftMinutes = (eventMinutes.get(event.id) ?? 0) - plannedMinutes;
      const distance = Math.abs(shiftMinutes);

      const tier = isSameType
        ? distance <= ON_TIME_WINDOW_MINUTES
          ? Tier.SameTypeInWindow
          : Tier.SameTypeOutOfWindow
        : Tier.Substitute;

      candidates.push({ tier, itemId: item.id, eventId: event.id, shiftMinutes, distance });
    }
  }

  // Deterministic ordering: better tier, then closer in time, then stable id ordering so
  // two equidistant events never produce a coin-flip result between runs.
  candidates.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.distance - b.distance ||
      (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0) ||
      (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );

  const matchedItems = new Map<string, Candidate>();
  const usedEvents = new Set<string>();

  for (const candidate of candidates) {
    if (matchedItems.has(candidate.itemId) || usedEvents.has(candidate.eventId)) continue;
    matchedItems.set(candidate.itemId, candidate);
    usedEvents.add(candidate.eventId);
  }

  const resultItems: ReconciledItem[] = items.map((item) => {
    const match = matchedItems.get(item.id);
    if (!match) {
      return {
        planItemId: item.id,
        adherence: dayClosed ? 'not_logged' : 'pending',
        linkedEventId: null,
        shiftMinutes: null,
      };
    }
    return {
      planItemId: item.id,
      adherence: TIER_ADHERENCE[match.tier],
      linkedEventId: match.eventId,
      shiftMinutes: match.shiftMinutes,
    };
  });

  const resolved = resultItems.filter((item) => item.adherence !== 'pending');
  const happened = resolved.filter((item) => item.linkedEventId !== null);

  return {
    items: resultItems,
    unplannedEventIds: events
      .filter((event) => !usedEvents.has(event.id))
      .map((event) => event.id),
    adherencePct:
      resolved.length > 0 ? Math.round((happened.length / resolved.length) * 100) : null,
  };
}

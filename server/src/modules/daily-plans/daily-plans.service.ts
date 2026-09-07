import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { isBefore, toLocalTime, todayIn } from '../../lib/local-date.js';
import type {
  DailyPlansRepository,
  PlanItemInput,
  PlanWithItems,
} from './daily-plans.repository.js';
import { reconcile, type ReconcilableEvent, type ReconciliationResult } from './reconciliation.js';

/**
 * A narrow port onto the events module rather than a direct dependency
 * (ARCHITECTURE.md §5): reconciliation needs to read what happened, but
 * `daily_events` belongs to another module and its repository is private to it.
 */
export interface DayEvent extends ReconcilableEvent {
  title: string;
  durationMin: number | null;
}

export interface DayEventsReader {
  listForDay(userId: string, localDate: string): Promise<DayEvent[]>;
}

export interface PlanComparison {
  localDate: string;
  adherencePct: number | null;
  items: Array<{
    planItemId: string;
    planned: { title: string; time: string; type: string; durationMin: number | null };
    actual: { id: string; title: string; time: string; type: string; durationMin: number | null } | null;
    adherence: string;
    shiftMinutes: number | null;
  }>;
  unplanned: Array<{ id: string; title: string; time: string; type: string }>;
}

export class DailyPlansService {
  constructor(
    private readonly repository: DailyPlansRepository,
    private readonly events: DayEventsReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getByDate(userId: string, localDate: string): Promise<PlanWithItems> {
    const found = await this.repository.findByDate(userId, localDate);
    // 404 rather than an empty plan: the client renders "create a plan" from this
    // (API_DESIGN.md §6), and an empty 200 would be indistinguishable from a plan with
    // no items, which is a different thing.
    if (!found) throw new NotFoundError('No plan for that date');
    return found;
  }

  async getById(userId: string, planId: string): Promise<PlanWithItems> {
    const found = await this.repository.findById(userId, planId);
    if (!found) throw new NotFoundError();
    return found;
  }

  async create(
    userId: string,
    localDate: string,
    items: PlanItemInput[],
    timeZone: string,
  ): Promise<PlanWithItems> {
    const existing = await this.repository.findByDate(userId, localDate);
    if (existing) {
      throw new ConflictError(`A plan already exists for ${localDate}`);
    }

    try {
      await this.repository.create(userId, localDate, items);
    } catch (error) {
      // Two concurrent creates for the same day; the unique index decides.
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A plan already exists for ${localDate}`);
      }
      throw error;
    }

    // A plan created for a day that already has events should reflect them at once,
    // rather than looking untouched until the next log.
    await this.reconcileDay(userId, localDate, timeZone);
    return this.getByDate(userId, localDate);
  }

  async replaceItems(
    userId: string,
    planId: string,
    items: PlanItemInput[],
    timeZone: string,
  ): Promise<PlanWithItems> {
    const existing = await this.repository.findById(userId, planId);
    if (!existing) throw new NotFoundError();

    await this.repository.replaceItems(planId, items);
    await this.repository.touch(planId);
    await this.reconcileDay(userId, existing.plan.localDate, timeZone);
    return this.getByDate(userId, existing.plan.localDate);
  }

  async setStatus(
    userId: string,
    planId: string,
    status: 'draft' | 'active' | 'archived',
  ): Promise<PlanWithItems> {
    const updated = await this.repository.updateStatus(userId, planId, status);
    if (!updated) throw new NotFoundError();
    return this.getByDate(userId, updated.localDate);
  }

  async delete(userId: string, planId: string): Promise<void> {
    const deleted = await this.repository.delete(userId, planId);
    if (!deleted) throw new NotFoundError();
  }

  /**
   * Recomputes adherence for one day and writes the result.
   *
   * Called after every event write and whenever the plan itself changes, so the
   * comparison is always current without a scheduled job. It is idempotent: running it
   * twice on unchanged data writes the same values, which is what makes it safe to
   * call from several paths.
   */
  async reconcileDay(
    userId: string,
    localDate: string,
    timeZone: string,
  ): Promise<ReconciliationResult | undefined> {
    const found = await this.repository.findByDate(userId, localDate);
    if (!found) return undefined;

    const events = await this.events.listForDay(userId, localDate);

    const result = reconcile({
      items: found.items.map((item) => ({
        id: item.id,
        eventType: item.eventType,
        plannedTime: item.plannedTime,
        sortOrder: item.sortOrder,
      })),
      events,
      timeZone,
      // The day is closed once the user's local calendar has moved past it. Only then
      // does an unmatched item become `not_logged` rather than `pending`.
      dayClosed: isBefore(localDate, todayIn(timeZone, this.now())),
    });

    await this.repository.applyReconciliation(found.plan.id, result.items);
    return result;
  }

  /** Adherence counts for one day, for the summary recompute. */
  adherenceFor(userId: string, localDate: string) {
    return this.repository.adherenceFor(userId, localDate);
  }

  /**
   * `GET /api/daily-plan/comparison` — facts only, no judgement (API_DESIGN.md §6).
   *
   * Reconciles first so the answer reflects the current state rather than whatever was
   * last written.
   */
  async comparison(
    userId: string,
    localDate: string,
    timeZone: string,
  ): Promise<PlanComparison> {
    await this.reconcileDay(userId, localDate, timeZone);

    const found = await this.repository.findByDate(userId, localDate);
    if (!found) throw new NotFoundError('No plan for that date');

    const events = await this.events.listForDay(userId, localDate);
    const eventsById = new Map(events.map((event) => [event.id, event]));

    const linkedIds = new Set(
      found.items.map((item) => item.linkedEventId).filter((id): id is string => id !== null),
    );

    const adherence = await this.repository.adherenceFor(userId, localDate);

    return {
      localDate,
      adherencePct: adherence
        ? Math.round((adherence.happened / adherence.resolved) * 100)
        : null,
      items: found.items.map((item) => {
        const actual = item.linkedEventId ? eventsById.get(item.linkedEventId) : undefined;
        return {
          planItemId: item.id,
          planned: {
            title: item.title,
            time: item.plannedTime.slice(0, 5),
            type: item.eventType,
            durationMin: item.plannedDurationMin,
          },
          actual: actual
            ? {
                id: actual.id,
                title: actual.title,
                time: toLocalTime(actual.occurredAt, timeZone),
                type: actual.type,
                durationMin: actual.durationMin ?? null,
              }
            : null,
          adherence: item.adherence,
          shiftMinutes: item.shiftMinutes,
        };
      }),
      // A neutral list. Not "extras", not "violations" — things that also happened.
      unplanned: events
        .filter((event) => !linkedIds.has(event.id))
        .map((event) => ({
          id: event.id,
          title: event.title,
          time: toLocalTime(event.occurredAt, timeZone),
          type: event.type,
        })),
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

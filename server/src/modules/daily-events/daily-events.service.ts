import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { toLocalDate } from '../../lib/local-date.js';
import type { DayEvent } from '../daily-plans/daily-plans.service.js';
import type { EventType } from '../daily-plans/reconciliation.js';
import type {
  DailyEventRow,
  DailyEventsRepository,
  ListEventsFilter,
} from './daily-events.repository.js';

/**
 * Event types `POST /api/events` accepts.
 *
 * It is the generic logger "for types without a richer endpoint" (API_DESIGN.md §7).
 * `meal` and `workout` are excluded because they own detail tables that this endpoint
 * cannot populate — accepting them here would create meal events with no `meals` row,
 * which Phase 3 would then have to clean up. `checkin` is excluded because it has its
 * own upsert-per-day endpoint.
 */
export const GENERIC_EVENT_TYPES = ['walk', 'water', 'sleep', 'habit', 'custom'] as const;
export type GenericEventType = (typeof GENERIC_EVENT_TYPES)[number];

/**
 * Recomputes everything derived from a day. Injected as a thunk because the day
 * refresher depends on this service in turn — reading events is how it reconciles —
 * and a lazy accessor breaks that cycle without resorting to a setter.
 */
export interface DayRefresher {
  refresh(userId: string, localDate: string, timeZone: string): Promise<void>;
}

export interface CreateEventCommand {
  type: GenericEventType;
  title: string;
  occurredAt?: Date | undefined;
  durationMin?: number | undefined;
  note?: string | undefined;
  metrics?: Record<string, number> | undefined;
}

export interface UpdateEventCommand {
  title?: string | undefined;
  note?: string | null | undefined;
  durationMin?: number | null | undefined;
  occurredAt?: Date | undefined;
  metrics?: Record<string, number> | null | undefined;
}

export class DailyEventsService {
  constructor(
    private readonly repository: DailyEventsRepository,
    private readonly getDayRefresher: () => DayRefresher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Implements the `DayEventsReader` port the plans module reconciles against
   * (ARCHITECTURE.md §5) — cross-module reads go through a service, never into another
   * module's repository.
   */
  async listForDay(userId: string, localDate: string): Promise<DayEvent[]> {
    const rows = await this.repository.listForDay(userId, localDate);
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      occurredAt: row.occurredAt,
      title: row.title,
      durationMin: row.durationMin,
    }));
  }

  /** The full rows for one day, for the timeline. */
  listForDayRaw(userId: string, localDate: string): Promise<DailyEventRow[]> {
    return this.repository.listForDay(userId, localDate);
  }

  /** Aggregates for the daily summary, exposed here so no other module reaches into this one's repository. */
  dayStats(userId: string, localDate: string) {
    return this.repository.dayStats(userId, localDate);
  }

  checkinForDay(userId: string, localDate: string) {
    return this.repository.findCheckinForDay(userId, localDate);
  }

  async create(
    userId: string,
    timeZone: string,
    command: CreateEventCommand,
  ): Promise<DailyEventRow> {
    const occurredAt = command.occurredAt ?? this.now();

    const created = await this.repository.create({
      userId,
      // Derived here rather than taken from the client: the local day is a fact about
      // the instant and the user's timezone, not something a caller may assert.
      localDate: toLocalDate(occurredAt, timeZone),
      type: command.type,
      occurredAt,
      title: command.title,
      durationMin: command.durationMin ?? null,
      note: command.note ?? null,
      metrics: command.metrics ?? null,
      inputMethod: 'manual',
      source: 'user',
    });

    await this.getDayRefresher().refresh(userId, created.localDate, timeZone);
    return created;
  }

  /**
   * Creates the timeline event for a confirmed meal.
   *
   * `POST /api/events` deliberately refuses `meal`, because it cannot populate the detail
   * row and would leave orphan events behind. The meals module owns that pairing, and
   * this is the one door it comes through — still inside the events module, so
   * `daily_events` keeps a single writer.
   */
  async createMealEvent(
    userId: string,
    timeZone: string,
    input: { title: string; occurredAt: Date; note?: string | undefined },
  ): Promise<DailyEventRow> {
    return this.repository.create({
      userId,
      localDate: toLocalDate(input.occurredAt, timeZone),
      type: 'meal',
      occurredAt: input.occurredAt,
      title: input.title,
      note: input.note ?? null,
      inputMethod: 'manual',
      source: 'user',
    });
  }

  async get(userId: string, id: string): Promise<DailyEventRow> {
    const found = await this.repository.findById(userId, id);
    if (!found) throw new NotFoundError();
    return found;
  }

  async list(
    userId: string,
    filter: ListEventsFilter,
  ): Promise<{ data: DailyEventRow[]; nextCursor: string | null }> {
    // One extra row tells us whether another page exists without a second count query.
    const rows = await this.repository.list(userId, { ...filter, limit: filter.limit + 1 });
    const hasMore = rows.length > filter.limit;
    const data = hasMore ? rows.slice(0, filter.limit) : rows;
    const last = data.at(-1);

    return {
      data,
      nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.id) : null,
    };
  }

  async update(
    userId: string,
    id: string,
    timeZone: string,
    command: UpdateEventCommand,
  ): Promise<DailyEventRow> {
    const existing = await this.get(userId, id);

    // Moving an event in time can move it to a different local day; both days then need
    // recomputing, because the old day lost an event and the new one gained it.
    const localDate =
      command.occurredAt !== undefined ? toLocalDate(command.occurredAt, timeZone) : undefined;

    const updated = await this.repository.update(userId, id, {
      ...command,
      ...(localDate !== undefined ? { localDate } : {}),
    });
    if (!updated) throw new NotFoundError();

    const refresher = this.getDayRefresher();
    await refresher.refresh(userId, updated.localDate, timeZone);
    if (existing.localDate !== updated.localDate) {
      await refresher.refresh(userId, existing.localDate, timeZone);
    }

    return updated;
  }

  async softDelete(userId: string, id: string, timeZone: string): Promise<void> {
    const deleted = await this.repository.softDelete(userId, id);
    if (!deleted) throw new NotFoundError();
    // The plan item this event satisfied reverts to pending or not_logged, and the
    // day's counts drop. Neither happens on its own.
    await this.getDayRefresher().refresh(userId, deleted.localDate, timeZone);
  }
}

export function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { occurredAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  const timestamp = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const occurredAt = new Date(timestamp);

  if (separator === -1 || Number.isNaN(occurredAt.getTime()) || id.length === 0) {
    throw new ValidationError('cursor: not a valid pagination cursor', [
      { path: 'cursor', issue: 'invalid_cursor' },
    ]);
  }

  return { occurredAt, id };
}

export function isGenericEventType(type: EventType): type is GenericEventType {
  return (GENERIC_EVENT_TYPES as readonly EventType[]).includes(type);
}

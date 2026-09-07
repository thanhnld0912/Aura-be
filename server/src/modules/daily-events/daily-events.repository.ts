import { and, asc, desc, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import { checkins, dailyEvents } from '../../database/schema/index.js';
import type { EventType } from '../daily-plans/reconciliation.js';

/**
 * The only layer that touches `daily_events` (ARCHITECTURE.md §5).
 *
 * Every method takes `userId` first and every query filters on it. Note especially
 * `findById`: it takes both the id **and** the owner, so a request for someone else's
 * event returns `undefined` — which the service turns into a 404, deliberately
 * indistinguishable from a row that does not exist (SECURITY.md §2). There is no
 * lookup-by-id-alone method for a caller to reach for by mistake.
 */

export type DailyEventRow = typeof dailyEvents.$inferSelect;
export type CheckinRow = typeof checkins.$inferSelect;

export interface CreateEventInput {
  userId: string;
  localDate: string;
  type: EventType;
  occurredAt: Date;
  title: string;
  durationMin?: number | null;
  note?: string | null;
  inputMethod?: DailyEventRow['inputMethod'];
  source?: DailyEventRow['source'];
  metrics?: Record<string, number> | null;
}

export interface DayStats {
  eventsLogged: number;
  mealsLogged: number;
  waterMl: number;
  sleepMinutes: number | null;
  firstMealAt: Date | null;
  lastMealAt: Date | null;
  bedtimeAt: Date | null;
}

export interface ListEventsFilter {
  from?: string;
  to?: string;
  type?: EventType;
  limit: number;
  cursor?: { occurredAt: Date; id: string };
}

const toDate = (epochSeconds: number | null | undefined): Date | null =>
  epochSeconds === null || epochSeconds === undefined ? null : new Date(epochSeconds * 1000);

export class DailyEventsRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateEventInput): Promise<DailyEventRow> {
    const [created] = await this.db
      .insert(dailyEvents)
      .values({
        userId: input.userId,
        localDate: input.localDate,
        type: input.type,
        occurredAt: input.occurredAt,
        title: input.title,
        durationMin: input.durationMin ?? null,
        note: input.note ?? null,
        inputMethod: input.inputMethod ?? 'manual',
        source: input.source ?? 'user',
        metrics: input.metrics ?? null,
      })
      .returning();

    if (!created) throw new Error('event insert returned no row');
    return created;
  }

  /** Ownership is part of the lookup, not a check performed afterwards. */
  async findById(userId: string, id: string): Promise<DailyEventRow | undefined> {
    return this.db.query.dailyEvents.findFirst({
      where: and(
        eq(dailyEvents.id, id),
        eq(dailyEvents.userId, userId),
        isNull(dailyEvents.deletedAt),
      ),
    });
  }

  /** Everything that actually happened on one local day, oldest first. */
  async listForDay(userId: string, localDate: string): Promise<DailyEventRow[]> {
    return this.db
      .select()
      .from(dailyEvents)
      .where(
        and(
          eq(dailyEvents.userId, userId),
          eq(dailyEvents.localDate, localDate),
          isNull(dailyEvents.deletedAt),
        ),
      )
      .orderBy(asc(dailyEvents.occurredAt), asc(dailyEvents.id));
  }

  /**
   * Cursor pagination, newest first. The cursor is `(occurredAt, id)` rather than an
   * offset because history is append-heavy and an offset drifts as rows arrive
   * underneath it (API_DESIGN.md §1). The id breaks ties so two events at the same
   * instant cannot be skipped or repeated.
   */
  async list(userId: string, filter: ListEventsFilter): Promise<DailyEventRow[]> {
    const conditions = [eq(dailyEvents.userId, userId), isNull(dailyEvents.deletedAt)];

    if (filter.from) conditions.push(gte(dailyEvents.localDate, filter.from));
    if (filter.to) conditions.push(lte(dailyEvents.localDate, filter.to));
    if (filter.type) conditions.push(eq(dailyEvents.type, filter.type));

    if (filter.cursor) {
      const { occurredAt, id } = filter.cursor;
      const keyset = or(
        lt(dailyEvents.occurredAt, occurredAt),
        and(eq(dailyEvents.occurredAt, occurredAt), lt(dailyEvents.id, id)),
      );
      if (keyset) conditions.push(keyset);
    }

    return this.db
      .select()
      .from(dailyEvents)
      .where(and(...conditions))
      .orderBy(desc(dailyEvents.occurredAt), desc(dailyEvents.id))
      .limit(filter.limit);
  }

  async update(
    userId: string,
    id: string,
    patch: {
      title?: string | undefined;
      note?: string | null | undefined;
      durationMin?: number | null | undefined;
      occurredAt?: Date | undefined;
      localDate?: string | undefined;
      metrics?: Record<string, number> | null | undefined;
    },
  ): Promise<DailyEventRow | undefined> {
    const [updated] = await this.db
      .update(dailyEvents)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(eq(dailyEvents.id, id), eq(dailyEvents.userId, userId), isNull(dailyEvents.deletedAt)),
      )
      .returning();
    return updated;
  }

  /**
   * Soft delete (DATABASE_DESIGN.md §1.5). An accidental swipe must not destroy history
   * the Pattern Engine depends on.
   */
  async softDelete(userId: string, id: string): Promise<DailyEventRow | undefined> {
    const [deleted] = await this.db
      .update(dailyEvents)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(dailyEvents.id, id), eq(dailyEvents.userId, userId), isNull(dailyEvents.deletedAt)),
      )
      .returning();
    return deleted;
  }

  /**
   * Counts and boundary instants for one day, aggregated in SQL rather than by loading
   * every row. Times come back as instants, not `time` values: converting them to a
   * wall clock needs the user's timezone, which belongs to the service layer.
   */
  async dayStats(userId: string, localDate: string): Promise<DayStats> {
    const rows = await this.db
      .select({
        eventsLogged: sql<number>`count(*)::int`,
        mealsLogged: sql<number>`count(*) filter (where ${dailyEvents.type} = 'meal')::int`,
        waterMl: sql<number>`
          coalesce(sum((${dailyEvents.metrics} ->> 'ml')::numeric)
            filter (where ${dailyEvents.type} = 'water'), 0)::float8`,
        sleepMinutes: sql<number | null>`
          sum(${dailyEvents.durationMin}) filter (where ${dailyEvents.type} = 'sleep')::int`,
        // Epoch seconds rather than the timestamptz itself: a raw `sql` fragment has no
        // column type for the driver to parse, so a timestamp comes back as a Postgres
        // display string that `new Date()` cannot reliably read. A number is unambiguous.
        firstMealEpoch: sql<number | null>`
          extract(epoch from min(${dailyEvents.occurredAt})
            filter (where ${dailyEvents.type} = 'meal'))::float8`,
        lastMealEpoch: sql<number | null>`
          extract(epoch from max(${dailyEvents.occurredAt})
            filter (where ${dailyEvents.type} = 'meal'))::float8`,
        bedtimeEpoch: sql<number | null>`
          extract(epoch from min(${dailyEvents.occurredAt})
            filter (where ${dailyEvents.type} = 'sleep'))::float8`,
      })
      .from(dailyEvents)
      .where(
        and(
          eq(dailyEvents.userId, userId),
          eq(dailyEvents.localDate, localDate),
          isNull(dailyEvents.deletedAt),
        ),
      );

    const row = rows[0];
    return {
      eventsLogged: row?.eventsLogged ?? 0,
      mealsLogged: row?.mealsLogged ?? 0,
      waterMl: row?.waterMl ?? 0,
      sleepMinutes: row?.sleepMinutes ?? null,
      firstMealAt: toDate(row?.firstMealEpoch),
      lastMealAt: toDate(row?.lastMealEpoch),
      bedtimeAt: toDate(row?.bedtimeEpoch),
    };
  }

  async findCheckinForDay(userId: string, localDate: string): Promise<CheckinRow | undefined> {
    return this.db.query.checkins.findFirst({
      where: and(eq(checkins.userId, userId), eq(checkins.localDate, localDate)),
    });
  }
}

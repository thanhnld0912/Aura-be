import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import { checkins, dailyEvents } from '../../database/schema/index.js';

export type CheckinRow = typeof checkins.$inferSelect;

export interface UpsertCheckinInput {
  userId: string;
  localDate: string;
  occurredAt: Date;
  mood: CheckinRow['mood'];
  dayTag?: CheckinRow['dayTag'];
  energy1to5?: number | null;
  note?: string | null;
}

/**
 * A check-in is both an event and a detail row: it appears on the timeline like
 * anything else that happened, and carries mood, tag and note alongside
 * (ARCHITECTURE.md §6). Both are written in one transaction so neither can exist
 * without the other.
 */
export class CheckinsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Upsert per day (API_DESIGN.md §12) — changing your mind at 21:00 about how the day
   * felt replaces the 09:00 answer rather than logging a second one.
   */
  async upsertForDay(
    input: UpsertCheckinInput,
  ): Promise<{ checkin: CheckinRow; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query.checkins.findFirst({
        where: and(eq(checkins.userId, input.userId), eq(checkins.localDate, input.localDate)),
      });

      if (existing) {
        await tx
          .update(dailyEvents)
          .set({ occurredAt: input.occurredAt, note: input.note ?? null, updatedAt: new Date() })
          .where(
            and(eq(dailyEvents.id, existing.eventId), eq(dailyEvents.userId, input.userId)),
          );

        const [updated] = await tx
          .update(checkins)
          .set({
            mood: input.mood,
            dayTag: input.dayTag ?? null,
            energy1to5: input.energy1to5 ?? null,
            note: input.note ?? null,
          })
          .where(and(eq(checkins.id, existing.id), eq(checkins.userId, input.userId)))
          .returning();

        if (!updated) throw new Error('check-in update returned no row');
        return { checkin: updated, created: false };
      }

      const [event] = await tx
        .insert(dailyEvents)
        .values({
          userId: input.userId,
          localDate: input.localDate,
          type: 'checkin',
          occurredAt: input.occurredAt,
          title: 'Check-in',
          note: input.note ?? null,
          inputMethod: 'manual',
          source: 'user',
        })
        .returning();
      if (!event) throw new Error('check-in event insert returned no row');

      const [created] = await tx
        .insert(checkins)
        .values({
          eventId: event.id,
          userId: input.userId,
          localDate: input.localDate,
          mood: input.mood,
          dayTag: input.dayTag ?? null,
          energy1to5: input.energy1to5 ?? null,
          note: input.note ?? null,
        })
        .returning();
      if (!created) throw new Error('check-in insert returned no row');

      return { checkin: created, created: true };
    });
  }

  async listRange(userId: string, from: string, to: string): Promise<CheckinRow[]> {
    return this.db
      .select()
      .from(checkins)
      .where(
        and(
          eq(checkins.userId, userId),
          gte(checkins.localDate, from),
          lte(checkins.localDate, to),
        ),
      )
      .orderBy(asc(checkins.localDate));
  }
}

import type { Db } from '../../database/client.js';
import { dailyEvents, workoutSessions } from '../../database/schema/index.js';

export type WorkoutSessionRow = typeof workoutSessions.$inferSelect;
export type WorkoutEventRow = typeof dailyEvents.$inferSelect;

export interface CreateWorkoutInput {
  userId: string;
  localDate: string;
  occurredAt: Date;
  workoutType: WorkoutSessionRow['workoutType'];
  title: string;
  durationMin: number | null;
  perceivedEffort: number | null;
  note: string | null;
}

/**
 * A workout is both an event and a session row, like a check-in (ARCHITECTURE.md §6):
 * the event puts it on the timeline and lets it satisfy a planned workout; the session
 * carries what only a workout has. Both are written in one transaction so neither can
 * exist without the other — which is why `POST /api/events` refuses `workout`.
 */
export class WorkoutsRepository {
  constructor(private readonly db: Db) {}

  async create(
    input: CreateWorkoutInput,
  ): Promise<{ session: WorkoutSessionRow; event: WorkoutEventRow }> {
    return this.db.transaction(async (tx) => {
      const [event] = await tx
        .insert(dailyEvents)
        .values({
          userId: input.userId,
          localDate: input.localDate,
          type: 'workout',
          occurredAt: input.occurredAt,
          title: input.title,
          durationMin: input.durationMin,
          note: input.note,
          inputMethod: 'manual',
          source: 'user',
        })
        .returning();
      if (!event) throw new Error('workout event insert returned no row');

      const [session] = await tx
        .insert(workoutSessions)
        .values({
          eventId: event.id,
          userId: input.userId,
          workoutType: input.workoutType,
          // Only a completed session can be logged here. A skip is its own endpoint in
          // the design (API_DESIGN.md §10) because it requires a reason.
          status: 'completed',
          durationMin: input.durationMin,
          perceivedEffort: input.perceivedEffort,
        })
        .returning();
      if (!session) throw new Error('workout session insert returned no row');

      return { session, event };
    });
  }
}

import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { skipReasonEnum, workoutStatusEnum, workoutTypeEnum } from './enums.js';
import { dailyEvents } from './events.js';
import { users } from './users.js';

/**
 * A skipped workout is **recorded, not erased** (API_DESIGN.md §10). The reason
 * distribution is exactly what makes "workouts scheduled after 18:00 are more often
 * skipped for `tired`" discoverable by the Pattern Engine — deleting the row would
 * delete the finding.
 *
 * Created in Phase 2; the endpoints that write it arrive with the workouts module.
 */
export const workoutSessions = pgTable(
  'workout_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .unique()
      .references(() => dailyEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workoutType: workoutTypeEnum('workout_type').notNull(),
    status: workoutStatusEnum('status').notNull(),
    skipReason: skipReasonEnum('skip_reason'),
    skipNote: text('skip_note'),
    durationMin: integer('duration_min'),
    perceivedEffort: integer('perceived_effort'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_workouts_user').on(table.userId, table.createdAt.desc()),
    // A skip reason only makes sense for a skipped session — and is required for one.
    check(
      'chk_skip_reason',
      sql`(${table.status} = 'skipped') = (${table.skipReason} is not null)`,
    ),
    check(
      'chk_perceived_effort',
      sql`${table.perceivedEffort} is null or (${table.perceivedEffort} between 1 and 5)`,
    ),
  ],
);

export const workoutExercises = pgTable(
  'workout_exercises',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => workoutSessions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sets: integer('sets'),
    reps: integer('reps'),
    weightKg: numeric('weight_kg', { precision: 6, scale: 2 }),
    durationSec: integer('duration_sec'),
    distanceKm: numeric('distance_km', { precision: 7, scale: 3 }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [index('idx_workout_exercises_session').on(table.sessionId, table.sortOrder)],
);

export const workoutSessionsRelations = relations(workoutSessions, ({ one, many }) => ({
  user: one(users, { fields: [workoutSessions.userId], references: [users.id] }),
  event: one(dailyEvents, { fields: [workoutSessions.eventId], references: [dailyEvents.id] }),
  exercises: many(workoutExercises),
}));

export const workoutExercisesRelations = relations(workoutExercises, ({ one }) => ({
  session: one(workoutSessions, {
    fields: [workoutExercises.sessionId],
    references: [workoutSessions.id],
  }),
}));

import { relations } from 'drizzle-orm';
import {
  boolean,
  date,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { habitCadenceEnum, habitLogStatusEnum } from './enums.js';
import { dailyEvents } from './events.js';
import { users } from './users.js';

/**
 * `is_system` habits are AURA's own — `workout_consistency`, `meal_logging_consistency`,
 * `sleep_consistency`, `plan_adherence` — seeded per user at provisioning and logged
 * from events rather than by hand (API_DESIGN.md §11).
 *
 * Deleting a habit archives it and never destroys its logs: the streak history is
 * Pattern Engine input.
 */
export const habits = pgTable(
  'habits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    title: text('title').notNull(),
    cadence: habitCadenceEnum('cadence').notNull().default('daily'),
    schedule: jsonb('schedule').$type<{ daysOfWeek?: number[]; timesPerWeek?: number }>(),
    icon: text('icon'),
    isSystem: boolean('is_system').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idx_habits_user_key').on(table.userId, table.key)],
);

export const habitLogs = pgTable(
  'habit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    habitId: uuid('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => dailyEvents.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    localDate: date('local_date').notNull(),
    status: habitLogStatusEnum('status').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idx_habit_log_day').on(table.habitId, table.localDate)],
);

export const habitsRelations = relations(habits, ({ one, many }) => ({
  user: one(users, { fields: [habits.userId], references: [users.id] }),
  logs: many(habitLogs),
}));

export const habitLogsRelations = relations(habitLogs, ({ one }) => ({
  habit: one(habits, { fields: [habitLogs.habitId], references: [habits.id] }),
  user: one(users, { fields: [habitLogs.userId], references: [users.id] }),
}));

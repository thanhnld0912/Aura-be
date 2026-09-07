import { relations } from 'drizzle-orm';
import { date, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { dayTagEnum, moodEnum } from './enums.js';
import { dailyEvents } from './events.js';
import { users } from './users.js';

/**
 * Mood and note (audit items 8 & 9). One per user per local day, upserted.
 *
 * `day_tag` is the vocabulary the existing UI already uses — `not_as_planned`, not
 * `bad_day`. The data model has no word for a failed day.
 */
export const checkins = pgTable(
  'checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .unique()
      .references(() => dailyEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    localDate: date('local_date').notNull(),
    mood: moodEnum('mood').notNull(),
    dayTag: dayTagEnum('day_tag'),
    energy1to5: integer('energy_1_5'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idx_checkins_user_date').on(table.userId, table.localDate)],
);

export const checkinsRelations = relations(checkins, ({ one }) => ({
  user: one(users, { fields: [checkins.userId], references: [users.id] }),
  event: one(dailyEvents, { fields: [checkins.eventId], references: [dailyEvents.id] }),
}));

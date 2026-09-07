import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  goalFocusEnum,
  localeEnum,
  nutritionDisplayEnum,
  unitSystemEnum,
} from './enums.js';

/**
 * `users.id` **equals** the Supabase `auth.users` uid, with no cross-schema foreign
 * key on purpose (DATABASE_DESIGN.md §3.1): it keeps migrations portable if auth is
 * ever replaced, and mirroring rather than coupling is Supabase's own guidance.
 *
 * Rows are created by JIT provisioning on the first authenticated request, so there
 * is no webhook to fail and no window where a valid token has no profile.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull().unique(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
    locale: localeEnum('locale').notNull().default('vi'),
    dateOfBirth: date('date_of_birth'),
    streakDays: integer('streak_days').notNull().default(0),
    streakLastDate: date('streak_last_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * `DELETE /api/users/me` soft-deletes immediately and a Phase 5 job hard-deletes
     * after 30 days (SECURITY.md §9). Not in the Phase 0 ERD; added here because the
     * endpoint that needs it is Phase 2.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_users_active').on(table.id).where(sql`${table.deletedAt} is null`),
  ],
);

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  unitSystem: unitSystemEnum('unit_system').notNull().default('metric'),
  /**
   * §10 opt-out, and a real one: when false the API omits the number entirely rather
   * than the client hiding it (NUTRITION_ARCHITECTURE.md §8). Enforced in Phase 3 by
   * the response schema, which cannot serialize a field it does not declare.
   */
  showCalories: boolean('show_calories').notNull().default(true),
  nutritionDisplay: nutritionDisplayEnum('nutrition_display').notNull().default('focus'),
  dietaryFlags: jsonb('dietary_flags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  dislikedFoods: jsonb('disliked_foods').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  goalFocus: goalFocusEnum('goal_focus').notNull().default('consistency'),
  quietHoursStart: time('quiet_hours_start'),
  quietHoursEnd: time('quiet_hours_end'),
  aiInsightsEnabled: boolean('ai_insights_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ one }) => ({
  preferences: one(userPreferences, {
    fields: [users.id],
    references: [userPreferences.userId],
  }),
}));

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(users, { fields: [userPreferences.userId], references: [users.id] }),
}));

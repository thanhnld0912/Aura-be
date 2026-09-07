import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Every categorical field in the design is a real PostgreSQL enum, not free text with
 * a comment. Validation belongs in the database for invariants the database can hold
 * (SECURITY.md §3) — a bad value fails on write rather than surfacing months later in
 * an aggregate.
 *
 * Note what is absent: there is no `failed` and no `missed` anywhere in this file.
 * The vocabulary is a product decision enforced by the type system (README principle 8).
 */

/** Derived from the frontend's `ActivityCategory` (DATABASE_DESIGN.md §3.2). */
export const eventTypeEnum = pgEnum('event_type', [
  'meal',
  'workout',
  'walk',
  'sleep',
  'water',
  'habit',
  'checkin',
  'custom',
]);

export const planSourceEnum = pgEnum('plan_source', ['user', 'ai', 'template']);
export const planStatusEnum = pgEnum('plan_status', ['draft', 'active', 'archived']);

/** DATABASE_DESIGN.md §3.3 — computed, never punitive. */
export const adherenceEnum = pgEnum('adherence', [
  'pending',
  'on_time',
  'shifted',
  'substituted',
  'not_logged',
]);

export const inputMethodEnum = pgEnum('input_method', ['photo', 'text', 'quick', 'manual', 'auto']);
export const eventSourceEnum = pgEnum('event_source', ['user', 'ai', 'imported']);

export const mealTypeEnum = pgEnum('meal_type', ['breakfast', 'lunch', 'dinner', 'snack', 'drink']);
export const mealStatusEnum = pgEnum('meal_status', ['draft', 'confirmed', 'discarded']);
export const mealItemUnitEnum = pgEnum('meal_item_unit', [
  'g',
  'ml',
  'bowl',
  'piece',
  'plate',
  'serving',
]);
export const portionLabelEnum = pgEnum('portion_label', ['small', 'medium', 'large', 'custom']);

/** DATABASE_DESIGN.md §3.5 — the provenance chain. `user` always wins. */
export const nutritionSourceEnum = pgEnum('nutrition_source', [
  'vision',
  'text',
  'quick',
  'usda',
  'off',
  'local',
  'user',
  'unresolved',
]);

export const foodProviderEnum = pgEnum('food_provider', ['usda', 'off', 'local']);
export const dataQualityEnum = pgEnum('data_quality', ['high', 'medium', 'low']);

export const workoutTypeEnum = pgEnum('workout_type', [
  'gym',
  'run',
  'walk',
  'yoga',
  'sport',
  'home',
  'other',
]);
export const workoutStatusEnum = pgEnum('workout_status', ['completed', 'partial', 'skipped']);
export const skipReasonEnum = pgEnum('skip_reason', [
  'busy',
  'tired',
  'no_time',
  'not_motivated',
  'other',
]);

export const habitCadenceEnum = pgEnum('habit_cadence', ['daily', 'weekly', 'custom']);
export const habitLogStatusEnum = pgEnum('habit_log_status', ['done', 'partial', 'skipped']);

export const moodEnum = pgEnum('mood', ['low', 'okay', 'good', 'great']);
export const dayTagEnum = pgEnum('day_tag', [
  'normal',
  'busy',
  'better_than_expected',
  'not_as_planned',
]);

export const localeEnum = pgEnum('locale', ['vi', 'en']);
export const unitSystemEnum = pgEnum('unit_system', ['metric', 'imperial']);
export const nutritionDisplayEnum = pgEnum('nutrition_display', ['focus', 'detail', 'hidden']);
export const goalFocusEnum = pgEnum('goal_focus', ['consistency', 'variety', 'movement']);

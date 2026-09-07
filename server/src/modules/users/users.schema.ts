import { z } from 'zod';
import { localDateSchema, localTimeSchema } from '../../lib/api-schemas.js';
import type { UserWithPreferences } from './users.repository.js';

/** Request and response contracts for `/api/users` (API_DESIGN.md §5). */

export const userProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  timezone: z.string(),
  locale: z.enum(['vi', 'en']),
  dateOfBirth: z.string().nullable(),
  /** Serves the header streak (audit item 16). */
  streakDays: z.number().int(),
  createdAt: z.string(),
});

export const preferencesSchema = z.object({
  unitSystem: z.enum(['metric', 'imperial']),
  showCalories: z.boolean(),
  nutritionDisplay: z.enum(['focus', 'detail', 'hidden']),
  dietaryFlags: z.array(z.string()),
  dislikedFoods: z.array(z.string()),
  goalFocus: z.enum(['consistency', 'variety', 'movement']),
  aiInsightsEnabled: z.boolean(),
  quietHours: z.object({ start: z.string(), end: z.string() }).nullable(),
});

export const meResponseSchema = z.object({
  user: userProfileSchema,
  preferences: preferencesSchema,
});

export const updateProfileSchema = z
  .object({
    displayName: z.string().min(1).max(60),
    timezone: z.string().min(1).max(64),
    locale: z.enum(['vi', 'en']),
    avatarUrl: z.string().url().max(2048),
    dateOfBirth: localDateSchema,
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'at least one field is required');

export const updatePreferencesSchema = z
  .object({
    unitSystem: z.enum(['metric', 'imperial']),
    showCalories: z.boolean(),
    nutritionDisplay: z.enum(['focus', 'detail', 'hidden']),
    dietaryFlags: z.array(z.string().min(1).max(40)).max(20),
    dislikedFoods: z.array(z.string().min(1).max(60)).max(50),
    goalFocus: z.enum(['consistency', 'variety', 'movement']),
    aiInsightsEnabled: z.boolean(),
    quietHours: z.object({ start: localTimeSchema, end: localTimeSchema }).strict().nullable(),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'at least one field is required');

/**
 * Deleting an account is irreversible from the user's point of view, so it takes an
 * explicit confirmation rather than a bare DELETE (API_DESIGN.md §5).
 */
export const deleteAccountSchema = z
  .object({ confirm: z.literal('DELETE') })
  .strict();

export const deleteAccountResponseSchema = z.object({
  status: z.literal('scheduled'),
  /** Soft-deleted now; the hard delete, including storage objects, runs after 30 days. */
  hardDeleteAfterDays: z.number().int(),
});

/** One place that turns rows into the wire contract, so every endpoint agrees. */
export function toMeResponse(found: UserWithPreferences): z.infer<typeof meResponseSchema> {
  const { user, preferences } = found;
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      timezone: user.timezone,
      locale: user.locale,
      dateOfBirth: user.dateOfBirth,
      streakDays: user.streakDays,
      createdAt: user.createdAt.toISOString(),
    },
    preferences: {
      unitSystem: preferences.unitSystem,
      showCalories: preferences.showCalories,
      nutritionDisplay: preferences.nutritionDisplay,
      dietaryFlags: preferences.dietaryFlags,
      dislikedFoods: preferences.dislikedFoods,
      goalFocus: preferences.goalFocus,
      aiInsightsEnabled: preferences.aiInsightsEnabled,
      quietHours:
        preferences.quietHoursStart && preferences.quietHoursEnd
          ? {
              start: preferences.quietHoursStart.slice(0, 5),
              end: preferences.quietHoursEnd.slice(0, 5),
            }
          : null,
    },
  };
}

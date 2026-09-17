import { z } from 'zod';
import { PATTERN_DIRECTIONS, PATTERN_KINDS } from '../../insights/pattern-evidence.js';
import {
  COMPARISON_METRICS,
  LIMITATION_CODES,
  type WeeklyReport,
} from '../../insights/weekly-report.js';
import type { WeeklyStory } from '../../insights/weekly-story.js';
import { localDateSchema } from '../../lib/api-schemas.js';

/**
 * `/api/insights` (API_DESIGN.md §13, as built in Phase 4 Task 7).
 *
 * `null` is load-bearing throughout the report: it is how the contract says "not
 * logged", as distinct from a real 0. No figure in these schemas is optional — each is
 * present, and either a number or an explicit `null`.
 */

export const weeklyQuerySchema = z.object({ weekStart: localDateSchema.optional() }).strict();

/** No `userId`, and `.strict()`: the week is the only thing a caller chooses. */
export const weeklyStoryBodySchema = z.object({ weekStart: localDateSchema.optional() }).strict();

const count = z.number().int().min(0);
const share = z.number().min(0).max(1);
const sectionStatus = z.enum(['ok', 'no_data']);
const comparisonStatus = z.enum(['available', 'insufficient_data', 'unavailable']);
const mood = z.enum(['low', 'okay', 'good', 'great']);

const planTally = z.object({
  planned: count,
  resolved: count,
  happened: count,
  rate: share.nullable(),
});

export const weeklyReportSchema = z.object({
  period: z.object({
    weekStart: z.string(),
    weekEnd: z.string(),
    timezone: z.string(),
    daysInPeriod: count,
    daysElapsed: count,
    isComplete: z.boolean(),
  }),
  coverage: z.object({
    daysTracked: count,
    daysElapsed: count,
    rate: share.nullable(),
    status: z.enum(['sufficient', 'insufficient_data']),
  }),
  days: z.array(
    z.object({
      localDate: z.string(),
      elapsed: z.boolean(),
      tracked: z.boolean().nullable(),
      eventsLogged: count.nullable(),
      mealsLogged: count.nullable(),
      mood: mood.nullable(),
    }),
  ),
  nutrition: z.object({
    status: sectionStatus,
    daysWithConfirmedMeals: count,
    coverage: share.nullable(),
    confirmedMeals: count.nullable(),
    averageMealsPerLoggedDay: z.number().min(0).nullable(),
    distinctFoods: count.nullable(),
    itemsNeedingReview: count.nullable(),
  }),
  activity: z.object({
    status: sectionStatus,
    activeDays: count,
    walks: count.nullable(),
    workoutSessions: z.object({ completed: count, partial: count, skipped: count }).nullable(),
  }),
  plan: z.object({
    status: sectionStatus,
    daysWithPlan: count,
    plannedItems: count.nullable(),
    resolvedItems: count.nullable(),
    happenedItems: count.nullable(),
    pendingItems: count.nullable(),
    adherenceRate: share.nullable(),
    byAdherence: z
      .object({ pending: count, on_time: count, shifted: count, substituted: count, not_logged: count })
      .nullable(),
    activity: planTally.nullable(),
  }),
  habits: z.object({
    status: sectionStatus,
    daysWithLogs: count,
    trackedHabits: count.nullable(),
    logs: z.object({ done: count, partial: count, skipped: count }).nullable(),
    completionRate: share.nullable(),
  }),
  checkins: z.object({
    status: sectionStatus,
    daysWithCheckin: count,
    moodCounts: z.object({ low: count, okay: count, good: count, great: count }).nullable(),
    dayTagCounts: z
      .object({ normal: count, busy: count, better_than_expected: count, not_as_planned: count })
      .nullable(),
    averageEnergy: z.number().min(1).max(5).nullable(),
    energySamples: count.nullable(),
  }),
  sleep: z.object({
    status: sectionStatus,
    daysWithSleep: count,
    averageSleepMinutes: count.nullable(),
  }),
  comparison: z.object({
    previousWeekStart: z.string(),
    status: comparisonStatus,
    metrics: z.array(
      z.object({
        metric: z.enum(COMPARISON_METRICS),
        status: comparisonStatus,
        current: share.nullable(),
        previous: share.nullable(),
        delta: z.number().min(-1).max(1).nullable(),
        direction: z.enum(['up', 'down', 'flat']).nullable(),
      }),
    ),
  }),
  patterns: z.object({
    status: z.enum(['unavailable', 'none', 'available']),
    items: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(PATTERN_KINDS),
        subjectMetric: z.string(),
        subjectLabel: z.string(),
        objectMetric: z.string().nullable(),
        objectLabel: z.string().nullable(),
        direction: z.enum(PATTERN_DIRECTIONS),
        strength: z.number().min(-1).max(1),
        pValue: z.number().nullable(),
        sampleSize: count,
        windowDays: count,
        coverage: share,
        /** Required: a pattern is never served without its hedge (API_DESIGN.md §14). */
        caveat: z.string(),
      }),
    ),
  }),
  dataQuality: z.object({ limitations: z.array(z.enum(LIMITATION_CODES)) }),
});

const storyStatementSchema = z.object({
  text: z.string(),
  /** Deterministic source ids: `metric:…`, `comparison:…`, `pattern:…`, `limitation:…`. */
  evidence: z.array(z.string()),
});

/**
 * The story is sectioned by *kind of claim*, so a client can always tell a fact from a
 * pattern, an interpretation, a suggestion and a caveat without parsing prose.
 */
export const weeklyStorySchema = z.object({
  promptVersion: z.string(),
  headline: z.string(),
  summary: storyStatementSchema,
  highlights: z.array(storyStatementSchema.extend({ type: z.enum(['fact', 'comparison']) })),
  patterns: z.array(
    z.object({
      patternId: z.string(),
      statement: z.string(),
      /** The engine's caveat, verbatim — never model-authored. */
      caveat: z.string(),
      evidence: z.array(z.string()),
    }),
  ),
  interpretations: z.array(storyStatementSchema),
  suggestions: z.array(storyStatementSchema),
  caveats: z.array(storyStatementSchema),
});

export const weeklyStoryResponseSchema = z.object({
  status: z.enum(['ready', 'insufficient_data', 'disabled']),
  report: weeklyReportSchema,
  story: weeklyStorySchema.nullable(),
});

/**
 * Fails to compile if the domain types stop fitting the published contract, so a field
 * added to the report cannot quietly be dropped by the serializer. Type-level only.
 */
type Fits<Runtime, Schema> = Runtime extends Schema ? true : never;
const _contractFits: [
  Fits<WeeklyReport, z.infer<typeof weeklyReportSchema>>,
  Fits<WeeklyStory, z.infer<typeof weeklyStorySchema>>,
] = [true, true];
void _contractFits;

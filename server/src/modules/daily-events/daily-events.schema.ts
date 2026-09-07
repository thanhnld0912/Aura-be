import { z } from 'zod';
import { instantSchema, localDateSchema, paginationSchema } from '../../lib/api-schemas.js';
import { GENERIC_EVENT_TYPES } from './daily-events.service.js';
import type { DailyEventRow } from './daily-events.repository.js';

/** `/api/events` (API_DESIGN.md §7). */

export const eventTypeSchema = z.enum([
  'meal',
  'workout',
  'walk',
  'sleep',
  'water',
  'habit',
  'checkin',
  'custom',
]);

export const eventSchema = z.object({
  id: z.string().uuid(),
  type: eventTypeSchema,
  occurredAt: z.string(),
  localDate: z.string(),
  title: z.string(),
  durationMin: z.number().int().nullable(),
  note: z.string().nullable(),
  inputMethod: z.enum(['photo', 'text', 'quick', 'manual', 'auto']),
  source: z.enum(['user', 'ai', 'imported']),
  metrics: z.record(z.number()).nullable(),
  /**
   * The typed payload hanging off the event. `meal` and `workout` detail arrive with
   * their modules in Phase 3 and later; until then a meal event genuinely has no
   * detail row, and `null` says so rather than inventing one.
   */
  detail: z.null(),
});

export const eventListSchema = z.object({
  data: z.array(eventSchema),
  nextCursor: z.string().nullable(),
});

export const createEventSchema = z
  .object({
    type: z.enum(GENERIC_EVENT_TYPES),
    title: z.string().min(1).max(80),
    occurredAt: instantSchema.optional(),
    durationMin: z.number().int().min(1).max(1440).optional(),
    note: z.string().max(500).optional(),
    metrics: z.record(z.number().finite()).optional(),
  })
  .strict();

export const updateEventSchema = z
  .object({
    title: z.string().min(1).max(80),
    occurredAt: instantSchema,
    durationMin: z.number().int().min(1).max(1440).nullable(),
    note: z.string().max(500).nullable(),
    metrics: z.record(z.number().finite()).nullable(),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'at least one field is required');

export const listEventsQuerySchema = paginationSchema
  .extend({
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    type: eventTypeSchema.optional(),
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: 'from must not be after to',
    path: ['from'],
  });

export const todayQuerySchema = z.object({ date: localDateSchema.optional() }).strict();

export function toEventResponse(row: DailyEventRow): z.infer<typeof eventSchema> {
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    localDate: row.localDate,
    title: row.title,
    durationMin: row.durationMin,
    note: row.note,
    inputMethod: row.inputMethod,
    source: row.source,
    metrics: row.metrics ?? null,
    detail: null,
  };
}

import { z } from 'zod';
import { localDateSchema, localTimeSchema } from '../../lib/api-schemas.js';
import { eventTypeSchema } from '../daily-events/daily-events.schema.js';
import type { PlanWithItems } from './daily-plans.repository.js';

/** `/api/daily-plan` (API_DESIGN.md §6). */

export const adherenceSchema = z.enum([
  'pending',
  'on_time',
  'shifted',
  'substituted',
  'not_logged',
]);

export const planItemSchema = z.object({
  id: z.string().uuid(),
  eventType: eventTypeSchema,
  title: z.string(),
  plannedTime: z.string(),
  plannedDurationMin: z.number().int().nullable(),
  target: z.record(z.unknown()).nullable(),
  sortOrder: z.number().int(),
  adherence: adherenceSchema,
  shiftMinutes: z.number().int().nullable(),
  linkedEventId: z.string().uuid().nullable(),
});

export const planSchema = z.object({
  id: z.string().uuid(),
  localDate: z.string(),
  source: z.enum(['user', 'ai', 'template']),
  status: z.enum(['draft', 'active', 'archived']),
  items: z.array(planItemSchema),
});

const planItemInputSchema = z
  .object({
    eventType: eventTypeSchema,
    title: z.string().min(1).max(80),
    plannedTime: localTimeSchema,
    plannedDurationMin: z.number().int().min(1).max(600).optional(),
    target: z.record(z.unknown()).optional(),
  })
  .strict();

export const createPlanSchema = z
  .object({
    localDate: localDateSchema,
    items: z.array(planItemInputSchema).min(1).max(20),
  })
  .strict();

/**
 * A PATCH replaces the item list and/or the status. It is the user editing their
 * *intention* — reconciliation never comes through here, and there is deliberately no
 * way for a client to set `adherence`, `linkedEventId` or `shiftMinutes`
 * (DATABASE_DESIGN.md §3.3).
 */
export const updatePlanSchema = z
  .object({
    items: z.array(planItemInputSchema).min(1).max(20),
    status: z.enum(['draft', 'active', 'archived']),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'at least one field is required');

export const planDateQuerySchema = z.object({ date: localDateSchema.optional() }).strict();

export const comparisonSchema = z.object({
  localDate: z.string(),
  adherencePct: z.number().nullable(),
  items: z.array(
    z.object({
      planItemId: z.string().uuid(),
      planned: z.object({
        title: z.string(),
        time: z.string(),
        type: eventTypeSchema,
        durationMin: z.number().int().nullable(),
      }),
      actual: z
        .object({
          id: z.string().uuid(),
          title: z.string(),
          time: z.string(),
          type: eventTypeSchema,
          durationMin: z.number().int().nullable(),
        })
        .nullable(),
      adherence: adherenceSchema,
      shiftMinutes: z.number().int().nullable(),
    }),
  ),
  /** Neutral by design — things that also happened, not "extras" or "violations". */
  unplanned: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      time: z.string(),
      type: eventTypeSchema,
    }),
  ),
});

export function toPlanResponse(found: PlanWithItems): z.infer<typeof planSchema> {
  return {
    id: found.plan.id,
    localDate: found.plan.localDate,
    source: found.plan.source,
    status: found.plan.status,
    items: found.items.map((item) => ({
      id: item.id,
      eventType: item.eventType,
      title: item.title,
      // Postgres `time` is HH:mm:ss; the contract is HH:mm.
      plannedTime: item.plannedTime.slice(0, 5),
      plannedDurationMin: item.plannedDurationMin,
      target: item.target ?? null,
      sortOrder: item.sortOrder,
      adherence: item.adherence,
      shiftMinutes: item.shiftMinutes,
      linkedEventId: item.linkedEventId,
    })),
  };
}

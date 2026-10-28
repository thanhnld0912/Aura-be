import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { instantSchema } from '../../lib/api-schemas.js';
import { bucket } from '../../middleware/rate-limit.js';
import { requireUser } from '../auth/auth.plugin.js';
import { respondIdempotently, type IdempotencyService } from '../idempotency/idempotency.service.js';
import type { WorkoutEventRow, WorkoutSessionRow } from './workouts.repository.js';
import type { WorkoutsService } from './workouts.service.js';

/**
 * `/api/workouts` (API_DESIGN.md §10) — logging a completed workout.
 *
 * Only creation exists so far. Skipping and history are designed but not built, and
 * `exercises` is not accepted yet: the strict schema refuses it rather than dropping it.
 */

export const workoutTypeSchema = z.enum(['gym', 'run', 'walk', 'yoga', 'sport', 'home', 'other']);

export const workoutSchema = z.object({
  id: z.guid(),
  eventId: z.guid(),
  workoutType: workoutTypeSchema,
  status: z.enum(['completed', 'partial', 'skipped']),
  title: z.string(),
  occurredAt: z.string(),
  localDate: z.string(),
  durationMin: z.number().int().nullable(),
  perceivedEffort: z.number().int().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

export const createWorkoutSchema = z
  .object({
    workoutType: workoutTypeSchema,
    /** The event's title. Defaults to the type ("Gym", "Run"). */
    title: z.string().min(1).max(80).optional(),
    occurredAt: instantSchema.optional(),
    durationMin: z.number().int().min(1).max(600).optional(),
    /** How hard it felt, 1–5. The person's own rating, not a measurement. */
    perceivedEffort: z.number().int().min(1).max(5).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

function toWorkoutResponse(created: {
  session: WorkoutSessionRow;
  event: WorkoutEventRow;
}): z.infer<typeof workoutSchema> {
  const { session, event } = created;
  return {
    id: session.id,
    eventId: event.id,
    workoutType: session.workoutType,
    status: session.status,
    title: event.title,
    occurredAt: event.occurredAt.toISOString(),
    localDate: event.localDate,
    durationMin: session.durationMin,
    perceivedEffort: session.perceivedEffort,
    note: event.note,
    createdAt: session.createdAt.toISOString(),
  };
}

export async function workoutsRoutes(
  app: FastifyInstance,
  options: { workoutsService: WorkoutsService; idempotency: IdempotencyService },
): Promise<void> {
  const { workoutsService, idempotency } = options;

  app.post(
    '/',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { body: createWorkoutSchema, response: { 201: workoutSchema } },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body as z.infer<typeof createWorkoutSchema>;

      return respondIdempotently(request, reply, idempotency, user.id, {
        operation: 'POST /api/workouts',
        write: async (db) => {
          const created = await workoutsService.within(db).write(user.id, user.timezone, body);
          return { statusCode: 201, body: toWorkoutResponse(created), localDate: created.event.localDate };
        },
        refresh: (localDate) => workoutsService.refreshDay(user.id, localDate, user.timezone),
      });
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDateSchema } from '../../lib/api-schemas.js';
import { addLocalDays, todayIn } from '../../lib/local-date.js';
import { bucket } from '../../middleware/rate-limit.js';
import { requireUser } from '../auth/auth.plugin.js';
import type { CheckinRow } from './checkins.repository.js';
import type { CheckinsService } from './checkins.service.js';

/**
 * `/api/checkins` (API_DESIGN.md §12) — the mood selector and note (audit items 8 & 9).
 *
 * The vocabulary is the existing UI's: `not_as_planned`, never `bad_day`. There is no
 * enum value here that describes the person rather than the day.
 */

export const checkinSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  localDate: z.string(),
  mood: z.enum(['low', 'okay', 'good', 'great']),
  dayTag: z.enum(['normal', 'busy', 'better_than_expected', 'not_as_planned']).nullable(),
  energy1to5: z.number().int().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

export const createCheckinSchema = z
  .object({
    localDate: localDateSchema.optional(),
    mood: z.enum(['low', 'okay', 'good', 'great']),
    dayTag: z.enum(['normal', 'busy', 'better_than_expected', 'not_as_planned']).optional(),
    energy1to5: z.number().int().min(1).max(5).optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const listCheckinsQuerySchema = z
  .object({ from: localDateSchema.optional(), to: localDateSchema.optional() })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: 'from must not be after to',
    path: ['from'],
  });

function toCheckinResponse(row: CheckinRow): z.infer<typeof checkinSchema> {
  return {
    id: row.id,
    eventId: row.eventId,
    localDate: row.localDate,
    mood: row.mood,
    dayTag: row.dayTag,
    energy1to5: row.energy1to5,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function checkinsRoutes(
  app: FastifyInstance,
  options: { checkinsService: CheckinsService },
): Promise<void> {
  const { checkinsService } = options;

  app.post(
    '/',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: {
        body: createCheckinSchema,
        response: { 200: checkinSchema, 201: checkinSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body as z.infer<typeof createCheckinSchema>;

      // Upsert per day: changing your mind at 21:00 about how the day felt replaces
      // the morning's answer rather than logging a second check-in.
      const { checkin, created } = await checkinsService.upsert(user.id, user.timezone, body);
      return reply.status(created ? 201 : 200).send(toCheckinResponse(checkin));
    },
  );

  app.get(
    '/',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: listCheckinsQuerySchema,
        response: { 200: z.object({ data: z.array(checkinSchema) }) },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const query = request.query as z.infer<typeof listCheckinsQuerySchema>;

      const to = query.to ?? todayIn(user.timezone);
      // A month back by default — enough for the History view without an unbounded scan.
      const from = query.from ?? addLocalDays(to, -30);

      const rows = await checkinsService.list(user.id, from, to);
      return { data: rows.map(toCheckinResponse) };
    },
  );
}

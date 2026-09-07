import { z } from 'zod';

/** `GET /api/health` — API_DESIGN.md §3. */

export const checkStatusSchema = z.enum(['ok', 'error']);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const healthResponseSchema = z.object({
  /** `error` only when a *critical* dependency is down; a degraded provider is `degraded`. */
  status: z.enum(['ok', 'degraded', 'error']),
  version: z.string(),
  /** Whole seconds since process start. */
  uptime: z.number().int().nonnegative(),
  checks: z.record(checkStatusSchema),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

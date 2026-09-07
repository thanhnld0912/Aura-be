import { z } from 'zod';
import { LOCAL_DATE_PATTERN, LOCAL_TIME_PATTERN } from './local-date.js';

/**
 * Schema pieces shared across modules, so every endpoint spells a date, a time and an
 * id the same way (API_DESIGN.md §1). One definition also means one place to tighten a
 * bound.
 *
 * Objects are `.strict()` at the call site: unknown keys are rejected rather than
 * ignored (SECURITY.md §3), which turns a client typo into a 400 instead of a setting
 * that silently never applied.
 */

/** `YYYY-MM-DD` in the user's timezone. */
export const localDateSchema = z
  .string()
  .regex(LOCAL_DATE_PATTERN, 'must be YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'must be a real date');

/** `HH:mm`, 24-hour. Postgres `time` values are normalised to this on the way out. */
export const localTimeSchema = z.string().regex(LOCAL_TIME_PATTERN, 'must be HH:mm');

export const uuidSchema = z.string().uuid();

export const idParamSchema = z.object({ id: uuidSchema }).strict();

/** ISO-8601 instant. Accepted on input; always emitted in UTC. */
export const instantSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const instantOutSchema = z.date().transform((value) => value.toISOString());

/**
 * Cursor pagination (API_DESIGN.md §1). Offsets are not offered — history is
 * append-heavy and an offset drifts as rows arrive underneath it.
 */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

/** `204 No Content` still needs a declared response for the registration guard. */
export const noContentSchema = z.null();

/** Postgres `time` comes back as `HH:mm:ss`; the API contract is `HH:mm`. */
export function toApiTime(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

/** Postgres `numeric` comes back as a string to preserve precision. */
export function toApiNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

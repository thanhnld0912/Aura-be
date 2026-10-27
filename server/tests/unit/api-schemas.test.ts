import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../src/lib/errors.js';
import { instantSchema } from '../../src/lib/api-schemas.js';
import { validatorCompiler } from '../../src/middleware/validation.js';

/**
 * `instantSchema` accepts RFC 3339 date-times — the `format: date-time` the OpenAPI document
 * publishes — and nothing looser. Zod 3 also took a missing seconds field and an offset
 * without a colon; that broader behaviour was deliberately not kept with Zod 4.
 */
describe('instantSchema', () => {
  it.each([
    ['2026-10-27T10:00:00Z', '2026-10-27T10:00:00.000Z'],
    ['2026-10-27T10:00:00.123Z', '2026-10-27T10:00:00.123Z'],
    ['2026-10-27T10:00:00.123456Z', '2026-10-27T10:00:00.123Z'],
    ['2026-10-27T17:00:00+07:00', '2026-10-27T10:00:00.000Z'],
    ['2026-10-27T04:30:00-05:30', '2026-10-27T10:00:00.000Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
  ])('accepts %s as that instant', (input, iso) => {
    const parsed = instantSchema.parse(input);
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.toISOString()).toBe(iso);
  });

  it.each([
    ['missing seconds', '2026-10-27T10:00Z'],
    ['missing seconds, with an offset', '2026-10-27T10:00+07:00'],
    ['an offset without a colon', '2026-10-27T10:00:00+0700'],
    ['an offset past 23 hours', '2026-10-27T10:00:00+24:00'],
    ['an offset past 59 minutes', '2026-10-27T10:00:00+07:60'],
    ['a nonsense offset', '2026-10-27T10:00:00+99:99'],
    ['no zone at all', '2026-10-27T10:00:00'],
    ['a date only', '2026-10-27'],
    ['a space instead of T', '2026-10-27 10:00:00Z'],
    ['an impossible day', '2026-02-30T10:00:00Z'],
    ['a day past a non-leap February', '2026-02-29T10:00:00Z'],
    ['an impossible hour', '2026-10-27T24:00:00Z'],
    ['free text', 'yesterday'],
    ['an empty string', ''],
  ])('rejects %s (%s)', (_why, input) => {
    expect(instantSchema.safeParse(input).success).toBe(false);
  });

  it.each([1_730_000_000_000, null, {}])('rejects a non-string (%s)', (input) => {
    expect(instantSchema.safeParse(input).success).toBe(false);
  });

  it('reports a malformed instant to clients as it always has', () => {
    const validate = validatorCompiler({
      schema: z.object({ occurredAt: instantSchema }),
      method: 'POST',
      url: '/x',
      httpPart: 'body',
    });
    const { error } = validate({ occurredAt: '2026-10-27T10:00Z' }) as { error: ValidationError };
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual([{ path: 'occurredAt', issue: 'invalid_string' }]);
    expect(error.message).toBe('occurredAt: Invalid datetime');
  });
});

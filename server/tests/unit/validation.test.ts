import type { RouteOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../src/lib/errors.js';
import {
  assertRouteIsValidated,
  DETAILS_OMITTED,
  MAX_VALIDATION_DETAILS,
  serializerCompiler,
  validatorCompiler,
} from '../../src/middleware/validation.js';

const route = (partial: Partial<RouteOptions>): RouteOptions =>
  ({ method: 'GET', url: '/x', handler: async () => ({}), ...partial }) as RouteOptions;

describe('assertRouteIsValidated', () => {
  it('rejects a route with no response schema', () => {
    expect(() => assertRouteIsValidated(route({}))).toThrow(/response schema/);
  });

  it('rejects a route whose response schema is empty', () => {
    expect(() => assertRouteIsValidated(route({ schema: { response: {} } }))).toThrow(
      /response schema/,
    );
  });

  it('rejects a mutating route with no body schema', () => {
    expect(() =>
      assertRouteIsValidated(route({ method: 'POST', schema: { response: { 200: z.object({}) } } })),
    ).toThrow(/body schema/);
  });

  it('accepts a mutating route that opts out for multipart', () => {
    expect(() =>
      assertRouteIsValidated(
        route({
          method: 'POST',
          config: { skipBodySchema: true },
          schema: { response: { 200: z.object({}) } },
        }),
      ),
    ).not.toThrow();
  });

  it('exempts CORS preflight and auto-registered HEAD routes', () => {
    expect(() => assertRouteIsValidated(route({ method: 'OPTIONS' }))).not.toThrow();
    expect(() => assertRouteIsValidated(route({ method: 'HEAD' }))).not.toThrow();
  });

  it('accepts a fully described route', () => {
    expect(() =>
      assertRouteIsValidated(
        route({
          method: ['POST'],
          schema: { body: z.object({ a: z.string() }), response: { 200: z.object({}) } },
        }),
      ),
    ).not.toThrow();
  });
});

describe('validatorCompiler', () => {
  const compile = (schema: z.ZodTypeAny, httpPart = 'body') =>
    validatorCompiler({ schema, method: 'POST', url: '/x', httpPart });

  it('returns the parsed value on success, with unknown keys stripped', () => {
    const validate = compile(z.object({ a: z.string() }));
    expect(validate({ a: 'x', b: 'dropped' })).toEqual({ value: { a: 'x' } });
  });

  it('returns a ValidationError carrying zod paths and codes', () => {
    const validate = compile(z.object({ items: z.array(z.object({ quantity: z.number().positive() })) }));
    const result = validate({ items: [{ quantity: 0 }] }) as { error: ValidationError };

    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error.statusCode).toBe(400);
    expect(result.error.details).toEqual([{ path: 'items.0.quantity', issue: 'too_small' }]);
  });

  it('names the request part it rejected', () => {
    const result = compile(z.object({ limit: z.number() }), 'querystring')({}) as {
      error: ValidationError;
    };
    expect(result.error.message).toContain('querystring');
  });
});

/**
 * What clients received before Zod 4, kept: the frontend shows `message` as written and
 * shows and matches `details[].issue`.
 */
describe('validatorCompiler — the published error contract', () => {
  const rejected = (schema: z.ZodTypeAny, data: unknown): ValidationError =>
    (validatorCompiler({ schema, method: 'POST', url: '/x', httpPart: 'body' })(data) as { error: ValidationError })
      .error;

  it('publishes the issue codes clients have always seen', () => {
    const schema = z
      .object({
        unit: z.enum(['chén', 'tô']),
        confirm: z.literal('DELETE'),
        id: z.guid(),
        quantity: z.number().positive(),
        name: z.string(),
      })
      .strict();
    const error = rejected(schema, { unit: 'bát', confirm: 'delete', id: 'nope', quantity: 0, extra: 1 });
    expect(error.details).toEqual([
      { path: 'unit', issue: 'invalid_enum_value' },
      { path: 'confirm', issue: 'invalid_literal' },
      { path: 'id', issue: 'invalid_string' },
      { path: 'quantity', issue: 'too_small' },
      { path: 'name', issue: 'invalid_type' },
      { path: '', issue: 'unrecognized_keys' },
    ]);
  });

  it('words messages as before', () => {
    const message = (schema: z.ZodTypeAny, data: unknown) => rejected(z.object({ f: schema }), { f: data }).message;
    expect(message(z.number().positive(), 0)).toBe('f: Number must be greater than 0');
    expect(message(z.string(), undefined)).toBe('f: Required');
    expect(message(z.string(), 5)).toBe('f: Expected string, received number');
    expect(message(z.number().int(), 1.5)).toBe('f: Expected integer, received float');
    expect(message(z.string().max(3), 'abcd')).toBe('f: String must contain at most 3 character(s)');
    expect(message(z.array(z.number()).min(1), [])).toBe('f: Array must contain at least 1 element(s)');
    expect(message(z.enum(['chén', 'tô']), 'bát')).toBe("f: Invalid enum value. Expected 'chén' | 'tô', received 'bát'");
    expect(message(z.literal('DELETE'), 'x')).toBe('f: Invalid literal value, expected "DELETE"');
    expect(message(z.guid(), 'nope')).toBe('f: Invalid uuid');
    expect(message(z.string().url(), 'nope')).toBe('f: Invalid url');
    expect(rejected(z.object({}).strict(), { a: 1, b: 2 }).message).toBe("Unrecognized key(s) in object: 'a', 'b'");
    // A message written on the schema still wins.
    expect(message(z.string().min(1, 'cannot be empty'), '')).toBe('f: cannot be empty');
  });

  describe('an enum given the wrong type', () => {
    const units = z.enum(['chén', 'tô', 'bát']);
    const reported = (value: unknown) => {
      const error = rejected(z.object({ unit: units }), value === undefined ? {} : { unit: value });
      return { details: error.details, message: error.message };
    };

    it.each([
      ['a number', 5, 'number'],
      ['null', null, 'null'],
      ['a boolean', true, 'boolean'],
      ['an array', ['chén'], 'array'],
      ['an object', { unit: 'chén' }, 'object'],
    ])('reports %s as invalid_type, naming the options from the schema', (_what, value, received) => {
      expect(reported(value)).toEqual({
        details: [{ path: 'unit', issue: 'invalid_type' }],
        message: `unit: Expected 'chén' | 'tô' | 'bát', received ${received}`,
      });
    });

    it('reports a missing enum field as Required', () => {
      expect(reported(undefined)).toEqual({
        details: [{ path: 'unit', issue: 'invalid_type' }],
        message: 'unit: Required',
      });
    });

    it('still reports a string outside the options as invalid_enum_value', () => {
      expect(reported('kg')).toEqual({
        details: [{ path: 'unit', issue: 'invalid_enum_value' }],
        message: "unit: Invalid enum value. Expected 'chén' | 'tô' | 'bát', received 'kg'",
      });
    });

    it('leaves nullable and optional enums accepting what they always did', () => {
      const validate = (schema: z.ZodTypeAny, data: unknown) =>
        validatorCompiler({ schema, method: 'POST', url: '/x', httpPart: 'body' })(data);
      expect(validate(z.object({ unit: units.nullable() }), { unit: null })).toEqual({ value: { unit: null } });
      expect(validate(z.object({ unit: units.optional() }), {})).toEqual({ value: {} });
    });

    it('leaves a literal given the wrong type as invalid_literal', () => {
      const error = rejected(z.object({ confirm: z.literal('DELETE') }), { confirm: 5 });
      expect(error.details).toEqual([{ path: 'confirm', issue: 'invalid_literal' }]);
      expect(error.message).toBe('confirm: Invalid literal value, expected "DELETE"');
    });

    it('leaves other type errors as they were', () => {
      const error = rejected(z.object({ name: z.string(), quantity: z.number() }), { name: 5, quantity: 'x' });
      expect(error.details).toEqual([
        { path: 'name', issue: 'invalid_type' },
        { path: 'quantity', issue: 'invalid_type' },
      ]);
      expect(error.message).toBe('name: Expected string, received number');
    });
  });

  it('accepts any 8-4-4-4-12 hex id, as before — not only RFC 9562 UUIDs', () => {
    const schema = z.object({ id: z.guid() });
    const accepts = (id: string) => validatorCompiler({ schema, method: 'GET', url: '/x', httpPart: 'params' })({ id });
    expect(accepts('00000000-0000-0000-0000-000000000001')).toEqual({
      value: { id: '00000000-0000-0000-0000-000000000001' },
    });
    expect(accepts('123E4567-E89B-12D3-A456-426614174000')).toHaveProperty('value');
  });
});

describe('validatorCompiler — oversized input', () => {
  const compile = (schema: z.ZodTypeAny) => validatorCompiler({ schema, method: 'POST', url: '/x', httpPart: 'body' });

  it(`returns at most ${MAX_VALIDATION_DETAILS} details, then says the rest were omitted`, () => {
    const schema = z.object({ items: z.array(z.string()) });
    const error = (compile(schema)({ items: Array.from({ length: 500 }, () => 1) }) as { error: ValidationError }).error;

    expect(error.details).toHaveLength(MAX_VALIDATION_DETAILS + 1);
    expect(error.details?.slice(0, 2)).toEqual([
      { path: 'items.0', issue: 'invalid_type' },
      { path: 'items.1', issue: 'invalid_type' },
    ]);
    expect(error.details?.at(-1)).toEqual(DETAILS_OMITTED);
    // The message still names the first problem.
    expect(error.message).toBe('items.0: Expected string, received number');
  });

  it('reports every issue, unmarked, when there are no more than the limit', () => {
    const schema = z.object({ items: z.array(z.string()) });
    const error = (compile(schema)({ items: Array.from({ length: MAX_VALIDATION_DETAILS }, () => 1) }) as {
      error: ValidationError;
    }).error;
    expect(error.details).toHaveLength(MAX_VALIDATION_DETAILS);
    expect(error.details).not.toContainEqual(DETAILS_OMITTED);
  });

  it('rejects an oversized constrained array without validating each element (GHSA-mrhx-c7xc-m3w5)', () => {
    const schema = z.object({ items: z.array(z.string()).max(10) });
    const error = (compile(schema)({ items: Array.from({ length: 200_000 }, () => 1) }) as { error: ValidationError })
      .error;
    expect(error.details).toEqual([{ path: 'items', issue: 'too_big' }]);
  });
});

describe('serializerCompiler', () => {
  const compile = (schema: z.ZodTypeAny) =>
    serializerCompiler({ schema, method: 'GET', url: '/x', httpStatus: '200' });

  it('serializes only what the contract declares', () => {
    // This is the mechanism behind `showCalories: false` — an undeclared field is
    // not serialized, so it never reaches the browser at all
    // (NUTRITION_ARCHITECTURE.md §8).
    const serialize = compile(z.object({ name: z.string() }));
    expect(serialize({ name: 'cơm trắng', calories: 260 })).toBe('{"name":"cơm trắng"}');
  });

  it('throws a 500 rather than emitting a payload the contract forbids', () => {
    const serialize = compile(z.object({ name: z.string() }));
    expect(() => serialize({ name: 42 })).toThrow(/Response did not match its schema/);
  });
});

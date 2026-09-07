import type { RouteOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../src/lib/errors.js';
import {
  assertRouteIsValidated,
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

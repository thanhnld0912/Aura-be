import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import { idempotencyKeyOf, requestHash } from '../../src/modules/idempotency/idempotency.service.js';

const withHeader = (value: string | string[] | undefined) =>
  ({ headers: value === undefined ? {} : { 'idempotency-key': value } }) as unknown as FastifyRequest;

describe('idempotencyKeyOf', () => {
  it('is optional — no header, no key', () => {
    expect(idempotencyKeyOf(withHeader(undefined))).toBeUndefined();
  });

  it.each(['3f1c2b9a-7d4e-4c1a-9b2f-0e8d7c6b5a41', '01JBTEST9ZXK', 'a', 'x'.repeat(255)])('accepts %s', (key) => {
    expect(idempotencyKeyOf(withHeader(key))).toBe(key);
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(256)],
    ['with a space', 'two words'],
    ['non-ASCII', 'khóa'],
    ['sent twice', ['a', 'b']],
  ])('rejects a key that is %s as a 400', (_why, value) => {
    expect(() => idempotencyKeyOf(withHeader(value))).toThrow(ValidationError);
    try {
      idempotencyKeyOf(withHeader(value));
    } catch (error) {
      expect((error as ValidationError).details).toEqual([{ path: 'idempotency-key', issue: 'invalid_string' }]);
    }
  });
});

describe('requestHash', () => {
  it('is the same for the same request however its keys are ordered', () => {
    expect(requestHash({ type: 'walk', title: 'Walk', metrics: { km: 2, ml: 1 } })).toBe(
      requestHash({ metrics: { ml: 1, km: 2 }, title: 'Walk', type: 'walk' }),
    );
  });

  it('differs when any value differs, nested ones included', () => {
    const base = { type: 'water', title: 'Water', metrics: { ml: 250 } };
    expect(requestHash(base)).not.toBe(requestHash({ ...base, metrics: { ml: 500 } }));
    expect(requestHash(base)).not.toBe(requestHash({ ...base, note: 'x' }));
  });

  it('hashes a parsed date as the instant it is', () => {
    expect(requestHash({ occurredAt: new Date('2026-10-27T10:00:00Z') })).toBe(
      requestHash({ occurredAt: '2026-10-27T10:00:00.000Z' }),
    );
  });
});

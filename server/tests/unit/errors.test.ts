import { describe, expect, it } from 'vitest';
import {
  AiSchemaError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  UnauthenticatedError,
  UnderageError,
  UnsupportedMediaTypeError,
  ValidationError,
  isAppError,
} from '../../src/lib/errors.js';

describe('error hierarchy', () => {
  it('maps each error to the status and code in API_DESIGN.md §1', () => {
    const cases = [
      [new ValidationError(), 400, 'VALIDATION_ERROR'],
      [new UnderageError(), 400, 'UNDERAGE'],
      [new UnauthenticatedError(), 401, 'UNAUTHENTICATED'],
      [new ForbiddenError(), 403, 'FORBIDDEN'],
      [new NotFoundError(), 404, 'NOT_FOUND'],
      [new ConflictError(), 409, 'CONFLICT'],
      [new PayloadTooLargeError(), 413, 'PAYLOAD_TOO_LARGE'],
      [new UnsupportedMediaTypeError(), 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [new AiSchemaError(), 422, 'AI_SCHEMA_ERROR'],
      [new RateLimitedError(30), 429, 'RATE_LIMITED'],
      [new InternalError(), 500, 'INTERNAL_ERROR'],
      [new ProviderError('gemini'), 502, 'PROVIDER_ERROR'],
      [new ProviderUnavailableError(), 503, 'PROVIDER_UNAVAILABLE'],
    ] as const;

    for (const [error, statusCode, code] of cases) {
      expect(error.statusCode, code).toBe(statusCode);
      expect(error.code).toBe(code);
      expect(isAppError(error)).toBe(true);
    }
  });

  it('builds the documented envelope', () => {
    const envelope = new ValidationError('quantity must be greater than 0', [
      { path: 'items.0.quantity', issue: 'too_small' },
    ]).toEnvelope('01JBQTESTREQUESTID000000');

    expect(envelope).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'quantity must be greater than 0',
        details: [{ path: 'items.0.quantity', issue: 'too_small' }],
        requestId: '01JBQTESTREQUESTID000000',
      },
    });
  });

  it('omits details when there are none', () => {
    const envelope = new NotFoundError().toEnvelope('rid');
    expect(envelope.error).not.toHaveProperty('details');
  });

  it('always sends Retry-After with a 429, rounded up to at least one second', () => {
    expect(new RateLimitedError(0.2).headers).toEqual({ 'retry-after': '1' });
    expect(new RateLimitedError(42.1).headers).toEqual({ 'retry-after': '43' });
  });

  it('keeps the cause off the envelope', () => {
    const secret = new Error('password=hunter2 at /srv/aura/src/db.ts:12');
    const envelope = new InternalError(undefined, secret).toEnvelope('rid');
    expect(JSON.stringify(envelope)).not.toContain('hunter2');
    expect(envelope.error.message).toBe('An unexpected error occurred');
  });
});

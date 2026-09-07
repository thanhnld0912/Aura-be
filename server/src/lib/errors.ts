/**
 * The error model (API_DESIGN.md §1). Every failure the API emits is one of these
 * codes, in one envelope:
 *
 *   { "error": { "code", "message", "details"?, "requestId" } }
 *
 * Internal detail — stack traces, driver messages, filesystem paths, provider
 * secrets — never crosses this boundary (SECURITY.md §9). `AppError.message` is
 * written to be shown to a user; anything else is logged and replaced with a
 * generic message plus the `requestId` needed to find it in the logs.
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNDERAGE',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'AI_SCHEMA_ERROR',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'PROVIDER_ERROR',
  'PROVIDER_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A single field-level problem. `path` is dot-notation into the request body. */
export interface ErrorDetail {
  path: string;
  issue: string;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    requestId: string;
  };
}

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: ErrorCode;
  readonly details: ErrorDetail[] | undefined;
  /** Extra response headers, e.g. `Retry-After` on 429. */
  readonly headers: Record<string, string> | undefined;

  constructor(
    message: string,
    options?: { details?: ErrorDetail[]; headers?: Record<string, string>; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.details = options?.details;
    this.headers = options?.headers;
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        requestId,
      },
    };
  }
}

/** 400 — Zod rejected the request. */
export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR' as const;
  constructor(message = 'Request validation failed', details?: ErrorDetail[]) {
    super(message, details ? { details } : {});
  }
}

/** 400 — under-13 registration is rejected (SECURITY.md §7). */
export class UnderageError extends AppError {
  readonly statusCode = 400;
  readonly code = 'UNDERAGE' as const;
  constructor(message = 'AURA is not available to users under 13') {
    super(message);
  }
}

/**
 * 401 — missing, expired or invalid token. The message never says which check
 * failed (SECURITY.md §2).
 */
export class UnauthenticatedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHENTICATED' as const;
  constructor(message = 'Authentication required') {
    super(message);
  }
}

/** 403 — authenticated but not permitted. Ownership failures use `NotFoundError`. */
export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN' as const;
  constructor(message = 'Not permitted') {
    super(message);
  }
}

/**
 * 404 — absent, or owned by someone else. The two are deliberately
 * indistinguishable so the API cannot be used to enumerate ids (SECURITY.md §2).
 */
export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND' as const;
  constructor(message = 'Not found') {
    super(message);
  }
}

/** 409 — uniqueness violated, e.g. a plan already exists for that date. */
export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT' as const;
  constructor(message = 'Conflicts with existing data') {
    super(message);
  }
}

/** 413 — upload over `MAX_UPLOAD_BYTES`, or a JSON body over the 1 MB cap. */
export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413;
  readonly code = 'PAYLOAD_TOO_LARGE' as const;
  constructor(message = 'Payload too large') {
    super(message);
  }
}

/** 415 — not jpeg/png/webp, by magic bytes rather than by header. */
export class UnsupportedMediaTypeError extends AppError {
  readonly statusCode = 415;
  readonly code = 'UNSUPPORTED_MEDIA_TYPE' as const;
  constructor(message = 'Unsupported media type') {
    super(message);
  }
}

/**
 * 422 — model output failed Zod after a retry. A model response is input, not
 * truth; malformed output fails loudly rather than being persisted (Rule 10).
 */
export class AiSchemaError extends AppError {
  readonly statusCode = 422;
  readonly code = 'AI_SCHEMA_ERROR' as const;
  constructor(message = 'AI response could not be validated', details?: ErrorDetail[]) {
    super(message, details ? { details } : {});
  }
}

/** 429 — rate limit exceeded. Always carries `Retry-After`. */
export class RateLimitedError extends AppError {
  readonly statusCode = 429;
  readonly code = 'RATE_LIMITED' as const;
  constructor(retryAfterSeconds: number, message = 'Too many requests') {
    super(message, { headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))) } });
  }
}

/** 500 — anything unhandled. The real cause is logged, never returned. */
export class InternalError extends AppError {
  readonly statusCode = 500;
  readonly code = 'INTERNAL_ERROR' as const;
  constructor(message = 'An unexpected error occurred', cause?: unknown) {
    super(message, cause === undefined ? {} : { cause });
  }
}

/** 502 — an upstream AI or nutrition provider failed. */
export class ProviderError extends AppError {
  readonly statusCode = 502;
  readonly code = 'PROVIDER_ERROR' as const;
  constructor(
    readonly provider: string,
    message = 'An upstream provider failed',
    cause?: unknown,
  ) {
    super(message, cause === undefined ? {} : { cause });
  }
}

/** 503 — all providers exhausted, or a required dependency is down. */
export class ProviderUnavailableError extends AppError {
  readonly statusCode = 503;
  readonly code = 'PROVIDER_UNAVAILABLE' as const;
  constructor(message = 'Service temporarily unavailable', cause?: unknown) {
    super(message, cause === undefined ? {} : { cause });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

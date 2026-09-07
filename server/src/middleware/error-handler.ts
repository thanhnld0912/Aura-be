import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  InternalError,
  NotFoundError,
  isAppError,
  type ErrorCode,
  type ErrorEnvelope,
} from '../lib/errors.js';

/**
 * One envelope out, always (API_DESIGN.md §1). Errors report a `requestId` to the
 * client and keep the stack trace server-side; internal error messages are never
 * returned (SECURITY.md §9).
 */

/** Fallback mapping for errors raised by Fastify itself rather than by our code. */
const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  503: 'PROVIDER_UNAVAILABLE',
};

const GENERIC_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Request validation failed',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Not permitted',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflicts with existing data',
  UNDERAGE: 'AURA is not available to users under 13',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
  AI_SCHEMA_ERROR: 'AI response could not be validated',
  RATE_LIMITED: 'Too many requests',
  INTERNAL_ERROR: 'An unexpected error occurred',
  PROVIDER_ERROR: 'An upstream provider failed',
  PROVIDER_UNAVAILABLE: 'Service temporarily unavailable',
};

function normalise(error: unknown): AppError {
  if (isAppError(error)) return error;

  const fastifyError = error as Partial<FastifyError> & { statusCode?: number };
  const status = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;

  if (status >= 500) return new InternalError(undefined, error);

  const code = STATUS_TO_CODE[status] ?? 'VALIDATION_ERROR';
  // Framework messages (FST_*) describe the request, not our internals, so they are
  // safe to surface. Anything else falls back to the generic text for that code.
  const isFrameworkMessage =
    typeof fastifyError.code === 'string' && fastifyError.code.startsWith('FST_');
  const message =
    isFrameworkMessage && fastifyError.message ? fastifyError.message : GENERIC_MESSAGE[code];

  return new PassthroughError(status, code, message);
}

/** Wraps a framework-raised 4xx so it leaves through the same envelope as our own. */
class PassthroughError extends AppError {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const appError = normalise(error);
    const requestId = request.id;

    const logContext = {
      err: error,
      code: appError.code,
      statusCode: appError.statusCode,
      method: request.method,
      route: request.routeOptions?.url ?? request.url,
    };

    if (appError.statusCode >= 500) {
      request.log.error(logContext, 'request failed');
    } else {
      request.log.warn(logContext, 'request rejected');
    }

    if (appError.headers) reply.headers(appError.headers);

    const envelope: ErrorEnvelope = appError.toEnvelope(requestId);
    void reply.status(appError.statusCode).send(envelope);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const envelope = new NotFoundError().toEnvelope(request.id);
    void reply.status(404).send(envelope);
  });
}

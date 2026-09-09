import type {
  FastifyInstance,
  FastifySchemaCompiler,
  FastifySerializerCompiler,
  RouteOptions,
} from 'fastify';
import { z, type ZodIssue, type ZodTypeAny } from 'zod';
import { InternalError, ValidationError, type ErrorDetail } from '../lib/errors.js';

/**
 * Zod is wired in globally (SECURITY.md §3) so validation cannot be forgotten:
 * every request body, query and param passes a schema before reaching a handler,
 * and `assertRouteIsValidated` makes a route without one fail to *register*
 * rather than silently accept anything.
 *
 * The serializer half matters just as much. Responses are serialized through the
 * declared Zod schema, so a value the contract does not mention cannot leak into
 * the payload — this is the mechanism that will make `showCalories: false` mean
 * "the number never reaches the browser" rather than "the number is hidden in CSS"
 * (NUTRITION_ARCHITECTURE.md §8).
 */

function toDetails(issues: ZodIssue[]): ErrorDetail[] {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    issue: issue.code,
  }));
}

function toValidationError(error: z.ZodError, part: string): ValidationError {
  const first = error.issues[0];
  const where = part === 'body' ? '' : ` (${part})`;
  const message = first
    ? `${first.path.length > 0 ? `${first.path.join('.')}: ` : ''}${first.message}${where}`
    : `Invalid ${part}`;
  return new ValidationError(message, toDetails(error.issues));
}

/**
 * Returning an `Error` from a validator compiler makes Fastify hand it straight to
 * the error handler with `statusCode` already set, so an `AppError` survives intact.
 */
export const validatorCompiler: FastifySchemaCompiler<ZodTypeAny> =
  ({ schema, httpPart }) =>
  (data) => {
    const result = schema.safeParse(data);
    if (result.success) return { value: result.data };
    return { error: toValidationError(result.error, httpPart ?? 'body') };
  };

export const serializerCompiler: FastifySerializerCompiler<ZodTypeAny> =
  ({ schema }) =>
  (payload) => {
    const result = schema.safeParse(payload);
    if (!result.success) {
      // The handler produced something the published contract does not allow.
      // That is a server bug, not a client one — 500, and the detail stays in the log.
      throw new InternalError(
        `Response did not match its schema: ${result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.code}`)
          .join(', ')}`,
      );
    }
    return JSON.stringify(result.data);
  };

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const EXEMPT_METHODS = new Set(['HEAD', 'OPTIONS']);

/**
 * Swagger UI serves its own page and static assets from here.
 *
 * They are not API endpoints: they accept no user input, return HTML and JavaScript
 * rather than a domain payload, and are excluded from the OpenAPI document itself. The
 * guard exists to stop an *API* route shipping without a schema, and this exemption is
 * deliberately a fixed prefix rather than anything a route can opt into — no handler
 * under `/api` can reach it.
 */
const DOCS_PREFIX = '/docs';

/**
 * Registration-time guard. A route that declares no response schema, or a mutating
 * route that declares no body schema, throws at boot — which is a failed deploy,
 * not an unvalidated endpoint in production.
 *
 * Multipart routes (Phase 4's image upload) opt out of the body check with
 * `config: { skipBodySchema: true }`; their payload is validated by magic-byte
 * sniffing instead (SECURITY.md §4).
 */
export function assertRouteIsValidated(route: RouteOptions): void {
  const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((m) =>
    String(m).toUpperCase(),
  );
  if (methods.every((m) => EXEMPT_METHODS.has(m))) return;
  if (route.url === DOCS_PREFIX || route.url.startsWith(`${DOCS_PREFIX}/`)) return;

  const where = `${methods.join('|')} ${route.url}`;
  const schema = route.schema as
    | { body?: unknown; response?: Record<string, unknown> }
    | undefined;

  if (!schema?.response || Object.keys(schema.response).length === 0) {
    throw new Error(
      `Route ${where} registered without a response schema. ` +
        'Every route must declare `schema.response` (SECURITY.md §3).',
    );
  }

  const skipBodySchema =
    (route.config as { skipBodySchema?: boolean } | undefined)?.skipBodySchema === true;

  if (methods.some((m) => BODY_METHODS.has(m)) && !schema.body && !skipBodySchema) {
    throw new Error(
      `Route ${where} registered without a body schema. ` +
        'Declare `schema.body`, or set `config.skipBodySchema` for multipart routes.',
    );
  }
}

export function registerValidation(app: FastifyInstance): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onRoute', assertRouteIsValidated);
}

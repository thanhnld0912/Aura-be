import type {
  FastifyInstance,
  FastifySchemaCompiler,
  FastifySerializerCompiler,
  RouteOptions,
} from 'fastify';
import { z, type ZodIssue, type ZodTypeAny } from 'zod';
import { InternalError, ValidationError, type ErrorDetail } from '../lib/errors.js';
// Zod 3's validation messages: `message` is shown to users as written.
import { isEnumTypeMismatch } from '../lib/zod-messages.js';

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

/**
 * At most this many entries in `details`. A body with thousands of invalid elements yields
 * thousands of issues, and serializing every one of them is work an attacker chooses the
 * size of. The first entries are the useful ones; the rest are reported as omitted.
 */
export const MAX_VALIDATION_DETAILS = 50;

/** The last entry of a truncated `details`. Same shape as any other entry. */
export const DETAILS_OMITTED: ErrorDetail = { path: '', issue: 'additional_issues_omitted' };

/**
 * `details[].issue` as clients have always received it. Zod 4 renamed three issue codes;
 * the frontend shows and matches the old names, so they are translated back rather than
 * changing the contract along with the library. Every other code is unchanged in Zod 4.
 */
function publishedCode(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_format':
      return 'invalid_string';
    case 'invalid_value':
      // Zod 4 merged `invalid_literal` and `invalid_enum_value`. A literal allows exactly
      // one value; every enum in this API allows several.
      if (issue.values.length === 1) return 'invalid_literal';
      // An enum given a non-string was a type error in Zod 3. The input is on the issue only
      // when the parse asked for it (`reportInput`, as `validatorCompiler` does); without it
      // the value-level code is the honest answer.
      return 'input' in issue && isEnumTypeMismatch(issue.input) ? 'invalid_type' : 'invalid_enum_value';
    default:
      return issue.code;
  }
}

function toDetails(issues: ZodIssue[]): ErrorDetail[] {
  const details = issues.slice(0, MAX_VALIDATION_DETAILS).map((issue) => ({
    path: issue.path.join('.'),
    issue: publishedCode(issue),
  }));
  if (issues.length > MAX_VALIDATION_DETAILS) details.push(DETAILS_OMITTED);
  return details;
}

/** Exported for the multipart route, which validates its text fields by hand. */
export function toValidationError(error: z.ZodError, part: string): ValidationError {
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
    // `reportInput` keeps each issue's input, which `publishedCode` needs to tell an enum's
    // type error from a wrong value. Only codes are derived from it; it is never serialized.
    const result = schema.safeParse(data, { reportInput: true });
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

import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { errorEnvelopeSchema } from '../lib/errors.js';
import { API_VERSION } from '../lib/version.js';

/**
 * OpenAPI 3 documentation and a Swagger UI to exercise it.
 *
 * Documentation only — this file adds no behaviour to any existing endpoint. It reads
 * the Zod schemas the routes already declare and publishes them; nothing here changes
 * validation, serialization, auth or a response contract.
 *
 * ## Why a transform is needed
 *
 * `@fastify/swagger` expects `route.schema` to hold JSON Schema. AURA's routes hold raw
 * **Zod** objects, because `middleware/validation.ts` installs Zod validator and
 * serializer compilers globally (SECURITY.md §3). So the two disagree about what a
 * schema *is*, and the transform below is the adapter: it converts each Zod part to
 * JSON Schema at documentation time and leaves the runtime schema untouched.
 *
 * That is the property worth keeping — the documented contract is generated from the
 * same object that validates the request, so the docs cannot drift from the behaviour.
 */

/** Where the UI lives. Also the prefix its own asset routes are served under. */
export const DOCS_ROUTE_PREFIX = '/docs';

/**
 * The endpoints that take no bearer token (API_DESIGN.md §1).
 *
 * Declared rather than inferred from each route's `preHandler`, so the list is
 * reviewable in one place: an endpoint appearing here is a deliberate decision, not an
 * accident of introspection. Everything not listed inherits the document-level
 * `bearerAuth` requirement.
 *
 * `POST /api/auth/session` is unauthenticated in the header sense — it carries the
 * Supabase access token in its *body* and exchanges it for an AURA identity.
 */
const UNAUTHENTICATED_ROUTES = new Set([
  'GET /api/health',
  'GET /api/nutrition/search',
  'POST /api/auth/session',
]);

/**
 * The operations that cannot answer 401, because no part of their path touches a
 * token.
 *
 * Deliberately not `UNAUTHENTICATED_ROUTES`: those two sets look alike and mean
 * different things. `POST /api/auth/session` needs no *header* — it carries the
 * Supabase token in its body — but verifying that token is the entire point of the
 * endpoint, so a bad one is a 401. Reusing the security list here would have
 * documented that away.
 */
const NO_AUTH_FAILURE_ROUTES = new Set(['GET /api/health', 'GET /api/nutrition/search']);

/** The component every error response points at. Registered under `components`. */
const ERROR_ENVELOPE_REF = '#/components/schemas/ErrorEnvelope';

/**
 * What each documented failure means. The wording is the contract's, not new
 * behaviour: every one of these is a status the API already returns.
 */
const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Validation failed. `details` names the offending fields.',
  401: 'Missing, expired or invalid token.',
  404: 'Absent, or owned by another user — the two are deliberately indistinguishable.',
  413: 'Upload over the size limit, image dimensions over the supported maximum, or more form parts than the endpoint accepts.',
  415: 'Not multipart/form-data, or the file is not a readable JPEG, PNG or WebP image.',
  429: 'Rate limit exceeded. Carries a `Retry-After` header.',
  500: 'Unexpected failure. The cause is logged; quote `requestId` to find it.',
};

/**
 * The failures an operation can actually produce, derived from the route rather than
 * attached uniformly.
 *
 *   400  it validates something — a body, a query string or a path parameter
 *   401  anything that verifies a token, which is everything but the two above
 *   404  it takes an id, and the services behind those throw `NotFoundError`
 *   413  it accepts an upload: size, dimensions and part counts are enforced on every one
 *   415  it accepts an upload: the file's bytes are sniffed whatever the header claims
 *   429  always: the rate limiter is registered globally
 *   500  always: an unhandled throw becomes `InternalError`
 *
 * Not derived here, and so not documented: 403, 409, 422, 502 and 503.
 * Those depend on what a handler does rather than on the shape of its route, and
 * guessing would put responses in the document that the endpoint never sends. See
 * the report.
 */
function errorResponsesFor(
  operation: string,
  url: string,
  validatesInput: boolean,
  acceptsUpload = false,
): Record<string, unknown> {
  const codes = new Set<number>([429, 500]);
  if (validatesInput) codes.add(400);
  if (!NO_AUTH_FAILURE_ROUTES.has(operation)) codes.add(401);
  if (url.includes(':id') || url.includes('{id}')) codes.add(404);
  if (acceptsUpload) {
    codes.add(413);
    codes.add(415);
  }

  const responses: Record<string, unknown> = {};
  for (const code of [...codes].sort((a, b) => a - b)) {
    responses[String(code)] = {
      description: ERROR_DESCRIPTIONS[code],
      content: { 'application/json': { schema: { $ref: ERROR_ENVELOPE_REF } } },
    };
  }
  return responses;
}

/** Groups the operations in the UI. Order here is the order shown. */
const TAGS = [
  { name: 'Health', description: 'Liveness and dependency checks. No authentication.' },
  { name: 'Auth', description: 'Supabase session exchange and the current identity.' },
  { name: 'Users', description: 'Profile and preferences for the authenticated user.' },
  { name: 'Daily plans', description: 'Intentions, and how they compare with what happened.' },
  { name: 'Events', description: 'The timeline of what actually happened.' },
  { name: 'Check-ins', description: 'Mood and note, one per local day.' },
  { name: 'Workouts', description: 'Completed workout sessions, each with its timeline event.' },
  { name: 'Meals', description: 'Meal logging, parsing and confirmation.' },
  { name: 'Nutrition', description: 'Food search, deterministic calculation and totals.' },
  { name: 'Insights', description: 'Weekly facts from logged data, and the story written from them.' },
  { name: 'Agent', description: 'Conversational assistant grounded in the user’s own records.' },
];

/** Maps a URL prefix to the tag its operations belong to. */
const TAG_BY_PREFIX: ReadonlyArray<[string, string]> = [
  ['/api/health', 'Health'],
  ['/api/auth', 'Auth'],
  ['/api/users', 'Users'],
  ['/api/daily-plan', 'Daily plans'],
  ['/api/events', 'Events'],
  ['/api/checkins', 'Check-ins'],
  ['/api/workouts', 'Workouts'],
  ['/api/meals', 'Meals'],
  ['/api/nutrition', 'Nutrition'],
  ['/api/insights', 'Insights'],
  ['/api/agent', 'Agent'],
];

function tagFor(url: string): string[] {
  const matched = TAG_BY_PREFIX.find(([prefix]) => url.startsWith(prefix));
  return matched ? [matched[1]] : [];
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return value instanceof z.ZodType;
}

/**
 * Zod → JSON Schema, with Zod's own converter.
 *
 * `io: 'input'` is the important option: several request schemas end in a
 * `.transform()` (an ISO string becoming a `Date`, for instance), and the documentation
 * has to describe what a *client sends*, not what the handler receives.
 *
 * `reused: 'inline'` (the default) inlines shared sub-schemas. They would otherwise emit
 * `$ref: "#/$defs/..."`, which is not where an OpenAPI document keeps them, and the
 * resulting references would dangle in the UI.
 */
function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const converted = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
    reused: 'inline',
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  // A `$schema` declaration has no place inside an OpenAPI document.
  delete converted['$schema'];
  return asPublished(converted) as Record<string, unknown>;
}

/**
 * Keeps the document byte-for-byte what it was before Zod 4. AURA-FE vendors it and CI
 * compares the two copies, so a converter's change of phrasing must not reach clients as a
 * contract change. Each rule below undoes one way `z.toJSONSchema` words the same schema
 * differently from `zod-to-json-schema`, which does not read Zod 4 schemas:
 *
 * - `.int()` gains the safe-integer bounds as `minimum`/`maximum`; they were never published.
 * - String formats (`uuid`, `date-time`, …) gain the format's own regex as `pattern`;
 *   `format` alone was published.
 * - Object schemas validated as input omit `additionalProperties`; `false` was published.
 * - `z.null()` was published as `{ enum: ["null"], nullable: true }`.
 *
 * Validation is unaffected — it is Zod, not this document, that checks requests. Changing
 * what is published is a contract decision of its own, made with the frontend.
 */
function asPublished(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(asPublished);
  if (node === null || typeof node !== 'object') return node;

  const schema = node as Record<string, unknown>;
  if (schema['type'] === 'string' && schema['nullable'] === true && isNullOnlyEnum(schema['enum'])) {
    return { enum: ['null'], nullable: true };
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'minimum' && schema['type'] === 'integer' && value === -Number.MAX_SAFE_INTEGER) continue;
    if (key === 'maximum' && schema['type'] === 'integer' && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'pattern' && typeof schema['format'] === 'string') continue;
    result[key] =
      key === 'properties' && value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, asPublished(child)]))
        : asPublished(value);
  }
  if (schema['type'] === 'object' && 'properties' in schema && !('additionalProperties' in schema)) {
    result['additionalProperties'] = false;
  }
  return inPublishedOrder(result);
}

/** The keyword order the document was published in — key order is part of its bytes. */
const KEYWORD_ORDER = [
  'type',
  'format',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'exclusiveMinimum',
  'minimum',
  'exclusiveMaximum',
  'maximum',
  'default',
  'nullable',
];

function inPublishedOrder(schema: Record<string, unknown>): Record<string, unknown> {
  const rank = (key: string): number => {
    const index = KEYWORD_ORDER.indexOf(key);
    return index === -1 ? KEYWORD_ORDER.length : index;
  };
  const keys = Object.keys(schema).sort((a, b) => rank(a) - rank(b));
  return Object.fromEntries(keys.map((key) => [key, schema[key]]));
}

function isNullOnlyEnum(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === null;
}

/**
 * A `204` route declares `z.null()`, which converts to `{"type":"null"}` — valid in
 * JSON Schema and in OpenAPI 3.1, but not in the 3.0 document `@fastify/swagger`
 * produces. An empty schema is the honest description of "no content" anyway.
 */
function isNoContent(statusCode: string, schema: ZodTypeAny): boolean {
  return statusCode === '204' || schema instanceof z.ZodNull;
}

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'AURA API',
        description:
          'AURA AI Health & Fitness Companion API.\n\n' +
          '### Authenticating in this page\n\n' +
          'Supabase Auth issues the token; this API only verifies it. To get one:\n\n' +
          '1. Sign in through the AURA frontend, or call Supabase directly:\n' +
          '   `POST https://<project>.supabase.co/auth/v1/token?grant_type=password`\n' +
          '   with the header `apikey: <anon key>` and body ' +
          '`{ "email": "...", "password": "..." }`.\n' +
          '2. Take `access_token` from the response — a JWT beginning `eyJ`.\n' +
          '3. Press **Authorize** above and paste it. No `Bearer ` prefix; Swagger adds it.\n' +
          '4. Optionally call `POST /api/auth/session` with the same token in the body. ' +
          'That is the bootstrap call: it verifies the token and creates the AURA user row ' +
          'on first contact. It is the one endpoint that takes the token in the **body** ' +
          'rather than the header, so it needs no Authorize.\n\n' +
          'A Supabase **Personal Access Token** (`sbp_...`), the **anon key**, and the ' +
          '**service role key** are all rejected — none of them is a user JWT, and only ' +
          'a user JWT carries the `sub` that identifies whose data is being read.\n\n' +
          'Nutrition figures returned by this API are estimates carrying a source and a ' +
          'confidence, and every one of them can be corrected by the user. They are not ' +
          'medical advice.',
        version: API_VERSION,
      },
      servers: [{ url: '/', description: 'This server' }],
      tags: TAGS,
      components: {
        // The one named schema in the document. Everything else is inlined by
        // `$refStrategy: 'none'`; the envelope is the exception because it appears on
        // roughly a hundred responses, and inlining it there would quadruple the
        // document to say the same thing over and over.
        schemas: {
          ErrorEnvelope: toJsonSchema(errorEnvelopeSchema),
        },
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'A Supabase access token. Obtain one from Supabase Auth, then exchange it ' +
              'at `POST /api/auth/session` to provision the AURA user on first use.',
          },
        },
      },
      // Applied to every operation; cleared per route for the few that need no token.
      security: [{ bearerAuth: [] }],
    },

    /**
     * Runs once per route at registration. Returns the *documented* schema; the schema
     * Fastify validates against is untouched.
     */
    transform: ({ schema, url, route }) => {
      // The UI's own asset routes are not part of the API.
      if (url.startsWith(DOCS_ROUTE_PREFIX)) return { schema: { hide: true }, url };

      const source = schema as
        | (Record<string, unknown> & { response?: Record<string, ZodTypeAny> })
        | undefined;
      if (!source) return { schema, url };

      const converted: Record<string, unknown> = {};

      for (const part of ['body', 'querystring', 'params', 'headers'] as const) {
        const value = source[part];
        if (isZodSchema(value)) converted[part] = toJsonSchema(value);
      }

      // A multipart route has no Zod body — its payload is a stream the handler validates
      // itself (`skipBodySchema`). It can still say what it accepts: the route supplies
      // the form as documentation, emitted under `multipart/form-data` instead of JSON.
      // The schema Fastify validates with is untouched, as for every other part above.
      const multipartBody = (route.config as { multipartBody?: Record<string, unknown> } | undefined)
        ?.multipartBody;
      if (multipartBody) {
        converted['body'] = multipartBody;
        converted['consumes'] = ['multipart/form-data'];
      }

      if (source.response) {
        const responses: Record<string, unknown> = {};
        for (const [statusCode, responseSchema] of Object.entries(source.response)) {
          if (!isZodSchema(responseSchema)) continue;
          responses[statusCode] = isNoContent(statusCode, responseSchema)
            ? { description: 'No content' }
            : toJsonSchema(responseSchema);
        }
        converted['response'] = responses;
      }

      // A route declared as `'/'` under a prefix is reported by Fastify as `/api/meals/`.
      // Fastify serves both forms, and `API_DESIGN.md` spells it without the slash, so
      // the document uses the documented form.
      const documentedUrl = url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;

      const method = Array.isArray(route.method) ? route.method[0] : route.method;
      const operation = `${String(method).toUpperCase()} ${documentedUrl}`;

      // Merged in after the declared responses, and never over one: a route that
      // documents its own status keeps it. `/api/health` declares 503, which is how
      // it reports a database it cannot reach.
      const declared = (converted['response'] ?? {}) as Record<string, unknown>;
      const validatesInput =
        converted['body'] !== undefined ||
        converted['querystring'] !== undefined ||
        converted['params'] !== undefined;

      converted['response'] = {
        ...errorResponsesFor(operation, documentedUrl, validatesInput, multipartBody !== undefined),
        ...declared,
      };

      return {
        schema: {
          ...converted,
          tags: tagFor(documentedUrl),
          // An empty array overrides the document-level requirement, which is how
          // OpenAPI spells "this one needs no credentials".
          ...(UNAUTHENTICATED_ROUTES.has(operation) ? { security: [] } : {}),
        },
        url: documentedUrl,
      };
    },
  });

  await app.register(swaggerUi, {
    routePrefix: DOCS_ROUTE_PREFIX,
    uiConfig: {
      // Operations collapsed, groups visible — the API has enough endpoints that a
      // fully expanded page is harder to read than a list.
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    // Nothing here should be able to rewrite the served document.
    staticCSP: true,
  });
}

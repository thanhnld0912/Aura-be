import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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

/** Groups the operations in the UI. Order here is the order shown. */
const TAGS = [
  { name: 'Health', description: 'Liveness and dependency checks. No authentication.' },
  { name: 'Auth', description: 'Supabase session exchange and the current identity.' },
  { name: 'Users', description: 'Profile and preferences for the authenticated user.' },
  { name: 'Daily plans', description: 'Intentions, and how they compare with what happened.' },
  { name: 'Events', description: 'The timeline of what actually happened.' },
  { name: 'Check-ins', description: 'Mood and note, one per local day.' },
  { name: 'Meals', description: 'Meal logging, parsing and confirmation.' },
  { name: 'Nutrition', description: 'Food search, deterministic calculation and totals.' },
];

/** Maps a URL prefix to the tag its operations belong to. */
const TAG_BY_PREFIX: ReadonlyArray<[string, string]> = [
  ['/api/health', 'Health'],
  ['/api/auth', 'Auth'],
  ['/api/users', 'Users'],
  ['/api/daily-plan', 'Daily plans'],
  ['/api/events', 'Events'],
  ['/api/checkins', 'Check-ins'],
  ['/api/meals', 'Meals'],
  ['/api/nutrition', 'Nutrition'],
];

function tagFor(url: string): string[] {
  const matched = TAG_BY_PREFIX.find(([prefix]) => url.startsWith(prefix));
  return matched ? [matched[1]] : [];
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return value instanceof z.ZodType;
}

/**
 * Zod → JSON Schema.
 *
 * `effectStrategy: 'input'` is the important option: several request schemas end in a
 * `.transform()` (an ISO string becoming a `Date`, for instance), and the documentation
 * has to describe what a *client sends*, not what the handler receives.
 *
 * `$refStrategy: 'none'` inlines everything. Shared sub-schemas would otherwise emit
 * `$ref: "#/definitions/..."`, which is not where an OpenAPI document keeps them, and
 * the resulting references would dangle in the UI.
 */
function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const converted = zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
    effectStrategy: 'input',
  }) as Record<string, unknown>;

  // zod-to-json-schema emits a `$schema` key that OpenAPI has no use for.
  delete converted['$schema'];
  return converted;
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

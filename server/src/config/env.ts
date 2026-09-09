import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Configuration is parsed once, at boot, through a Zod schema (DEPLOYMENT.md §3).
 * A missing or malformed variable crashes the process at startup with a readable
 * message rather than producing an `undefined` API key that fails opaquely on the
 * first user request an hour later.
 *
 * Variables are required from the phase that actually consumes them, so the server
 * boots without keys it does not yet use. Promotion schedule:
 *
 *   Phase 2  SUPABASE_URL — done, now required
 *   Phase 3  USDA_API_KEY, OPEN_FOOD_FACTS_USER_AGENT
 *   Phase 4  ANTHROPIC_API_KEY, GEMINI_API_KEY, SUPABASE_STORAGE_BUCKET
 */

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .min(1)
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(z.string().url()).min(1));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // ── Database ────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  // ── Supabase ────────────────────────────────────────────────────────────
  // Required from Phase 2: it is the expected JWT issuer, the JWKS origin, and the
  // host the logout call goes to. Without it there is no authentication at all.
  SUPABASE_URL: z.string().url(),
  // Phase 4 (Storage). Bypasses RLS — server only, never in a client bundle.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  /**
   * Projects on legacy HS256 keys set this; projects on asymmetric keys do not, and
   * are verified against the JWKS published under SUPABASE_URL instead.
   *
   * Rejecting a UUID here is not fussiness. Supabase's newer dashboard shows each
   * signing key by a UUID *key id*, and that id is published to the world at
   * `/auth/v1/.well-known/jwks.json`. Setting it as the shared secret makes the
   * verifier accept HS256 tokens signed with a public value — anyone could then forge
   * a token for any `sub`. The failure is silent, because asymmetric tokens keep
   * verifying against the JWKS exactly as before. So it fails the boot instead.
   */
  SUPABASE_JWT_SECRET: z
    .string()
    .min(1)
    .refine((value) => !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.trim()), {
      message:
        'looks like a JWT signing key ID (a UUID), not a signing secret. That ID is ' +
        'published in your project JWKS, so using it as a shared secret would let ' +
        'anyone forge tokens. Use the legacy HS256 secret, or leave this unset and ' +
        'let SUPABASE_URL supply the JWKS.',
    })
    .optional(),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('meal-photos'),

  // ── AI (Phase 4) — server only, never exposed to a client ───────────────
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  AI_MODEL_REASONING: z.string().min(1).default('claude-opus-5'),
  AI_MODEL_EXTRACTION: z.string().min(1).default('claude-haiku-4-5'),
  AI_MODEL_VISION: z.string().min(1).default('gemini-2.5-flash'),

  // ── Nutrition (Phase 3) ─────────────────────────────────────────────────
  USDA_API_KEY: z.string().min(1).optional(),
  USDA_BASE_URL: z.string().url().default('https://api.nal.usda.gov/fdc/v1'),
  OPEN_FOOD_FACTS_BASE_URL: z.string().url().default('https://world.openfoodfacts.org'),
  // Not optional in Phase 3 — Open Food Facts blocks anonymous clients.
  OPEN_FOOD_FACTS_USER_AGENT: z.string().min(1).optional(),

  // ── Security ────────────────────────────────────────────────────────────
  // Explicit allowlist, never `*` and never reflected from Origin (SECURITY.md §6).
  CORS_ORIGIN: csv,
  RATE_LIMIT_ENABLED: booleanish.default('true'),
  /**
   * Serves Swagger UI at /docs and the OpenAPI document at /docs/json.
   *
   * On by default so the API is explorable out of the box. Worth turning off in a
   * public production deployment: the document is a complete map of the surface, which
   * is convenient for a developer and equally convenient for anyone else.
   */
  DOCS_ENABLED: booleanish.default('true'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).default(8_388_608),

  // ── Scheduled jobs (Phase 5) ────────────────────────────────────────────
  CRON_ENABLED: booleanish.default('false'),
  CRON_TIMEZONE: z.string().min(1).default('Asia/Ho_Chi_Minh'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    const lines = issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    super(`Invalid environment configuration:\n${lines.join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/** Pure — takes a source object so tests never touch `process.env`. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError(result.error.issues);
  return result.data;
}

let cached: Env | undefined;

/** Loads `server/.env` (if present) and parses `process.env`. Cached per process. */
export function getEnv(): Env {
  if (cached) return cached;
  // `quiet` keeps dotenv's banner out of structured log output.
  loadDotenv({ quiet: true });
  cached = parseEnv(process.env);
  return cached;
}

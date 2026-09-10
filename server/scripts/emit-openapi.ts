import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTestApp, testEnv } from '../tests/helpers/app.js';

/**
 * Writes the OpenAPI document the running server would serve.
 *
 * The contract is owned here — it is generated from the same Zod objects that
 * validate every request — and AURA-FE vendors a copy of it. This script is the one
 * place that copy comes from, so that `check:contract` and a developer refreshing the
 * frontend are looking at the same bytes.
 *
 *   npm run openapi:emit [outputPath]
 *
 * ## Why it builds the app rather than describing it
 *
 * `app.swagger()` is the document, assembled by `middleware/openapi.ts` from the
 * routes as they register. Re-deriving it here would be a second implementation of
 * the contract and would drift from the first — which is the failure this whole
 * exercise exists to remove. So the script builds the real application and asks it.
 *
 * ## What it does not need
 *
 * No port: the document comes from `app.ready()`, not from a request, so nothing
 * listens. No database: `buildApp` takes its `Database` as an argument and the stub
 * below satisfies it without a socket — building the app never queries. No secrets:
 * `testEnv()` supplies syntactically valid placeholders, and none of them is used,
 * because no token is verified and no provider is called. That is what makes this
 * runnable in CI with nothing provisioned.
 */

/** Reusing the test bootstrap, with docs forced on so a test default cannot mute it. */
const app = await buildTestApp({ env: testEnv({ DOCS_ENABLED: 'true' }) });
await app.ready();

const document = app.swagger() as {
  openapi?: string;
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
};

await app.close();

/**
 * A document that built but described nothing would still write a valid JSON file,
 * and `check:contract` would then happily compare two empty contracts. The coupling
 * to the test bootstrap is worth this guard: if someone turns docs off in `testEnv`,
 * this fails loudly here instead of silently emptying the frontend's types.
 */
const operations = Object.values(document.paths ?? {}).reduce<number>(
  (total, methods) => total + Object.keys(methods as Record<string, unknown>).length,
  0,
);

if (document.openapi === undefined || operations === 0) {
  console.error('The application produced no OpenAPI operations.');
  console.error('Is DOCS_ENABLED on, and is registerOpenApi still registered before the routes?');
  process.exit(1);
}

const outputPath =
  process.argv[2] ?? fileURLToPath(new URL('../openapi.generated.json', import.meta.url));

// Two spaces and a trailing newline: the same serialisation AURA-FE vendors, so the
// two files can be compared byte for byte rather than re-parsed and deep-equalled.
writeFileSync(outputPath, JSON.stringify(document, null, 2) + '\n');

console.log(`openapi → ${outputPath} (${operations} operations)`);

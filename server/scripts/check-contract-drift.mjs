import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Fails if the backend's OpenAPI document is not what AURA-FE has vendored.
 *
 * This is the half of the contract loop that AURA-FE cannot check on its own. Its
 * `check:api` proves `src/generated/api.ts` matches `openapi.json`; nothing there can
 * prove `openapi.json` still matches the backend, because the backend is a different
 * repository. A Zod schema edited here and never synced there is exactly the silent
 * runtime shape mismatch `ARCHITECTURE.md` §10 warns about, and it is invisible to
 * both repositories' own checks.
 *
 * Run after `openapi:emit`, which is what `npm run check:contract` chains.
 *
 *   AURA_FE_OPENAPI=/path/to/openapi.json node scripts/check-contract-drift.mjs
 *   node scripts/check-contract-drift.mjs /path/to/openapi.json
 *
 * With neither, it looks for AURA-FE beside AURA-BE, which is how the two are
 * checked out locally.
 */

const generatedPath = fileURLToPath(new URL('../openapi.generated.json', import.meta.url));
const snapshotPath =
  process.argv[2] ??
  process.env.AURA_FE_OPENAPI ??
  fileURLToPath(new URL('../../../AURA-FE/openapi.json', import.meta.url));

const read = (path, what) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    console.error(`Could not read the ${what} at:\n  ${path}`);
    if (what === 'backend document') {
      console.error('\nRun `npm run openapi:emit` first, or use `npm run check:contract`.');
    } else {
      console.error(
        '\nPoint AURA_FE_OPENAPI at the frontend snapshot, or check AURA-FE out\n' +
          'beside AURA-BE. Not finding it is a failure rather than a pass: a check\n' +
          'that quietly skips is worse than no check, because it reports green.',
      );
    }
    process.exit(1);
  }
};

const generated = read(generatedPath, 'backend document');
const vendored = read(snapshotPath, 'frontend snapshot');

if (generated === vendored) {
  console.log(`Contract in sync: AURA-FE/openapi.json matches this backend.\n  ${snapshotPath}`);
  process.exit(0);
}

// Byte comparison, but a byte count is not a useful failure. Say what moved.
const summarise = (json) => {
  try {
    const document = JSON.parse(json);
    const operations = new Set();
    for (const [url, methods] of Object.entries(document.paths ?? {})) {
      for (const method of Object.keys(methods)) operations.add(`${method.toUpperCase()} ${url}`);
    }
    return { operations, schemas: new Set(Object.keys(document.components?.schemas ?? {})) };
  } catch {
    return { operations: new Set(), schemas: new Set() };
  }
};

const now = summarise(generated);
const then = summarise(vendored);
const missing = (a, b) => [...a].filter((item) => !b.has(item));

console.error('The backend contract and the frontend snapshot differ.\n');

const added = missing(now.operations, then.operations);
const removed = missing(then.operations, now.operations);
const schemasAdded = missing(now.schemas, then.schemas);
const schemasRemoved = missing(then.schemas, now.schemas);

if (added.length > 0) console.error(`  Operations only in the backend:\n${added.map((o) => `    + ${o}`).join('\n')}`);
if (removed.length > 0) console.error(`  Operations only in the snapshot:\n${removed.map((o) => `    - ${o}`).join('\n')}`);
if (schemasAdded.length > 0) console.error(`  Schemas only in the backend:    ${schemasAdded.join(', ')}`);
if (schemasRemoved.length > 0) console.error(`  Schemas only in the snapshot:  ${schemasRemoved.join(', ')}`);
if (added.length + removed.length + schemasAdded.length + schemasRemoved.length === 0) {
  console.error('  Same operations and schemas, so the change is inside one of them.');
}

console.error(
  '\nRefresh the frontend contract:\n' +
    '\n  # in AURA-BE/server\n' +
    '  npm run openapi:emit\n' +
    '  cp openapi.generated.json ../../AURA-FE/openapi.json\n' +
    '\n  # in AURA-FE\n' +
    '  npm run generate:api\n' +
    '  npm run check:api && npm run typecheck && npm test && npm run build\n' +
    '\nNothing is rewritten for you: the snapshot is the frontend\'s to commit.',
);

process.exit(1);

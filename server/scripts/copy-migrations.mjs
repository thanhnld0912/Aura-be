import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// tsc emits .js only, so the committed .sql migrations and their journal have to be
// carried into dist/ for `node dist/database/migrate.js` to find them in production.
const from = fileURLToPath(new URL('../src/database/migrations', import.meta.url));
const to = fileURLToPath(new URL('../dist/database/migrations', import.meta.url));

if (!existsSync(from)) {
  console.error(`No migrations directory at ${from}`);
  process.exit(1);
}

cpSync(from, to, { recursive: true });
console.log(`Copied migrations → ${to}`);

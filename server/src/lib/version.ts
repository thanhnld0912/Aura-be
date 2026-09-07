import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The API's own version, read once from package.json. Reported by `GET /api/health`
 * so a deployed instance can be identified without shelling into the container.
 *
 * `src/lib/version.ts` and `dist/lib/version.js` sit at the same depth, so this URL
 * resolves to `server/package.json` in both.
 */
const packageJson = z
  .object({ version: z.string().min(1) })
  .parse(JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')));

export const API_VERSION: string = packageJson.version;

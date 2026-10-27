import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Vercel's Fastify preset picks the entrypoint itself: the first existing candidate, in this
 * order, whose source imports `fastify` (vercel/vercel `packages/fastify/src/build.ts` and
 * `packages/build-utils/src/generate-node-builder-functions.ts`). The project's Root Directory
 * is `server/`, and no Output Directory is set — one would be searched first.
 *
 * This replays that rule over the real files, so adding e.g. `server/app.ts` or `server/index.ts`
 * that imports `fastify` — which would silently take over production — fails here instead.
 */
const FILENAMES = ['app', 'index', 'server', 'src/app', 'src/index', 'src/server'];
const EXTENSIONS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'];
const IMPORTS_FASTIFY = /(?:from|require|import)\s*(?:\(\s*)?["']fastify["']\s*(?:\))?/;

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = (file: string): string => readFileSync(root + file, 'utf8');

function vercelEntrypoint(): string | undefined {
  const candidates = FILENAMES.flatMap((name) => EXTENSIONS.map((extension) => `${name}.${extension}`));
  return candidates.filter((file) => existsSync(root + file)).find((file) => IMPORTS_FASTIFY.test(source(file)));
}

describe('Vercel entrypoint', () => {
  it('is server.ts', () => {
    expect(vercelEntrypoint()).toBe('server.ts');
  });

  it('starts the same process as npm start', () => {
    expect(source('server.ts')).toMatch(/^import '\.\/src\/index\.js';$/m);
    const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['start']).toBe('node dist/index.js');
  });

  it('would otherwise be src/app.ts, which never listens', () => {
    // The reason server.ts exists: without it the preset falls through to the app builder.
    expect(IMPORTS_FASTIFY.test(source('src/app.ts'))).toBe(true);
    expect(source('src/app.ts')).not.toMatch(/\.listen\(/);
    expect(IMPORTS_FASTIFY.test(source('src/index.ts'))).toBe(false);
  });
});

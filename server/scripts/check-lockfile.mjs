import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Lockfile integrity guard.
 *
 * npm's resolver can write a package into package-lock.json without the flags that
 * make it skippable — an entry that is `extraneous` (reachable from no dependency
 * edge) or that is gated by `os`/`cpu` yet not marked `optional`. `npm ci` then
 * treats a platform-specific binary as mandatory and fails with EBADPLATFORM on
 * every machine except the one the binary targets.
 *
 * That is exactly how the Phase 1 pipeline broke: an unreferenced esbuild@0.28.2
 * tree under vitest, pulled in to satisfy vite 8's *optional* esbuild peer, whose
 * 26 @esbuild/* platform packages lost their `optional: true`. CI died on
 * @esbuild/aix-ppc64 before running a single check.
 *
 * The lockfile is authored on Windows and consumed on Linux, so this runs in CI
 * before `npm ci` — a clear message beats a confusing EBADPLATFORM.
 */
const lockfilePath = fileURLToPath(new URL('../package-lock.json', import.meta.url));
const { packages } = JSON.parse(readFileSync(lockfilePath, 'utf8'));

const extraneous = [];
const unflaggedPlatformDeps = [];

for (const [path, entry] of Object.entries(packages)) {
  if (path === '') continue;
  if (entry.extraneous) extraneous.push(path);
  if ((entry.os || entry.cpu) && entry.optional !== true) unflaggedPlatformDeps.push(path);
}

const problems = [];

if (extraneous.length > 0) {
  problems.push(
    `${extraneous.length} extraneous entr${extraneous.length === 1 ? 'y' : 'ies'} ` +
      '(present in the lockfile but reachable from no dependency edge):\n' +
      extraneous.map((p) => `    ${p}`).join('\n'),
  );
}

if (unflaggedPlatformDeps.length > 0) {
  problems.push(
    `${unflaggedPlatformDeps.length} platform-gated entr${
      unflaggedPlatformDeps.length === 1 ? 'y is' : 'ies are'
    } not marked "optional": true — ` +
      'npm ci will fail with EBADPLATFORM wherever they do not apply:\n' +
      unflaggedPlatformDeps.map((p) => `    ${p}`).join('\n'),
  );
}

if (problems.length > 0) {
  console.error('package-lock.json is not safe to install cross-platform.\n');
  for (const problem of problems) console.error(`  ✗ ${problem}\n`);
  console.error(
    'Fix by regenerating the lockfile (rm -rf node_modules package-lock.json && npm install)\n' +
      'and, if the entries come back, deduplicating the offending package with an\n' +
      '"overrides" entry in package.json — see docs/DEPLOYMENT.md §5.',
  );
  process.exit(1);
}

console.log(
  `package-lock.json is clean: ${Object.keys(packages).length - 1} packages, ` +
    'no extraneous entries, every platform-gated dependency optional.',
);

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DailyTrigger } from '../../src/jobs/daily-trigger.js';
import { NightlyPatternDetection } from '../../src/jobs/nightly-pattern-detection.js';
import { buildTestApp, testEnv } from '../helpers/app.js';

/**
 * The consumer flag and the scheduler flag are independent — as wiring, not as a convention.
 *
 * Two kinds of evidence, neither of which starts a scheduler:
 *
 * - **Structure.** The API cannot start a job it never imports. These tests read the source
 *   tree and assert that nothing outside `src/jobs/` imports from it, that only the scheduler
 *   entrypoint reads `CRON_ENABLED`, and that no job reads `PATTERN_ENGINE_ENABLED`.
 * - **Behaviour.** Building the API under every combination of the two flags starts no
 *   trigger and runs no detection.
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** `jobs/scheduler.ts`-style paths, whatever the platform's separator. */
const name = (path: string) => relative(SRC, path).split(sep).join('/');

/** Source with comments removed, so a flag named in documentation is not counted as a read. */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const files = sourceFiles(SRC);
const filesMentioning = (token: string) => files.filter((path) => code(path).includes(token)).map(name).sort();

describe('activation wiring — structure', () => {
  it('sees the whole source tree', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map(name)).toEqual(expect.arrayContaining(['index.ts', 'routes/index.ts', 'jobs/scheduler.ts']));
  });

  it('lets nothing outside src/jobs import a job', () => {
    const importers = files
      .filter((path) => !name(path).startsWith('jobs/'))
      .filter((path) => /from\s+['"][^'"]*\/jobs\/[^'"]*['"]|import\(\s*['"][^'"]*\/jobs\//.test(code(path)))
      .map(name);
    expect(importers).toEqual([]);
  });

  it('reads CRON_ENABLED in the scheduler entrypoint only', () => {
    expect(filesMentioning('CRON_ENABLED')).toEqual(['config/env.ts', 'jobs/scheduler.ts']);
  });

  it('reads PATTERN_ENGINE_ENABLED in the consumer factory only — never in a job', () => {
    expect(filesMentioning('PATTERN_ENGINE_ENABLED')).toEqual([
      'config/env.ts',
      'modules/patterns/patterns-evidence-source.ts',
      'routes/index.ts',
    ]);
  });

  it('starts a trigger from the scheduler entrypoint only', () => {
    expect(filesMentioning('trigger.start()')).toEqual(['jobs/scheduler.ts']);
    expect(filesMentioning('new DailyTrigger(')).toEqual(['jobs/pattern-scheduler.ts']);
  });
});

describe('activation wiring — behaviour', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { PATTERN_ENGINE_ENABLED: 'false', CRON_ENABLED: 'false' },
    { PATTERN_ENGINE_ENABLED: 'true', CRON_ENABLED: 'false' },
    { PATTERN_ENGINE_ENABLED: 'false', CRON_ENABLED: 'true' },
    { PATTERN_ENGINE_ENABLED: 'true', CRON_ENABLED: 'true' },
  ])('building the API with %j starts no trigger and runs no detection', async (flags) => {
    const start = vi.spyOn(DailyTrigger.prototype, 'start');
    const tick = vi.spyOn(DailyTrigger.prototype, 'tick');
    const run = vi.spyOn(NightlyPatternDetection.prototype, 'run');

    const app = await buildTestApp({ env: testEnv(flags) });
    await app.ready();
    await app.close();

    expect(start).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

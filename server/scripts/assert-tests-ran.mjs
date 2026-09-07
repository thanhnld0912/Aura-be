import { readFileSync } from 'node:fs';

/**
 * Asserts that a Vitest run actually executed its tests rather than skipping them.
 *
 * `tests/integration/database.test.ts` is gated on `TEST_DATABASE_URL` so the suite
 * stays runnable without Docker. That gate is also a trap: a skipped test reports as
 * a passing run, so CI could stay green while never once exercising a real
 * PostgreSQL. This turns "skipped in CI" into a failure.
 *
 * Usage: node scripts/assert-tests-ran.mjs <vitest-json-report> [minimum]
 */
const [reportPath, minimumRaw] = process.argv.slice(2);
if (!reportPath) {
  console.error('Usage: node scripts/assert-tests-ran.mjs <vitest-json-report> [minimum]');
  process.exit(2);
}

const minimum = minimumRaw ? Number(minimumRaw) : 1;
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const results = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
const skipped = results.filter((test) => test.status !== 'passed');

if (report.numTotalTests < minimum) {
  console.error(
    `Expected at least ${minimum} test(s), but the run reported ${report.numTotalTests}. ` +
      'Did the file move, or did a filter stop matching?',
  );
  process.exit(1);
}

if (skipped.length > 0) {
  console.error(
    `${skipped.length} of ${report.numTotalTests} tests did not run:\n` +
      skipped.map((t) => `    ${t.status.padEnd(8)} ${t.fullName}`).join('\n') +
      '\n\nIn CI these must execute. Check that TEST_DATABASE_URL is set on the job ' +
      'and that the PostgreSQL service is reachable.',
  );
  process.exit(1);
}

console.log(`${report.numPassedTests} test(s) ran against a real database — none skipped.`);

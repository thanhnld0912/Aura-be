import { config as loadDotenv } from 'dotenv';
import { AiService } from '../src/ai/ai.service.js';
import type { AiRunRecorder, AiRunRow, RecordAiRunInput } from '../src/ai/ai-runs.repository.js';
import { estimateCost } from '../src/ai/pricing.js';
import { ClaudeProvider } from '../src/ai/providers/claude-provider.js';
import { envSchema } from '../src/config/env.js';
import { selectPatternEvidence } from '../src/insights/pattern-evidence.js';
import { buildWeeklyReport, EMPTY_WEEK } from '../src/insights/weekly-report.js';
import { ClaudeWeeklyStoryGenerator } from '../src/insights/weekly-story-generator.js';
import { buildWeeklyEvidence } from '../src/insights/weekly-story.js';
import { isAppError } from '../src/lib/errors.js';
import { addLocalDays } from '../src/lib/local-date.js';

/**
 * One real weekly-story call, run by hand — never by the test suite or CI.
 *
 *   npm run smoke:weekly            # Vietnamese
 *   npm run smoke:weekly -- en      # English
 *
 * What it proves: a synthetic week, aggregated by the real `buildWeeklyReport`, reaches the
 * live Anthropic API through `ClaudeWeeklyStoryGenerator → AiService → ClaudeProvider`
 * with the real structured-output schema, and comes back as a story that passed every
 * grounding, causal and safety check — or is reported as the failure it was.
 *
 * What it does not prove: the HTTP layer, authentication and the database, which
 * `tests/integration/insights-weekly.test.ts` covers over a scripted provider.
 *
 * The week is invented; no person's data is sent. Prints the story and the ledger
 * entries — never the key, and never a provider's error text.
 */

loadDotenv({ quiet: true });

const env = envSchema.pick({ ANTHROPIC_API_KEY: true, AI_MODEL_REASONING: true }).parse(process.env);

if (!env.ANTHROPIC_API_KEY) {
  console.log('NOT RUN — ANTHROPIC_API_KEY is not set.');
  process.exit(0);
}

const locale = process.argv[2] === 'en' ? 'en' : 'vi';
const WEEK = '2026-09-07';
const day = (offset: number): string => addLocalDays(WEEK, offset);
const previousDay = (offset: number): string => addLocalDays(WEEK, offset - 7);

const report = buildWeeklyReport({
  weekStart: WEEK,
  today: '2026-09-14',
  timezone: 'Asia/Ho_Chi_Minh',
  current: {
    ...EMPTY_WEEK,
    events: [0, 1, 2, 3, 5].map((offset) => ({
      localDate: day(offset),
      total: 4,
      walks: offset % 2 === 0 ? 1 : 0,
      sleepMinutes: offset < 3 ? 430 : null,
    })),
    meals: [0, 1, 2, 3].map((offset) => ({ localDate: day(offset), mealsLogged: 2, unresolvedItems: 0 })),
    distinctFoods: 7,
    planItems: [
      { localDate: day(0), eventType: 'walk', adherence: 'on_time', count: 1 },
      { localDate: day(1), eventType: 'workout', adherence: 'substituted', count: 1 },
      { localDate: day(2), eventType: 'meal', adherence: 'shifted', count: 2 },
      { localDate: day(3), eventType: 'workout', adherence: 'not_logged', count: 1 },
    ],
    checkins: [
      { localDate: day(0), mood: 'good', dayTag: 'busy', energy: 4 },
      { localDate: day(2), mood: 'okay', dayTag: 'normal', energy: 3 },
      { localDate: day(5), mood: 'great', dayTag: 'better_than_expected', energy: 5 },
    ],
  },
  previous: {
    ...EMPTY_WEEK,
    events: [0, 2, 4].map((offset) => ({ localDate: previousDay(offset), total: 2, walks: 0, sleepMinutes: null })),
    meals: [0].map((offset) => ({ localDate: previousDay(offset), mealsLogged: 1, unresolvedItems: 0 })),
  },
  patterns: selectPatternEvidence([
    {
      id: 'smoke-walk-mood',
      kind: 'correlation',
      subjectMetric: 'walks',
      subjectLabel: 'Walks',
      objectMetric: 'mood_score',
      objectLabel: 'Check-in mood',
      direction: 'positive',
      strength: 0.52,
      pValue: 0.07,
      sampleSize: 12,
      windowDays: 30,
      coverage: 0.8,
      status: 'active',
      score: 0.6,
      caveat: 'This is an association in your own logs, not a cause.',
    },
  ]),
});

const rows: RecordAiRunInput[] = [];
const runs: AiRunRecorder = {
  async record(input) {
    rows.push(input);
    return { id: `smoke-${rows.length}` } as AiRunRow;
  },
};

const generator = new ClaudeWeeklyStoryGenerator({
  ai: new AiService({
    providers: [new ClaudeProvider({ apiKey: env.ANTHROPIC_API_KEY })],
    runs,
    estimateCost,
  }),
  model: env.AI_MODEL_REASONING,
});

try {
  const evidence = buildWeeklyEvidence(report, { locale, goalFocus: 'consistency' });
  console.log(`evidence: ${evidence.items.length} statements (${locale})`);

  const story = await generator.generate(evidence, { userId: '00000000-0000-4000-8000-00000000510e' });

  console.log('result  : PASS — a validated WeeklyStory');
  console.log(JSON.stringify(story, null, 2));
} catch (error) {
  console.log(
    `result  : FAIL — ${isAppError(error) ? `${error.statusCode} ${error.code}` : 'unexpected error'}`,
  );
  process.exitCode = 1;
} finally {
  for (const row of rows) {
    const paths = row.requestMeta?.schemaErrorPaths;
    console.log(
      `ai_runs : attempt ${row.attempt} · ${row.status} · ${row.model} · ` +
        `in ${row.inputTokens ?? '—'} / out ${row.outputTokens ?? '—'} tokens · ` +
        `cost ${row.costUsd ?? '—'} · error ${row.error ?? '—'}` +
        (paths ? ` · paths ${paths.join(', ')}` : ''),
    );
  }
}

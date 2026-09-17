import { config as loadDotenv } from 'dotenv';
import { AiService } from '../src/ai/ai.service.js';
import type { AiRunRecorder, AiRunRow, RecordAiRunInput } from '../src/ai/ai-runs.repository.js';
import { estimateCost } from '../src/ai/pricing.js';
import { ClaudeProvider } from '../src/ai/providers/claude-provider.js';
import { EvidenceCollector } from '../src/ai/safety/index.js';
import { ClaudeAgentReplyGenerator } from '../src/agent/agent-generator.js';
import { classifyIntent } from '../src/agent/intent.js';
import { envSchema } from '../src/config/env.js';
import { isAppError } from '../src/lib/errors.js';

/**
 * One real agent reply, run by hand — never by the test suite or CI.
 *
 *   npm run smoke:agent
 *
 * What it proves: a synthetic day's evidence and a safe question reach the live Anthropic
 * API through `ClaudeAgentReplyGenerator → AiService → ClaudeProvider` with the real
 * structured-output schema, and come back as a reply that passed every grounding, causal,
 * framing and safety check — with a ledger entry, and evidence refs that resolve.
 *
 * What it does not prove: authentication, the database and context building, which
 * `tests/integration/agent-chat.test.ts` covers over a scripted provider. The evidence
 * here is invented; no person's data is sent. Prints the reply and the ledger entries —
 * never the key, the prompt, or a provider's error text.
 */

loadDotenv({ quiet: true });

const env = envSchema.pick({ ANTHROPIC_API_KEY: true, AI_MODEL_REASONING: true }).parse(process.env);

if (!env.ANTHROPIC_API_KEY) {
  console.log('NOT RUN — ANTHROPIC_API_KEY is not set.');
  process.exit(0);
}

const message = 'Hôm nay tôi đã ăn gì?';
const classification = classifyIntent(message);

const evidence = new EvidenceCollector();
evidence.add({ kind: 'fact', source: 'metric:meals.confirmed_count', statement: '2 confirmed meals logged today' });
evidence.add({ kind: 'fact', source: 'meal:confirmed', statement: 'Confirmed breakfast: bánh mì trứng (estimated 350 kcal)' });
evidence.add({ kind: 'fact', source: 'meal:confirmed', statement: 'Confirmed lunch: cơm trắng, cá kho (estimated 520 kcal)' });
evidence.add({
  kind: 'fact',
  source: 'meal:draft',
  statement: 'Unconfirmed draft dinner, not counted as eaten or in any total: phở bò (draft estimate, not confirmed: 450 kcal)',
});
evidence.add({ kind: 'limitation', source: 'limitation:nutrition_estimate', statement: 'Nutrition figures are estimates from typical portions, not measurements.' });

const rows: RecordAiRunInput[] = [];
const runs: AiRunRecorder = {
  async record(input) {
    rows.push(input);
    return { id: `smoke-${rows.length}` } as AiRunRow;
  },
};

const generator = new ClaudeAgentReplyGenerator({
  ai: new AiService({ providers: [new ClaudeProvider({ apiKey: env.ANTHROPIC_API_KEY })], runs, estimateCost }),
  model: env.AI_MODEL_REASONING,
});

try {
  console.log(`intent  : ${classification.intent} · ${JSON.stringify(classification.scope)} · ${evidence.items.length} statements`);

  const reply = await generator.reply({
    userId: '00000000-0000-4000-8000-00000000510e',
    message,
    context: {
      language: 'vi',
      goalFocus: 'consistency',
      showsCalories: true,
      intent: classification.intent,
      period: { kind: 'day', label: 'today' },
      items: evidence.items,
    },
  });

  const sources = new Set(evidence.items.map((item) => item.source));
  const cited = [reply.answer, ...reply.sections, ...reply.suggestions, ...reply.caveats].flatMap((entry) => entry.evidence);
  const unresolved = cited.filter((source) => !sources.has(source));

  console.log(`result  : PASS — a validated reply citing ${cited.length} evidence ids, ${unresolved.length} unresolved`);
  console.log(JSON.stringify(reply, null, 2));
  if (unresolved.length > 0) process.exitCode = 1;
} catch (error) {
  console.log(`result  : FAIL — ${isAppError(error) ? `${error.statusCode} ${error.code}` : 'unexpected error'}`);
  process.exitCode = 1;
} finally {
  for (const row of rows) {
    const paths = row.requestMeta?.schemaErrorPaths;
    console.log(
      `ai_runs : attempt ${row.attempt} · ${row.purpose} · ${row.status} · ${row.model} · ` +
        `in ${row.inputTokens ?? '—'} / out ${row.outputTokens ?? '—'} tokens · ` +
        `cost ${row.costUsd ?? '—'} · error ${row.error ?? '—'} · meta ${JSON.stringify(row.requestMeta)}` +
        (paths ? ` · paths ${paths.join(', ')}` : ''),
    );
  }
}

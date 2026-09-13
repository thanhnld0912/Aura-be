import { readFile } from 'node:fs/promises';
import { config as loadDotenv } from 'dotenv';
import sharp from 'sharp';
import { AiService } from '../src/ai/ai.service.js';
import type { AiRunRecorder, AiRunRow, RecordAiRunInput } from '../src/ai/ai-runs.repository.js';
import { estimateCost } from '../src/ai/pricing.js';
import { GeminiProvider } from '../src/ai/providers/gemini-provider.js';
import { envSchema } from '../src/config/env.js';
import { isAppError } from '../src/lib/errors.js';
import { prepareImage } from '../src/lib/images.js';
import { GeminiVisionMealParser } from '../src/nutrition/parser/gemini-vision-meal-parser.js';

/**
 * One real Gemini call, run by hand — never by the test suite or CI.
 *
 *   npm run smoke:vision -- path/to/meal.jpg
 *
 * What it proves: a real image, re-encoded by `prepareImage`, travels
 * `GeminiVisionMealParser → AiService → GeminiProvider` to the live API, comes back as a
 * `ParsedMeal` that passed the Zod schema, and leaves a ledger entry with real usage and cost.
 *
 * What it does not prove: the HTTP layer, authentication and the database. Those need a
 * signed-in user and a running Postgres, and are exercised by
 * `tests/integration/meals-vision.test.ts` over a scripted provider.
 *
 * Prints the reading and the ledger entries. Never the key, the image bytes, or a provider's
 * error text — a failure is reported as its status and label only.
 */

loadDotenv({ quiet: true });

const env = envSchema
  .pick({ GEMINI_API_KEY: true, AI_MODEL_VISION: true, MAX_UPLOAD_BYTES: true })
  .parse(process.env);

if (!env.GEMINI_API_KEY) {
  console.log('NOT RUN — GEMINI_API_KEY is not set.');
  process.exit(0);
}

const path = process.argv[2];
const upload = path
  ? { bytes: await readFile(path), type: mediaTypeFor(path) }
  : { bytes: await syntheticPlate(), type: 'image/png' };

const rows: RecordAiRunInput[] = [];
const runs: AiRunRecorder = {
  async record(input) {
    rows.push(input);
    return { id: `smoke-${rows.length}` } as AiRunRow;
  },
};

const parser = new GeminiVisionMealParser({
  ai: new AiService({
    providers: [new GeminiProvider({ apiKey: env.GEMINI_API_KEY })],
    runs,
    estimateCost,
  }),
  model: env.AI_MODEL_VISION,
});

try {
  const image = await prepareImage(upload.bytes, upload.type, { maxBytes: env.MAX_UPLOAD_BYTES });
  console.log(
    `image   : ${path ?? 'synthetic empty plate (no food — few or no items expected)'} → ` +
      `${image.width}×${image.height} WebP, ${image.bytes} bytes`,
  );

  const meal = await parser.parse({ image }, { userId: '00000000-0000-4000-8000-00000000510e' });

  console.log('result  : PASS — a validated ParsedMeal');
  console.log(JSON.stringify(meal, null, 2));
} catch (error) {
  console.log(
    `result  : FAIL — ${isAppError(error) ? `${error.statusCode} ${error.code}` : 'unexpected error'}`,
  );
  process.exitCode = 1;
} finally {
  for (const row of rows) {
    console.log(
      `ai_runs : attempt ${row.attempt} · ${row.status} · ${row.model} · ` +
        `in ${row.inputTokens ?? '—'} / out ${row.outputTokens ?? '—'} tokens · ` +
        `cost ${row.costUsd ?? '—'} · error ${row.error ?? '—'}`,
    );
  }
}

function mediaTypeFor(file: string): string {
  const extension = file.toLowerCase().split('.').pop();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

/** An empty plate on a table. Enough to exercise the pipeline; not a meal. */
async function syntheticPlate(): Promise<Buffer> {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">' +
    '<rect width="640" height="480" fill="#8b5a2b"/>' +
    '<circle cx="320" cy="240" r="190" fill="#f1f1f1"/>' +
    '<circle cx="320" cy="240" r="130" fill="#fbfaf5"/>' +
    '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

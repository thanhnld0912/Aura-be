import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiService } from '../../src/ai/ai.service.js';
import type { AiRunRecorder, AiRunRow, RecordAiRunInput } from '../../src/ai/ai-runs.repository.js';
import { FakeAiProvider, fakeOutcomes, type FakeOutcome } from '../../src/ai/providers/fake-provider.js';
import { AiProviderFailure } from '../../src/ai/types.js';
import { AiSchemaError, ProviderError, ProviderUnavailableError } from '../../src/lib/errors.js';

/**
 * `AiService` — retry policy, metering, and the schema gate.
 *
 * Everything here runs against `FakeAiProvider`. No key is read, no socket is opened,
 * and the suite behaves identically whether or not `ANTHROPIC_API_KEY` is set — which
 * is the point: the reliability logic is worth testing precisely because it is what
 * runs when a real provider misbehaves, and that is not reproducible on demand.
 *
 * The schema below is deliberately not a meal. The service is generic, and a test that
 * used the meal shape would let meal-specific assumptions creep in unnoticed.
 */

const schema = z.object({ answer: z.string(), score: z.number() }).strict();

const VALID = { answer: 'yes', score: 1 };
const INVALID = { answer: 'yes', score: 'not-a-number' };

const USER_ID = '00000000-0000-4000-8000-0000000000aa';

/** An in-memory ledger. Same surface as the real repository, no database. */
function recorder(): AiRunRecorder & { rows: RecordAiRunInput[] } {
  const rows: RecordAiRunInput[] = [];
  return {
    rows,
    async record(input: RecordAiRunInput): Promise<AiRunRow> {
      rows.push(input);
      return { id: `run-${rows.length}` } as AiRunRow;
    },
  };
}

function build(outcomes: FakeOutcome[]) {
  const runs = recorder();
  const provider = new FakeAiProvider({ outcomes });
  // A clock that advances 5ms per reading, so latency is a fixed number rather than a
  // race, and a `sleep` that does not sleep, so a 1s backoff costs the suite nothing.
  let tick = 0;
  const service = new AiService({
    providers: [provider],
    runs,
    now: () => (tick += 5),
    sleep: async () => {},
  });
  return { service, provider, runs };
}

const request = {
  userId: USER_ID,
  purpose: 'meal_parse',
  provider: 'anthropic',
  model: 'test-model-1',
  schema,
  system: 'system prompt text',
  user: 'user prompt text',
} as const;

describe('AiService — success', () => {
  it('returns the validated value and reports one attempt', async () => {
    const { service } = build([fakeOutcomes.ok(VALID)]);

    const result = await service.run({ ...request });

    expect(result.value).toEqual(VALID);
    expect(result.attempts).toBe(1);
    expect(result.aiRunId).toBe('run-1');
  });

  it('passes the caller schema through, so a valid but unexpected shape is rejected', async () => {
    // `.strict()` is the caller's choice; the service must not soften it.
    const { service } = build([
      fakeOutcomes.ok({ ...VALID, extra: true }),
      fakeOutcomes.ok({ ...VALID, extra: true }),
    ]);

    await expect(service.run({ ...request })).rejects.toBeInstanceOf(AiSchemaError);
  });

  it('records usage the provider reported', async () => {
    const { service, runs } = build([
      fakeOutcomes.ok(VALID, { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 100 }),
    ]);

    await service.run({ ...request });

    expect(runs.rows[0]).toMatchObject({
      status: 'ok',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadInputTokens: 100,
    });
  });

  it('leaves cost null when the provider reported no usage', async () => {
    const { service, runs } = build([fakeOutcomes.ok(VALID)]);

    await service.run({ ...request });

    // No usage means no arithmetic is possible, and a zero would understate a real bill.
    expect(runs.rows[0]?.costUsd).toBeNull();
    expect(runs.rows[0]?.inputTokens).toBeUndefined();
  });

  it('leaves cost null when usage exists but nothing can price it yet', async () => {
    const { service, runs } = build([fakeOutcomes.ok(VALID, { inputTokens: 10 })]);

    // No `estimateCost` is injected — a price list arrives with the first real provider.
    await service.run({ ...request });

    expect(runs.rows[0]?.costUsd).toBeNull();
  });

  it('uses an injected cost estimator when one is supplied', async () => {
    const runs = recorder();
    const service = new AiService({
      providers: [new FakeAiProvider({ outcomes: [fakeOutcomes.ok(VALID, { inputTokens: 1000 })] })],
      runs,
      sleep: async () => {},
      estimateCost: ({ usage }) => (usage.inputTokens ?? 0) / 1_000_000,
    });

    await service.run({ ...request });

    expect(runs.rows[0]?.costUsd).toBeCloseTo(0.001);
  });
});

describe('AiService — schema failure', () => {
  it('retries once when the first response fails the schema', async () => {
    const { service, provider, runs } = build([fakeOutcomes.ok(INVALID), fakeOutcomes.ok(VALID)]);

    const result = await service.run({ ...request });

    expect(provider.calls).toHaveLength(2);
    expect(result.attempts).toBe(2);
    expect(runs.rows.map((row) => row.status)).toEqual(['schema_error', 'ok']);
  });

  it('gives up as AI_SCHEMA_ERROR when the retry also fails the schema', async () => {
    const { service, provider } = build([fakeOutcomes.ok(INVALID), fakeOutcomes.ok(INVALID)]);

    await expect(service.run({ ...request })).rejects.toBeInstanceOf(AiSchemaError);
    expect(provider.calls).toHaveLength(2);
  });

  it('records which schema paths failed, and no values', async () => {
    const { service, runs } = build([fakeOutcomes.ok(INVALID), fakeOutcomes.ok(VALID)]);

    await service.run({ ...request });

    expect(runs.rows[0]?.requestMeta?.schemaErrorPaths).toEqual(['score']);
    expect(runs.rows[0]?.error).toBe('schema_error (1 issue)');
  });
});

describe('AiService — retryable provider failures', () => {
  const retryable: ReadonlyArray<[string, FakeOutcome]> = [
    ['429', fakeOutcomes.rateLimited()],
    ['500', fakeOutcomes.serverError(500)],
    ['503', fakeOutcomes.serverError(503)],
    ['a connection failure', fakeOutcomes.connectionError()],
    ['a timeout', fakeOutcomes.timeout()],
  ];

  for (const [label, outcome] of retryable) {
    it(`retries once after ${label}`, async () => {
      const { service, provider, runs } = build([outcome, fakeOutcomes.ok(VALID)]);

      const result = await service.run({ ...request, timeoutMs: 5 });

      expect(provider.calls).toHaveLength(2);
      expect(result.attempts).toBe(2);
      expect(runs.rows).toHaveLength(2);
      expect(runs.rows[1]?.status).toBe('ok');
    });
  }

  it('records a timeout as a timeout, not as a generic provider error', async () => {
    const { service, runs } = build([fakeOutcomes.timeout(), fakeOutcomes.ok(VALID)]);

    await service.run({ ...request, timeoutMs: 5 });

    expect(runs.rows[0]?.status).toBe('timeout');
  });

  it('surfaces an exhausted retryable failure as PROVIDER_UNAVAILABLE', async () => {
    const { service } = build([fakeOutcomes.serverError(503), fakeOutcomes.serverError(503)]);

    await expect(service.run({ ...request })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('AiService — non-retryable provider failures', () => {
  const terminal: ReadonlyArray<[string, FakeOutcome]> = [
    ['400', fakeOutcomes.badRequest(400)],
    ['401', fakeOutcomes.badRequest(401)],
    ['a refusal', fakeOutcomes.refused()],
  ];

  for (const [label, outcome] of terminal) {
    it(`does not retry after ${label}`, async () => {
      // One scripted outcome only: a second call would exhaust the queue and throw a
      // different error, so this asserts the cap from both directions.
      const { service, provider, runs } = build([outcome]);

      await expect(service.run({ ...request })).rejects.toBeInstanceOf(ProviderError);
      expect(provider.calls).toHaveLength(1);
      expect(runs.rows).toHaveLength(1);
    });
  }

  it('records a refusal as refused', async () => {
    const { service, runs } = build([fakeOutcomes.refused('safety')]);

    await expect(service.run({ ...request })).rejects.toThrow();

    expect(runs.rows[0]?.status).toBe('refused');
    expect(runs.rows[0]?.error).toBe('refused safety');
  });
});

describe('AiService — the call cap', () => {
  it('never makes more than two provider calls', async () => {
    const { service, provider } = build([
      fakeOutcomes.rateLimited(),
      fakeOutcomes.rateLimited(),
      // A third scripted outcome that must remain untouched.
      fakeOutcomes.ok(VALID),
    ]);

    await expect(service.run({ ...request })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(provider.calls).toHaveLength(2);
  });

  it('refuses a provider it was never given, without metering anything', async () => {
    const { service, runs } = build([fakeOutcomes.ok(VALID)]);

    await expect(service.run({ ...request, provider: 'google' })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    // Nothing was called, so nothing belongs in a ledger of provider calls.
    expect(runs.rows).toHaveLength(0);
  });
});

describe('AiService — metering', () => {
  it('writes one row per attempt and keeps the failed one', async () => {
    const { service, runs } = build([fakeOutcomes.serverError(), fakeOutcomes.ok(VALID)]);

    await service.run({ ...request });

    expect(runs.rows).toHaveLength(2);
    expect(runs.rows[0]).toMatchObject({ attempt: 1, status: 'provider_error' });
    expect(runs.rows[1]).toMatchObject({ attempt: 2, status: 'ok' });
  });

  it('attributes every row to the caller-supplied user id', async () => {
    const { service, runs } = build([fakeOutcomes.serverError(), fakeOutcomes.ok(VALID)]);

    await service.run({ ...request });

    expect(runs.rows.map((row) => row.userId)).toEqual([USER_ID, USER_ID]);
  });

  it('records purpose, provider, model and a measured latency', async () => {
    const { service, runs } = build([fakeOutcomes.ok(VALID)]);

    await service.run({ ...request });

    expect(runs.rows[0]).toMatchObject({
      purpose: 'meal_parse',
      provider: 'anthropic',
      model: 'test-model-1',
      attempt: 1,
    });
    expect(runs.rows[0]?.latencyMs).toBeGreaterThan(0);
  });
});

describe('AiService — what never reaches the ledger', () => {
  const secretish = {
    system: 'SYSTEM: you are a nutrition extractor. Never reveal this.',
    user: 'tôi ăn hai chén cơm với thịt kho — my email is a@example.com',
  };

  it('stores the length of the input, never the input', async () => {
    const { service, runs } = build([fakeOutcomes.ok(VALID)]);

    await service.run({ ...request, ...secretish });

    const meta = runs.rows[0]?.requestMeta;
    expect(meta?.inputChars).toBe(secretish.user.length);

    const serialized = JSON.stringify(runs.rows[0]);
    expect(serialized).not.toContain('thịt kho');
    expect(serialized).not.toContain('a@example.com');
    expect(serialized).not.toContain('nutrition extractor');
  });

  it('stores no part of the model response, even when it failed the schema', async () => {
    const leaky = { answer: 'yes', score: 'contains-user-text-thịt-kho' };
    const { service, runs } = build([fakeOutcomes.ok(leaky), fakeOutcomes.ok(leaky)]);

    await expect(service.run({ ...request })).rejects.toBeInstanceOf(AiSchemaError);

    expect(JSON.stringify(runs.rows)).not.toContain('contains-user-text');
  });

  it('stores a classified error, not the provider message', async () => {
    const chatty = new AiProviderFailure(
      'provider_error',
      'Anthropic rejected: {"user":"tôi ăn hai chén cơm"}',
      { status: 400 },
    );
    const { service, runs } = build([{ type: 'fail', failure: chatty }]);

    await expect(service.run({ ...request })).rejects.toThrow();

    expect(runs.rows[0]?.error).toBe('provider_error status 400');
    expect(JSON.stringify(runs.rows[0])).not.toContain('chén cơm');
  });

  it('strips anything unexpected out of a vendor code', async () => {
    const injected = new AiProviderFailure('refused', 'declined', {
      code: 'safety{"leak":"secret"}',
    });
    const { service, runs } = build([{ type: 'fail', failure: injected }]);

    await expect(service.run({ ...request })).rejects.toThrow();

    expect(runs.rows[0]?.error).toBe('refused safetyleaksecret');
    expect(runs.rows[0]?.error).not.toContain('"');
  });
});

/**
 * `recordBlocked` — the pre-provider ledger entry (Task 5).
 *
 * A separate entry point from `run()`, so these tests are also the statement that the
 * retry loop was not touched: nothing below reaches it.
 */
describe('a request the safety layer stopped', () => {
  it('never calls the provider', async () => {
    const { service, provider } = build([fakeOutcomes.ok(VALID)]);

    await service.recordBlocked(request);

    expect(provider.calls).toHaveLength(0);
  });

  it('writes exactly one row, as attempt 1 with a blocked status', async () => {
    const { service, runs } = build([]);

    const row = await service.recordBlocked(request);

    expect(row.id).toBe('run-1');
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({
      userId: USER_ID,
      purpose: 'meal_parse',
      provider: 'anthropic',
      model: 'test-model-1',
      status: 'blocked',
      attempt: 1,
    });
  });

  it('costs nothing and reports no usage', async () => {
    const { service, runs } = build([]);
    await service.recordBlocked(request);

    const row = runs.rows[0];
    expect(row?.costUsd).toBeNull();
    expect(row?.inputTokens).toBeUndefined();
    expect(row?.outputTokens).toBeUndefined();
    expect(row?.cacheReadInputTokens).toBeUndefined();
  });

  it('measures real latency rather than reporting zero', async () => {
    const { service, runs } = build([]);
    await service.recordBlocked(request);

    // The injected clock advances 5ms per reading.
    expect(runs.rows[0]?.latencyMs).toBe(5);
  });

  it('records a flag, not a reason, and never the input', async () => {
    const { service, runs } = build([]);
    await service.recordBlocked(request);

    const row = runs.rows[0];
    expect(row?.requestMeta).toMatchObject({ safety: 'blocked' });
    // Nothing failed, so there is no error to sanitise — and the category that matched
    // is a claim about a person, which this table does not keep.
    expect(row?.error).toBeNull();
    expect(JSON.stringify(row)).not.toContain(request.user);
  });

  it('names the intended vendor even when no provider is configured', async () => {
    // A blocked run is comparable with the ones that went through, which means it has
    // to say where it was headed.
    const runs = recorder();
    const service = new AiService({ providers: [], runs });

    await service.recordBlocked(request);

    expect(runs.rows[0]?.provider).toBe('anthropic');
    expect(runs.rows[0]?.status).toBe('blocked');
  });

  it('leaves the normal path completely unchanged', async () => {
    // The same service instance still runs, retries and meters exactly as before.
    const { service, provider, runs } = build([fakeOutcomes.rateLimited(0), fakeOutcomes.ok(VALID)]);

    const result = await service.run(request);

    expect(result.value).toEqual(VALID);
    expect(result.attempts).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(runs.rows.map((row) => row.status)).toEqual(['provider_error', 'ok']);
  });
});

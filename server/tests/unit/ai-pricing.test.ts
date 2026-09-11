import { describe, expect, it } from 'vitest';
import { AiService } from '../../src/ai/ai.service.js';
import type { AiRunRecorder, AiRunRow, RecordAiRunInput } from '../../src/ai/ai-runs.repository.js';
import { estimateCost, priceFor } from '../../src/ai/pricing.js';
import { FakeAiProvider, fakeOutcomes } from '../../src/ai/providers/fake-provider.js';
import { z } from 'zod';

/**
 * Cost estimation (DATABASE_DESIGN.md §3.8).
 *
 * The property that matters more than arithmetic: **an unknown price is null, not a
 * guess**. A `cost_usd` column mixing measured figures with plausible inventions is
 * worse than one with visible gaps, because nobody audits a number that looks right.
 */

describe('priceFor', () => {
  it('prices the two models AURA is configured to call', () => {
    // Verified against platform.claude.com/docs/en/about-claude/pricing on 2026-09-10.
    expect(priceFor('claude-haiku-4-5')).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
    });
    expect(priceFor('claude-opus-5')).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
    });
  });

  it('prices a pinned snapshot as the model it snapshots', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual(priceFor('claude-haiku-4-5'));
  });

  it('returns null for a model it has never been told the price of', () => {
    // Including near-misses: a family resemblance is not a price.
    expect(priceFor('claude-sonnet-5')).toBeNull();
    expect(priceFor('claude-haiku-9')).toBeNull();
    expect(priceFor('gemini-2.5-flash')).toBeNull();
    expect(priceFor('')).toBeNull();
  });
});

describe('estimateCost', () => {
  it('bills input and output at the published rates', () => {
    // 1M input at $1 + 1M output at $5.
    expect(
      estimateCost({
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    ).toBe(6);
  });

  it('bills a realistic extraction call to six decimal places', () => {
    // 900 × $1/MTok + 120 × $5/MTok = 0.0009 + 0.0006.
    expect(
      estimateCost({
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 900, outputTokens: 120 },
      }),
    ).toBe(0.0015);
  });

  it('bills cache reads at the cache rate, not the input rate', () => {
    const cost = estimateCost({
      model: 'claude-opus-5',
      usage: { inputTokens: 1_000, outputTokens: 0, cacheReadInputTokens: 100_000 },
    });

    // 1_000 × $5/MTok + 100_000 × $0.50/MTok = 0.005 + 0.05.
    expect(cost).toBe(0.055);
    // Charging cache reads as fresh input would be 10× that term.
    expect(cost).not.toBe(0.505);
  });

  it('returns null for an unpriced model rather than approximating', () => {
    expect(
      estimateCost({
        model: 'claude-something-unreleased',
        usage: { inputTokens: 1_000, outputTokens: 1_000 },
      }),
    ).toBeNull();
  });

  it('returns null when the provider reported no usage at all', () => {
    // Distinct from a free call: we do not know what happened, so we do not claim $0.
    expect(estimateCost({ model: 'claude-haiku-4-5', usage: {} })).toBeNull();
  });

  it('prices a partial report rather than discarding it', () => {
    expect(
      estimateCost({ model: 'claude-haiku-4-5', usage: { inputTokens: 2_000 } }),
    ).toBe(0.002);
  });

  it('rounds to the ledger precision, so the stored value equals the computed one', () => {
    // numeric(10,6) — a figure below a micro-dollar rounds to zero rather than
    // silently truncating on insert.
    const cost = estimateCost({
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    expect(cost).toBe(0.000006);
    expect(Number(cost?.toFixed(6))).toBe(cost);
  });
});

describe('AiService with the estimator injected', () => {
  const schema = z.object({ ok: z.boolean() });

  function recorder(): AiRunRecorder & { rows: RecordAiRunInput[] } {
    const rows: RecordAiRunInput[] = [];
    return {
      rows,
      async record(input) {
        rows.push(input);
        return { id: 'run-1', ...input } as unknown as AiRunRow;
      },
    };
  }

  function run(model: string, usage: { inputTokens: number; outputTokens: number } | undefined) {
    const runs = recorder();
    const service = new AiService({
      providers: [
        new FakeAiProvider({ outcomes: [fakeOutcomes.ok({ ok: true }, usage)] }),
      ],
      runs,
      estimateCost,
    });

    return service
      .run({
        userId: '00000000-0000-4000-8000-000000000001',
        purpose: 'meal_parse',
        provider: 'anthropic',
        model,
        schema,
        system: 's',
        user: 'u',
      })
      .then(() => runs.rows[0]);
  }

  it('writes a real cost into the ledger for a priced model', async () => {
    const row = await run('claude-haiku-4-5', { inputTokens: 900, outputTokens: 120 });
    expect(row?.costUsd).toBe(0.0015);
  });

  it('writes null for a model with no published price in the table', async () => {
    const row = await run('claude-sonnet-5', { inputTokens: 900, outputTokens: 120 });
    expect(row?.costUsd).toBeNull();
  });

  it('writes null when the provider reported no usage', async () => {
    const row = await run('claude-haiku-4-5', undefined);
    expect(row?.costUsd).toBeNull();
  });
});

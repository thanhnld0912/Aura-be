import type { AiUsage } from './types.js';

/**
 * What a call cost, from published list prices.
 *
 * This is the dependency `AiService` leaves open as `estimateCost` (Task 2): the service
 * knows a call reported 900 input tokens, and nothing about what a token is worth.
 * Keeping the table here rather than inside `ClaudeProvider` is deliberate — a provider
 * transports requests, and the day Gemini arrives its prices belong in this same map
 * rather than in a second copy of this logic.
 *
 * ## The rule this file exists to keep
 *
 * A price that is not in the table produces `null`, not an approximation
 * (DATABASE_DESIGN.md §3.8). A `cost_usd` column that mixes real figures with guesses is
 * worse than one with holes in it: the holes are visible, and a plausible wrong number
 * is not. So an unknown model, or a call that reported no usage at all, is honestly
 * unpriced.
 *
 * ## Source
 *
 * https://platform.claude.com/docs/en/about-claude/pricing, read 2026-09-10. USD per
 * million tokens. These are list prices — an account with negotiated discounts, or one
 * routed through Bedrock or Vertex, pays something else, and this table does not know
 * that.
 */

export interface ModelPrice {
  /** Uncached input. Anthropic reports these separately from cache reads. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** A cache hit, billed at 0.1x base input on every model AURA uses. */
  cacheReadPerMTok: number;
}

/**
 * Only the models AURA is configured to call (`AI_MODEL_EXTRACTION`,
 * `AI_MODEL_REASONING`). Adding a model here is a two-line change; guessing at one from
 * a family resemblance is how a billing dashboard starts lying.
 *
 * Dated snapshots (`claude-haiku-4-5-20251001`) resolve to their base model below, since
 * a snapshot is priced as the model it snapshots.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
};

/** Strips a trailing `-YYYYMMDD` so a pinned snapshot prices as its base model. */
export function priceFor(model: string): ModelPrice | null {
  const exact = MODEL_PRICES[model];
  if (exact) return exact;

  const undated = model.replace(/-\d{8}$/, '');
  return MODEL_PRICES[undated] ?? null;
}

const PER_MTOK = 1_000_000;

/**
 * Dollars for one attempt, or `null` when the figure would be invented.
 *
 * Note what is *not* priced: cache **writes**. Anthropic bills them at 1.25x input, and
 * `ai_runs` has no column for `cache_creation_input_tokens`, so they cannot be metered
 * honestly. Nothing in AURA sets `cache_control` yet, so today that term is always zero
 * and the total is exact. The moment a caller enables prompt caching this estimate
 * starts running low, and the fix is a column plus a field on `AiUsage` — not a
 * multiplier guessed here.
 */
export function estimateCost(input: { model: string; usage: AiUsage }): number | null {
  const price = priceFor(input.model);
  if (!price) return null;

  const { inputTokens, outputTokens, cacheReadInputTokens } = input.usage;

  // No usage at all means the provider told us nothing — that is a null, not a zero.
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadInputTokens === undefined
  ) {
    return null;
  }

  const dollars =
    ((inputTokens ?? 0) * price.inputPerMTok +
      (outputTokens ?? 0) * price.outputPerMTok +
      (cacheReadInputTokens ?? 0) * price.cacheReadPerMTok) /
    PER_MTOK;

  // `numeric(10,6)` is the ledger's precision; rounding here keeps the stored value and
  // the computed one the same number.
  return Math.round(dollars * 1e6) / 1e6;
}

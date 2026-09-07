import type { DataQuality } from './types.js';

/**
 * Confidence assembly (NUTRITION_ARCHITECTURE.md §6).
 *
 * Three independent things can be wrong about a logged item, and the number has to
 * reflect all of them: whether we identified the right food, whether we got the amount
 * right, and how good the underlying figures are.
 */

/** §6 — local high = 1.0; a composed dish = 0.85; Open Food Facts crowd data = 0.7. */
export const DATA_QUALITY_FACTOR: Record<DataQuality, number> = {
  high: 1.0,
  medium: 0.85,
  low: 0.7,
};

export interface ItemConfidenceInput {
  /** 0.3–1.0 — match score, or 1.0 when the user said so themselves. */
  identification: number;
  /** 0.5–1.0 — from the portion resolver. */
  portion: number;
  dataQuality: DataQuality;
  /** A user-stated item is pinned to 1.0 regardless of everything else. */
  userConfirmed?: boolean;
}

/**
 * The user is the highest-priority provider in the system (§6). A confirmed item is 1.0,
 * full stop — not 1.0 multiplied by how sure a matcher was, because the matcher has been
 * overruled.
 */
export function itemConfidence(input: ItemConfidenceInput): number {
  if (input.userConfirmed) return 1;

  const product =
    clamp(input.identification) * clamp(input.portion) * DATA_QUALITY_FACTOR[input.dataQuality];
  return round(product);
}

/**
 * Meal confidence is the **weighted minimum**, not the mean (§6):
 *
 *   `min × 0.6 + avg × 0.4`
 *
 * One badly-guessed item should visibly lower the whole meal. Averaging hides a 0.3 item
 * behind three 0.9 items, and the user then trusts a total they should be checking — which
 * is the exact failure the confidence number exists to prevent.
 */
export function mealConfidence(itemConfidences: readonly number[]): number | null {
  if (itemConfidences.length === 0) return null;

  const min = Math.min(...itemConfidences);
  const average = itemConfidences.reduce((sum, value) => sum + value, 0) / itemConfidences.length;
  return round(min * 0.6 + average * 0.4);
}

/**
 * How the UI should present a number (§6). Returned by the API so the presentation rule
 * lives with the contract rather than being reinvented per client.
 */
export type ConfidenceBand = 'confident' | 'estimate' | 'uncertain' | 'unresolved';

export function confidenceBand(confidence: number | null): ConfidenceBand {
  if (confidence === null) return 'unresolved';
  if (confidence >= 0.85) return 'confident';
  if (confidence >= 0.6) return 'estimate';
  return 'uncertain';
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

import type { MealUnit, PortionDefinition, PortionSizeLabel } from './types.js';

/**
 * Household measure → grams (NUTRITION_ARCHITECTURE.md §5).
 *
 * A user says "2 chén cơm". A system that only speaks grams forces a conversion they
 * cannot perform, and the friction ends the logging habit. This is the layer that makes
 * the household unit the primary one and grams the exception.
 */

/**
 * The small/medium/large multipliers are a **documented assumption, not a measurement**
 * (§5). They live here, named, so they can be challenged and tuned rather than buried in
 * an expression — and anything resolved through them carries reduced confidence.
 */
export const SIZE_MULTIPLIERS: Record<Exclude<PortionSizeLabel, 'custom'>, number> = {
  small: 0.7,
  medium: 1.0,
  large: 1.4,
};

/**
 * Fallback grams when a food has no portion row for the unit asked for. Category-level
 * guesses, applied only after the food's own portions have been tried, and always with a
 * confidence penalty.
 */
const UNIT_FALLBACK_GRAMS: Record<Exclude<MealUnit, 'g' | 'ml'>, number> = {
  bowl: 200,
  plate: 250,
  piece: 60,
  serving: 150,
};

/** Confidence in the *portion*, independent of whether the food was identified correctly. */
export const PORTION_CONFIDENCE = {
  /** The user gave an exact weight. Nothing to infer. */
  explicit: 1.0,
  /** A portion row for this food and unit exists. */
  knownPortion: 0.85,
  /** A size multiplier was applied to a known portion. */
  sizedPortion: 0.75,
  /** No portion row matched; a category default was used. */
  fallback: 0.6,
} as const;

export interface PortionRequest {
  quantity: number;
  unit: MealUnit;
  /** `small`/`large` scale the resolved portion; `custom` and `medium` do not. */
  sizeLabel?: PortionSizeLabel | undefined;
}

export interface ResolvedPortion {
  grams: number;
  /** The portion row used, when one was. */
  portionId: string | null;
  portionLabel: PortionSizeLabel;
  confidence: number;
  /** Human-readable account of how grams was arrived at, for the response and for tests. */
  basis: string;
}

/**
 * Picks the portion row matching a unit.
 *
 * Matching is on the English `label` and the Vietnamese `labelVi`, both normalised
 * loosely, because a food's portions are authored as "1 bowl" / "1 chén" rather than
 * tagged with a unit enum.
 */
function findPortionForUnit(
  portions: readonly PortionDefinition[],
  unit: MealUnit,
): PortionDefinition | undefined {
  const synonyms: Partial<Record<MealUnit, string[]>> = {
    bowl: ['bowl', 'chen', 'chén', 'tô', 'to', 'bát', 'bat'],
    plate: ['plate', 'đĩa', 'dia'],
    piece: ['piece', 'quả', 'qua', 'cái', 'cai', 'miếng', 'mieng', 'lát', 'lat'],
    serving: ['serving', 'phần', 'phan', 'portion'],
  };

  const wanted = synonyms[unit];
  if (!wanted) return undefined;

  const matches = portions.filter((portion) => {
    const haystack = `${portion.label} ${portion.labelVi ?? ''}`.toLowerCase();
    return wanted.some((word) => haystack.includes(word.toLowerCase()));
  });

  // A default portion wins over an incidental one ("1 chén" over "nửa chén").
  return matches.find((portion) => portion.isDefault) ?? matches[0];
}

function defaultPortion(portions: readonly PortionDefinition[]): PortionDefinition | undefined {
  return portions.find((portion) => portion.isDefault) ?? portions[0];
}

/**
 * Resolves quantity + unit + optional size into grams.
 *
 * Order of attempts, first success wins:
 *   1. explicit grams or millilitres — nothing to infer
 *   2. a portion row for this food matching the unit
 *   3. the food's default portion, when the unit is `serving`
 *   4. a category fallback, with a confidence penalty
 */
export function resolvePortion(
  request: PortionRequest,
  portions: readonly PortionDefinition[] = [],
): ResolvedPortion {
  const { quantity, unit } = request;

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new RangeError(`quantity must be a positive finite number, got ${quantity}`);
  }

  // 1. Explicit weight or volume. `ml` is treated as grams — accurate for water-like
  //    liquids and the convention the per-100g figures assume; documented, not hidden.
  if (unit === 'g' || unit === 'ml') {
    return {
      grams: quantity,
      portionId: null,
      portionLabel: 'custom',
      confidence: PORTION_CONFIDENCE.explicit,
      basis: `${quantity} ${unit} given explicitly`,
    };
  }

  const sizeLabel = request.sizeLabel ?? 'medium';
  const multiplier = sizeLabel === 'custom' ? 1 : SIZE_MULTIPLIERS[sizeLabel];
  const sized = sizeLabel !== 'medium' && sizeLabel !== 'custom';

  // 2 & 3. The food's own portions.
  const matched = findPortionForUnit(portions, unit) ?? (unit === 'serving' ? defaultPortion(portions) : undefined);

  if (matched) {
    return {
      grams: roundGrams(matched.grams * quantity * multiplier),
      portionId: matched.id ?? null,
      portionLabel: sizeLabel,
      confidence: sized ? PORTION_CONFIDENCE.sizedPortion : PORTION_CONFIDENCE.knownPortion,
      basis:
        `${quantity} × ${matched.labelVi ?? matched.label} (${matched.grams} g)` +
        (sized ? ` × ${multiplier} for "${sizeLabel}"` : ''),
    };
  }

  // 4. Category fallback. Still a real number, but the confidence says how it was reached.
  const fallbackGrams = UNIT_FALLBACK_GRAMS[unit];
  return {
    grams: roundGrams(fallbackGrams * quantity * multiplier),
    portionId: null,
    portionLabel: sizeLabel,
    confidence: PORTION_CONFIDENCE.fallback,
    basis: `${quantity} × default ${unit} (${fallbackGrams} g) — this food has no ${unit} portion`,
  };
}

/** Grams to one decimal. Portions are estimates; more precision would be theatre. */
function roundGrams(value: number): number {
  return Math.round(value * 10) / 10;
}

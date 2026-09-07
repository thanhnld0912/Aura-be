import { describe, expect, it } from 'vitest';
import {
  confidenceBand,
  itemConfidence,
  mealConfidence,
} from '../../src/nutrition/confidence.js';
import {
  EMPTY_NUTRIENTS,
  calculateNutrients,
  round,
  sumNutrients,
} from '../../src/nutrition/nutrition-calculator.js';
import { normalizeFoodName, tokenOverlap, tokenize } from '../../src/nutrition/normalize.js';
import {
  PORTION_CONFIDENCE,
  SIZE_MULTIPLIERS,
  resolvePortion,
} from '../../src/nutrition/portion-resolver.js';
import type { NutrientsPer100g, PortionDefinition } from '../../src/nutrition/types.js';

/** Cơm trắng, per the seeded dataset. */
const RICE: NutrientsPer100g = {
  kcal: 130,
  proteinG: 2.7,
  carbsG: 28.2,
  fatG: 0.3,
  fiberG: 0.4,
};

const RICE_PORTIONS: PortionDefinition[] = [
  { id: 'p-half', label: 'half bowl', labelVi: 'nửa chén', grams: 75 },
  { id: 'p-bowl', label: '1 bowl', labelVi: '1 chén', grams: 150, isDefault: true },
  { id: 'p-large', label: 'large bowl', labelVi: '1 tô', grams: 300 },
];

describe('Vietnamese text normalisation', () => {
  it('strips diacritics so inconsistent input still matches', () => {
    expect(normalizeFoodName('Thịt Kho Tộ')).toBe('thit kho to');
    expect(normalizeFoodName('thit kho to')).toBe('thit kho to');
    expect(normalizeFoodName('THỊT KHO TỘ')).toBe('thit kho to');
  });

  it('handles đ, which NFD does not decompose', () => {
    expect(normalizeFoodName('Đậu hũ')).toBe('dau hu');
    expect(normalizeFoodName('bánh đa đỏ')).toBe('banh da do');
  });

  it('collapses punctuation and whitespace', () => {
    expect(normalizeFoodName('  Phở  bò!! ')).toBe('pho bo');
    expect(normalizeFoodName('cá kho tộ (miền Nam)')).toBe('ca kho to mien nam');
  });

  it('is idempotent', () => {
    const once = normalizeFoodName('Bún Bò Huế');
    expect(normalizeFoodName(once)).toBe(once);
  });

  it('tokenizes without duplicates', () => {
    expect(tokenize('cơm cơm trắng')).toEqual(['com', 'trang']);
    expect(tokenize('   ')).toEqual([]);
  });

  it('scores overlap against the query, not the candidate', () => {
    // A short query fully contained in a longer dish name is a good hit.
    expect(tokenOverlap('cơm tấm', 'Cơm tấm sườn bì chả')).toBe(1);
    // A long query only partly matching is not.
    expect(tokenOverlap('cơm tấm sườn bì chả', 'Cơm tấm')).toBeCloseTo(0.4, 5);
    expect(tokenOverlap('', 'anything')).toBe(0);
  });
});

describe('deterministic nutrition calculation', () => {
  it('scales per-100g figures by grams', () => {
    // 2 chén = 300 g of cơm trắng — the worked example in §9.
    expect(calculateNutrients(RICE, 300)).toEqual({
      kcal: 390,
      proteinG: 8.1,
      carbsG: 84.6,
      fatG: 0.9,
      fiberG: 1.2,
    });
  });

  it('is exactly reproducible', () => {
    expect(calculateNutrients(RICE, 137.5)).toEqual(calculateNutrients(RICE, 137.5));
  });

  it('returns zeroes for a zero-gram amount', () => {
    expect(calculateNutrients(RICE, 0)).toEqual(EMPTY_NUTRIENTS);
  });

  it('refuses negative or non-finite grams rather than inventing a number', () => {
    expect(() => calculateNutrients(RICE, -1)).toThrow(RangeError);
    expect(() => calculateNutrients(RICE, Number.NaN)).toThrow(RangeError);
    expect(() => calculateNutrients(RICE, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('propagates null rather than substituting zero', () => {
    // Zero is a claim — "this food has no fibre". Null is the truth — "we do not know".
    const partial: NutrientsPer100g = { ...RICE, fiberG: null };
    expect(calculateNutrients(partial, 100).fiberG).toBeNull();
    expect(calculateNutrients(partial, 100).kcal).toBe(130);
  });

  it('rounds to two decimals', () => {
    expect(round(1.23456)).toBe(1.23);
    expect(calculateNutrients({ ...RICE, proteinG: 2.77 }, 33).proteinG).toBe(0.91);
  });
});

describe('summing a meal', () => {
  it('adds nutrient sets', () => {
    const total = sumNutrients([
      calculateNutrients(RICE, 300),
      { kcal: 285, proteinG: 18, carbsG: 4, fatG: 22, fiberG: 0.5 },
    ]);
    expect(total.kcal).toBe(675);
    expect(total.proteinG).toBe(26.1);
  });

  it('makes the total unknown when any contributor is unknown', () => {
    // Reporting the sum of the rest as if it were complete would be a quiet lie.
    const total = sumNutrients([
      { kcal: 100, proteinG: 5, carbsG: 10, fatG: 1, fiberG: 1 },
      { kcal: null, proteinG: 3, carbsG: 2, fatG: 0, fiberG: null },
    ]);
    expect(total.kcal).toBeNull();
    expect(total.fiberG).toBeNull();
    // The nutrients that *are* known still add up.
    expect(total.proteinG).toBe(8);
  });

  it('treats an empty meal as zero, which is a fact rather than an absence', () => {
    expect(sumNutrients([])).toEqual(EMPTY_NUTRIENTS);
  });
});

describe('portion resolution (NUTRITION_ARCHITECTURE.md §5)', () => {
  it('takes explicit grams at full confidence', () => {
    const resolved = resolvePortion({ quantity: 150, unit: 'g' }, RICE_PORTIONS);
    expect(resolved.grams).toBe(150);
    expect(resolved.confidence).toBe(PORTION_CONFIDENCE.explicit);
    expect(resolved.portionId).toBeNull();
  });

  it('resolves 2 bowls of rice to 300 g through the food own portion', () => {
    const resolved = resolvePortion({ quantity: 2, unit: 'bowl' }, RICE_PORTIONS);
    expect(resolved.grams).toBe(300);
    expect(resolved.portionId).toBe('p-bowl');
    expect(resolved.confidence).toBe(PORTION_CONFIDENCE.knownPortion);
    expect(resolved.basis).toContain('1 chén');
  });

  it('prefers the default portion over an incidental one for the same unit', () => {
    // Both "nửa chén" and "1 chén" mention chén; the default must win.
    expect(resolvePortion({ quantity: 1, unit: 'bowl' }, RICE_PORTIONS).portionId).toBe('p-bowl');
  });

  it('applies the documented small and large multipliers', () => {
    expect(SIZE_MULTIPLIERS).toEqual({ small: 0.7, medium: 1.0, large: 1.4 });

    const small = resolvePortion({ quantity: 1, unit: 'bowl', sizeLabel: 'small' }, RICE_PORTIONS);
    const large = resolvePortion({ quantity: 1, unit: 'bowl', sizeLabel: 'large' }, RICE_PORTIONS);

    expect(small.grams).toBe(105);
    expect(large.grams).toBe(210);
    // A multiplier is an assumption, so confidence drops.
    expect(small.confidence).toBe(PORTION_CONFIDENCE.sizedPortion);
  });

  it('uses the default portion for a serving', () => {
    const resolved = resolvePortion({ quantity: 1, unit: 'serving' }, RICE_PORTIONS);
    expect(resolved.grams).toBe(150);
    expect(resolved.portionId).toBe('p-bowl');
  });

  it('falls back to a category default with reduced confidence when the food has no such portion', () => {
    const resolved = resolvePortion({ quantity: 1, unit: 'plate' }, RICE_PORTIONS);
    expect(resolved.grams).toBe(250);
    expect(resolved.portionId).toBeNull();
    expect(resolved.confidence).toBe(PORTION_CONFIDENCE.fallback);
    expect(resolved.basis).toContain('no plate portion');
  });

  it('falls back when the food has no portions at all', () => {
    expect(resolvePortion({ quantity: 2, unit: 'bowl' }, []).grams).toBe(400);
  });

  it('rejects zero, negative and non-finite quantities', () => {
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolvePortion({ quantity, unit: 'bowl' }, RICE_PORTIONS)).toThrow(RangeError);
    }
  });
});

describe('confidence assembly (NUTRITION_ARCHITECTURE.md §6)', () => {
  it('multiplies identification, portion and data quality', () => {
    expect(
      itemConfidence({ identification: 0.95, portion: 1.0, dataQuality: 'high' }),
    ).toBeCloseTo(0.95, 3);
    expect(
      itemConfidence({ identification: 0.95, portion: 0.85, dataQuality: 'medium' }),
    ).toBeCloseTo(0.686, 3);
  });

  it('pins a user-confirmed item to 1.0 — the user outranks every provider', () => {
    expect(
      itemConfidence({
        identification: 0.3,
        portion: 0.6,
        dataQuality: 'low',
        userConfirmed: true,
      }),
    ).toBe(1);
  });

  it('weights the minimum, so one bad item drags the meal down', () => {
    const items = [0.95, 0.9, 0.9, 0.52];
    const weighted = mealConfidence(items);

    const mean = items.reduce((a, b) => a + b, 0) / items.length;
    expect(weighted).toBeLessThan(mean);
    expect(weighted).toBeCloseTo(0.52 * 0.6 + mean * 0.4, 3);
  });

  it('is null for a meal with no items', () => {
    expect(mealConfidence([])).toBeNull();
  });

  it('bands confidence the way the UI presents it', () => {
    expect(confidenceBand(0.95)).toBe('confident');
    expect(confidenceBand(0.85)).toBe('confident');
    expect(confidenceBand(0.7)).toBe('estimate');
    expect(confidenceBand(0.4)).toBe('uncertain');
    expect(confidenceBand(null)).toBe('unresolved');
  });
});

import { describe, expect, it } from 'vitest';
import { VN_FOODS, validateDataset } from '../../src/database/seeds/vn-foods/index.js';
import { normalizeFoodName } from '../../src/nutrition/normalize.js';

/**
 * The dataset is the product's highest-leverage asset, so it is checked like code rather
 * than trusted like content. Every rule here failed on a real mistake at least once while
 * the dataset was being written.
 */
describe('the Vietnamese food dataset', () => {
  it('passes its own validator', () => {
    expect(validateDataset()).toEqual([]);
  });

  it('is large enough to cover a realistic week of eating', () => {
    expect(VN_FOODS.length).toBeGreaterThanOrEqual(150);
  });

  it('gives every food a source reference — no figure without a basis', () => {
    // This is the rule that stops the dataset drifting into invented numbers.
    for (const food of VN_FOODS) {
      expect(food.sourceReference.length, food.externalId).toBeGreaterThan(20);
    }
  });

  it('labels composed dishes as estimates rather than as measurements', () => {
    const braisedPork = VN_FOODS.find((food) => food.externalId === 'vn-thit-kho-trung');
    expect(braisedPork?.dataQuality).toBe('medium');
    expect(braisedPork?.sourceReference).toContain('Component-derived');

    // A single-ingredient food whose composition is well established can be `high`.
    const rice = VN_FOODS.find((food) => food.externalId === 'vn-com-trang');
    expect(rice?.dataQuality).toBe('high');
    expect(rice?.sourceReference).toContain('USDA');
  });

  it('marks the genuinely uncertain ones low rather than flattering them', () => {
    const low = VN_FOODS.filter((food) => food.dataQuality === 'low');
    expect(low.length).toBeGreaterThan(0);
    // Sweetened drinks are the honest example: the sugar level is chosen per order.
    expect(low.map((food) => food.externalId)).toContain('vn-ca-phe-sua-da');
  });

  it('covers the categories people actually log', () => {
    const categories = new Set(VN_FOODS.map((food) => food.category));
    for (const required of [
      'rice_grain',
      'noodle_soup',
      'noodle_dry',
      'bread',
      'meat',
      'seafood',
      'egg',
      'vegetable',
      'soup',
      'fruit',
      'dairy',
      'drink',
      'street_food',
      'breakfast',
      'condiment',
    ]) {
      expect(categories, required).toContain(required);
    }
  });

  it('includes the dishes the architecture names by example', () => {
    const names = VN_FOODS.map((food) => normalizeFoodName(food.nameVi));
    for (const dish of [
      'Cơm trắng',
      'Cơm tấm',
      'Phở bò',
      'Phở gà',
      'Bún thịt nướng',
      'Bún bò Huế',
      'Bánh mì thịt',
      'Thịt kho trứng',
      'Canh chua cá',
      'Rau muống xào tỏi',
      'Trứng luộc',
      'Ức gà luộc',
      'Chuối',
      'Sữa chua',
    ]) {
      expect(names, dish).toContain(normalizeFoodName(dish));
    }
  });

  it('speaks in household measures, not only grams', () => {
    const rice = VN_FOODS.find((food) => food.externalId === 'vn-com-trang');
    const labels = rice?.portions.map((portion) => portion.labelVi);
    expect(labels).toContain('1 chén');
    expect(labels).toContain('1 tô');

    // A user says "2 chén cơm", never "300 grams of cooked rice".
    const withVietnameseMeasures = VN_FOODS.filter((food) =>
      food.portions.some((portion) => portion.labelVi !== undefined),
    );
    expect(withVietnameseMeasures.length / VN_FOODS.length).toBeGreaterThan(0.9);
  });

  it('gives the documented gram values for a bowl of rice', () => {
    const rice = VN_FOODS.find((food) => food.externalId === 'vn-com-trang');
    const bowl = rice?.portions.find((portion) => portion.labelVi === '1 chén');
    expect(bowl?.grams).toBe(150);
    expect(bowl?.isDefault).toBe(true);
  });

  it('keeps per-100g figures physically possible', () => {
    for (const food of VN_FOODS) {
      const { kcal, proteinG, carbsG, fatG } = food.per100g;
      // Nothing edible is denser in energy than pure fat.
      expect(kcal ?? 0, food.externalId).toBeLessThanOrEqual(900);
      expect((proteinG ?? 0) + (carbsG ?? 0) + (fatG ?? 0), food.externalId).toBeLessThanOrEqual(100.5);
    }
  });

  it('keeps stated energy roughly consistent with stated macros', () => {
    // 4/4/9 kcal per gram. A wide tolerance, because fibre, alcohol and rounding all
    // move the number — this catches a transposed digit, not a modelling nuance.
    for (const food of VN_FOODS) {
      const { kcal, proteinG, carbsG, fatG } = food.per100g;
      if (kcal === null || kcal < 40) continue;

      const fromMacros = (proteinG ?? 0) * 4 + (carbsG ?? 0) * 4 + (fatG ?? 0) * 9;
      if (fromMacros < 20) continue;

      const ratio = kcal / fromMacros;
      expect(ratio, `${food.externalId}: ${kcal} kcal vs ${Math.round(fromMacros)} from macros`)
        .toBeGreaterThan(0.6);
      expect(ratio, food.externalId).toBeLessThan(1.6);
    }
  });

  it('marks exactly one default portion per food', () => {
    for (const food of VN_FOODS) {
      const defaults = food.portions.filter((portion) => portion.isDefault);
      expect(defaults.length, food.externalId).toBe(1);
    }
  });

  it('has unique ids and no duplicate dishes', () => {
    const ids = VN_FOODS.map((food) => food.externalId);
    expect(new Set(ids).size).toBe(ids.length);

    const names = VN_FOODS.map((food) => normalizeFoodName(food.nameVi));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the dataset validator', () => {
  const base = VN_FOODS[0]!;

  it('rejects a food with no source reference', () => {
    expect(validateDataset([{ ...base, sourceReference: '' }])).toContainEqual(
      expect.stringContaining('no source reference'),
    );
  });

  it('rejects a duplicate id', () => {
    expect(validateDataset([base, base])).toContainEqual(
      expect.stringContaining('duplicate externalId'),
    );
  });

  it('rejects negative energy and impossible macros', () => {
    expect(validateDataset([{ ...base, per100g: { ...base.per100g, kcal: -1 } }])).not.toEqual([]);
    expect(
      validateDataset([
        { ...base, per100g: { kcal: 100, proteinG: 60, carbsG: 60, fatG: 60, fiberG: 0 } },
      ]),
    ).toContainEqual(expect.stringContaining('macros sum'));
  });

  it('rejects a food with no portions or no default', () => {
    expect(validateDataset([{ ...base, portions: [] }])).toContainEqual(
      expect.stringContaining('no portions'),
    );
    expect(
      validateDataset([{ ...base, portions: [{ label: '1 bowl', grams: 150 }] }]),
    ).toContainEqual(expect.stringContaining('no default portion'));
  });

  it('rejects a zero-gram portion', () => {
    expect(
      validateDataset([
        { ...base, portions: [{ label: 'x', grams: 0, isDefault: true }] },
      ]),
    ).toContainEqual(expect.stringContaining('grams 0'));
  });
});

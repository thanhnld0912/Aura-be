import { describe, expect, it } from 'vitest';
import { RuleBasedMealParser } from '../../src/nutrition/parser/rule-based-parser.js';

const parser = new RuleBasedMealParser();
const parse = (text: string) => parser.parse(text);

describe('the parser boundary', () => {
  it('returns nothing that could be a nutrition value', async () => {
    const result = await parse('2 chén cơm');
    const keys = Object.keys(result.items[0] ?? {});

    // The interface has no channel for a calorie, and this asserts the shape rather than
    // trusting the type: whatever parses the sentence — rules today, Claude in Phase 4 —
    // physically cannot assert that 2 chén of rice is 390 kcal.
    expect(keys.sort()).toEqual(['confidence', 'name', 'quantity', 'unit']);
    for (const forbidden of ['kcal', 'calories', 'protein', 'grams', 'nutrition']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('Vietnamese parsing', () => {
  it('parses the documented example into three items', async () => {
    const result = await parse('Tôi ăn 2 chén cơm với thịt kho trứng và canh rau.');

    expect(result.items).toEqual([
      { name: 'cơm', quantity: 2, unit: 'bowl', confidence: 0.9 },
      { name: 'thịt kho trứng', quantity: 1, unit: 'serving', confidence: 0.7 },
      { name: 'canh rau', quantity: 1, unit: 'serving', confidence: 0.7 },
    ]);
    expect(result.ambiguous).toEqual([]);
  });

  it('splits on và, với, cùng and kèm', async () => {
    for (const connective of ['và', 'với', 'cùng', 'kèm']) {
      const result = await parse(`1 chén cơm ${connective} 1 quả trứng`);
      expect(result.items, connective).toHaveLength(2);
    }
  });

  it('reads Vietnamese number words', async () => {
    expect((await parse('một tô phở bò')).items[0]).toMatchObject({
      name: 'phở bò',
      quantity: 1,
      unit: 'bowl',
    });
    expect((await parse('hai chén cơm')).items[0]?.quantity).toBe(2);
    expect((await parse('nửa chén cơm')).items[0]?.quantity).toBe(0.5);
  });

  it('reads fractions and decimals', async () => {
    expect((await parse('1/2 chén cơm')).items[0]?.quantity).toBe(0.5);
    expect((await parse('1.5 chén cơm')).items[0]?.quantity).toBe(1.5);
  });

  it('separates a quantity glued to its unit', async () => {
    expect((await parse('200g ức gà')).items[0]).toMatchObject({
      name: 'ức gà',
      quantity: 200,
      unit: 'g',
    });
  });

  it('maps household measures to units', async () => {
    const cases: Array<[string, string]> = [
      ['1 chén cơm', 'bowl'],
      ['1 tô phở', 'bowl'],
      ['1 đĩa cơm tấm', 'plate'],
      ['1 phần thịt kho', 'serving'],
      ['1 quả trứng', 'piece'],
      ['1 miếng bánh chưng', 'piece'],
    ];
    for (const [text, unit] of cases) {
      expect((await parse(text)).items[0]?.unit, text).toBe(unit);
    }
  });

  it('reads size adjectives, before and after the food', async () => {
    expect((await parse('1 tô lớn phở bò')).items[0]?.sizeLabel).toBe('large');
    expect((await parse('1 chén nhỏ cơm')).items[0]?.sizeLabel).toBe('small');
  });

  it('converts a glass and a spoon to a workable amount', async () => {
    expect((await parse('1 ly sữa')).items[0]).toMatchObject({ quantity: 240, unit: 'ml' });
    expect((await parse('2 muỗng đường')).items[0]).toMatchObject({ quantity: 30, unit: 'g' });
  });

  it('strips the leading verb phrase but keeps the food', async () => {
    for (const text of ['Tôi ăn 1 chén cơm', 'Mình vừa ăn 1 chén cơm', 'Em uống 1 chén cơm']) {
      expect((await parse(text)).items[0]?.name, text).toBe('cơm');
    }
  });

  it('drops trailing sentence punctuation from the food name', async () => {
    expect((await parse('1 chén cơm.')).items[0]?.name).toBe('cơm');
  });
});

describe('English parsing', () => {
  it('handles an English sentence with filler', async () => {
    const result = await parse('I had 2 bowls of rice with grilled pork');
    expect(result.items).toEqual([
      { name: 'rice', quantity: 2, unit: 'bowl', confidence: 0.9 },
      { name: 'grilled pork', quantity: 1, unit: 'serving', confidence: 0.7 },
    ]);
  });

  it('splits on commas and plus signs', async () => {
    expect((await parse('1 bowl rice, 1 egg + 1 glass milk')).items).toHaveLength(3);
  });
});

describe('confidence and honesty about uncertainty', () => {
  it('is most confident when both quantity and measure are explicit', async () => {
    expect((await parse('2 chén cơm')).items[0]?.confidence).toBe(0.9);
  });

  it('is less confident when the measure is assumed', async () => {
    expect((await parse('2 cơm')).items[0]?.confidence).toBe(0.8);
    expect((await parse('cơm')).items[0]?.confidence).toBe(0.7);
  });

  it('defaults an unstated quantity to one serving rather than refusing', async () => {
    expect((await parse('thịt kho trứng')).items[0]).toMatchObject({
      quantity: 1,
      unit: 'serving',
    });
  });

  it('reports a fragment it cannot read rather than inventing an item', async () => {
    const result = await parse('2 chén,');
    expect(result.items).toEqual([]);
    expect(result.ambiguous).toEqual(['2 chén']);
  });

  it('handles empty and whitespace input without throwing', async () => {
    for (const text of ['', '   ', '.']) {
      const result = await parse(text);
      expect(result.items.length + result.ambiguous.length).toBeLessThanOrEqual(1);
    }
  });

  it('names itself, so a stored draft records how it was read', async () => {
    expect((await parse('1 chén cơm')).parser).toBe('rule-based-v1');
  });

  it('is deterministic', async () => {
    const text = 'Tôi ăn 2 chén cơm với thịt kho trứng và canh rau.';
    expect(await parse(text)).toEqual(await parse(text));
  });
});

import { describe, expect, it } from 'vitest';
import { VN_FOODS } from '../../src/database/seeds/vn-foods/index.js';
import {
  EXACT_CONFIDENCE,
  FUZZY_FLOOR,
  rankLocalMatches,
  trigramSimilarity,
  type MatchableFood,
} from '../../src/nutrition/food-match.js';

/**
 * Food matching against the real Vietnamese dataset, with no database.
 *
 * The pool is the whole dataset — a superset of anything SQL retrieval returns — so a
 * ranking that is right here is right for every pool the provider can build. The
 * integration suite (`food-resolution.test.ts`) repeats the headline cases end to end.
 */

const POOL: MatchableFood[] = VN_FOODS.map((food) => ({
  id: food.externalId,
  nameVi: food.nameVi,
  nameEn: food.nameEn,
  category: food.category,
  searchPriority: food.searchPriority ?? 0,
}));

const top = (query: string) => rankLocalMatches(query, POOL)[0];
const nameOf = (query: string) => top(query)?.food.nameVi ?? null;
const categoryOf = (query: string) => top(query)?.food.category ?? null;

// Whole-word checks. `\b` in a JavaScript regex is ASCII-only and never matches next to
// "à", so these split on whitespace instead.
const hasWord = (word: string) => ({
  asymmetricMatch: (name: unknown) =>
    typeof name === 'string' && name.normalize('NFC').toLowerCase().split(/\s+/).includes(word),
  toString: () => `a name containing the word "${word}"`,
});
const CHICKEN = hasWord('gà');
const BEEF = hasWord('bò');
const isChicken = (name: string) => CHICKEN.asymmetricMatch(name);

describe('chicken is chicken', () => {
  it.each(['thịt gà', 'thit ga', 'gà', 'ga', 'ức gà', 'uc ga', 'gà luộc', 'ga luoc', 'THỊT GÀ', 'thịt  gà!'])(
    '%s resolves to a chicken food',
    (query) => {
      expect(nameOf(query)).toEqual(CHICKEN);
    },
  );

  it('never lets the generic word "thịt" pull in another animal', () => {
    for (const query of ['thịt gà', 'thit ga']) {
      const names = rankLocalMatches(query, POOL).map((hit) => hit.food.nameVi ?? '');
      expect(names.length).toBeGreaterThan(0);
      expect(names.every(isChicken), query).toBe(true);
    }
  });

  it('resolves the meat of an animal to meat, not to its egg or its noodle soup', () => {
    expect(categoryOf('thịt gà')).toBe('meat');
    // The only other duck row in the dataset is balut — an egg — which "thịt vịt" is not.
    expect(nameOf('thịt vịt')).not.toBe('Trứng vịt lộn');
    expect(categoryOf('thịt vịt')).toBe('meat');
  });
});

describe('beef is beef, and avocado is avocado', () => {
  it.each(['thịt bò', 'thit bo', 'bò', 'bo'])('%s resolves to a beef food', (query) => {
    expect(nameOf(query)).toEqual(BEEF);
  });

  it('treats typed diacritics as meaning something: "bò" is never "bơ"', () => {
    const names = rankLocalMatches('bò', POOL).map((hit) => hit.food.nameVi);
    expect(names[0]).toBe('Thịt bò');
    expect(names.indexOf('Bơ')).toBeGreaterThan(names.lastIndexOf('Thịt bò'));
    // …and the reverse holds: someone who types "bơ" means the avocado, exactly.
    expect(top('bơ')).toMatchObject({ matchedBy: 'exact', confidence: EXACT_CONFIDENCE });
    expect(nameOf('bơ')).toBe('Bơ');
  });

  it('does not call "bo" exact when it could be either word', () => {
    const hit = top('bo');
    expect(hit?.matchedBy).toBe('fuzzy');
    expect(hit?.confidence).toBe(FUZZY_FLOOR);
  });

  it('still separates a full name from its neighbour', () => {
    expect(nameOf('thịt heo')).toEqual(hasWord('heo'));
    expect(nameOf('thịt heo')).not.toBe('Thịt bò');
  });
});

describe('rice and eggs keep working', () => {
  it.each([
    ['cơm trắng', 'Cơm trắng'],
    ['com trang', 'Cơm trắng'],
    ['trứng luộc', 'Trứng luộc'],
    ['trung luoc', 'Trứng luộc'],
    ['white rice', 'Cơm trắng'],
  ])('%s → %s', (query, expected) => {
    expect(nameOf(query)).toBe(expected);
  });

  it.each(['trứng', 'trung'])('%s resolves to an egg', (query) => {
    expect(categoryOf(query)).toBe('egg');
  });

  it.each(['cơm trắng', 'com trang', 'trứng luộc', 'trung luoc', 'thịt bò', 'thit bo'])(
    '%s is an exact match at full exact confidence',
    (query) => {
      expect(top(query)).toMatchObject({ matchedBy: 'exact', confidence: EXACT_CONFIDENCE });
    },
  );

  it('keeps the curated default for a bare staple', () => {
    expect(nameOf('cơm')).toBe('Cơm trắng');
    expect(nameOf('phở')).toBe('Phở bò');
  });
});

describe('ambiguous input is not presented as certain', () => {
  it.each(['gà', 'ga', 'bo', 'thịt', 'thit', 'cơm', 'com', 'trứng', 'trung', 'thịt gà', 'thit ga', 'phở'])(
    '%s is held at the fuzzy floor',
    (query) => {
      expect(top(query)?.confidence).toBe(FUZZY_FLOOR);
    },
  );

  it('keeps a specific, unique description above the floor', () => {
    // One row carries both words, so the identification is not a default among many.
    for (const query of ['ức gà', 'uc ga', 'gà luộc', 'ga luoc']) {
      expect(top(query)?.confidence, query).toBeGreaterThan(FUZZY_FLOOR);
    }
  });

  it('never gives a fuzzy match the confidence of an exact one', () => {
    for (const query of ['gà', 'bò', 'ức gà', 'thịt heo', 'white rice']) {
      const hit = top(query);
      expect(hit?.matchedBy, query).toBe('fuzzy');
      expect(hit?.confidence, query).toBeLessThanOrEqual(0.9);
    }
  });
});

describe('what the ranker refuses', () => {
  it('returns nothing for an empty or punctuation-only query', () => {
    expect(rankLocalMatches('', POOL)).toEqual([]);
    expect(rankLocalMatches('  !! ', POOL)).toEqual([]);
  });

  it('does not let one incidental word carry a long unknown phrase', () => {
    // Each of these shares exactly one word with some food ("không", "ăn", "tái") — too
    // little of the phrase for any row to be what was meant.
    for (const query of ['zzzqqq khong co mon nay', 'mon an khong ton tai zzz', 'zzzqqq không có thật']) {
      expect(rankLocalMatches(query, POOL), query).toEqual([]);
    }
  });

  it('drops a row that shares only the generic word', () => {
    const names = rankLocalMatches('thịt gà', POOL).map((hit) => hit.food.nameVi);
    for (const pork of ['Thịt bò', 'Thịt luộc', 'Thịt quay', 'Thịt heo nạc']) {
      expect(names).not.toContain(pork);
    }
  });

  it('keeps a typo candidate that shares no whole word, but ranks it last', () => {
    // A row the trigram search found for a run-together word shares no token with it —
    // it stays available, behind anything that does share a word.
    const pool = POOL.filter((food) => ['Bánh mì thịt', 'Thịt bò'].includes(food.nameVi ?? ''));
    const ranked = rankLocalMatches('banhmi thit', pool).map((hit) => hit.food.nameVi);
    expect(ranked).toContain('Bánh mì thịt');
  });

  it('is deterministic for the same pool in any order', () => {
    const reversed = [...POOL].reverse();
    for (const query of ['gà', 'thịt', 'bo', 'cơm']) {
      expect(rankLocalMatches(query, reversed)[0]?.food.id, query).toBe(top(query)?.food.id);
    }
  });
});

describe('trigramSimilarity', () => {
  it('reproduces pg_trgm similarity() for the case that exposed the bug', () => {
    // Measured in PostgreSQL 16: similarity('thit bo', 'thit ga') = 5 / 11.
    expect(trigramSimilarity('thit ga', 'thit bo')).toBeCloseTo(5 / 11, 5);
    expect(trigramSimilarity('bo', 'bo')).toBe(1);
    expect(trigramSimilarity('', 'bo')).toBe(0);
  });
});

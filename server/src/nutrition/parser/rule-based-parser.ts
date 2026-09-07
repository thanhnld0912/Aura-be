import type { MealUnit, PortionSizeLabel } from '../types.js';
import type { MealParser, ParsedItem, ParsedMeal } from './meal-parser.js';

/**
 * A deterministic Vietnamese and English meal parser.
 *
 * No model, no network, no API key — and no nutrition values, which is the property that
 * matters. It reads quantity, measure and food phrase; everything numeric about the food
 * comes from the resolver afterwards.
 *
 * It handles the shape real input actually takes:
 *
 *   "Tôi ăn 2 chén cơm với thịt kho trứng và canh rau"
 *     → [cơm ×2 bowl] [thịt kho trứng ×1 serving] [canh rau ×1 bowl]
 *
 * Deliberately modest. It will not understand everything, and when it cannot read a
 * fragment it says so in `ambiguous` rather than guessing — an unparsed phrase the user
 * can correct is better than a confident wrong one. The Claude implementation in Phase 4
 * replaces this behind the same interface for the harder cases.
 */

/** Phrases that introduce the list of foods but are not food themselves. */
const LEADING_NOISE =
  /^\s*(?:t[oô]i|m[iì]nh|em|anh|ch[iị]|i|we)?\s*(?:v[uừ]a\s+|just\s+)?(?:[aă]n|u[oố]ng|had|ate|drank|eat|have|drink)\s+/iu;

/**
 * Splits a sentence into food fragments.
 *
 * Deliberately not `\b`-delimited: JavaScript word boundaries are ASCII-only, so `\bvà\b`
 * never matches — `à` is not a word character to the engine, so there is no boundary
 * after it, and "cơm và trứng" stayed one fragment. Requiring real whitespace around the
 * connective is both correct and more honest about what is being matched.
 */
const SEPARATORS = /(?:\s*[,;+]\s*)|(?:\s+(?:v[aà]|v[oớ]i|k[eè]m|c[uù]ng|and|with|plus)\s+)/giu;

/** English "2 bowls **of** rice" — filler between the measure and the food. */
const FILLER_WORDS = new Set(['of', 'cua', 'của']);

/** Vietnamese and English measures, mapped to the units the portion resolver speaks. */
const UNIT_WORDS: ReadonlyArray<{ words: string[]; unit: MealUnit }> = [
  { words: ['chén', 'chen', 'bát', 'bat', 'tô', 'to', 'bowl', 'bowls'], unit: 'bowl' },
  { words: ['đĩa', 'dia', 'plate', 'plates'], unit: 'plate' },
  { words: ['phần', 'phan', 'suất', 'suat', 'serving', 'servings', 'portion'], unit: 'serving' },
  {
    words: ['quả', 'qua', 'trái', 'trai', 'cái', 'cai', 'miếng', 'mieng', 'lát', 'lat', 'piece', 'pieces', 'slice'],
    unit: 'piece',
  },
  { words: ['ly', 'cốc', 'coc', 'glass', 'cup', 'lon', 'can', 'chai', 'bottle'], unit: 'ml' },
  { words: ['muỗng', 'muong', 'thìa', 'thia', 'spoon', 'tablespoon', 'teaspoon'], unit: 'g' },
  { words: ['g', 'gram', 'grams', 'gr'], unit: 'g' },
  { words: ['ml', 'millilitre', 'milliliter'], unit: 'ml' },
];

/** Size adjectives, which the portion resolver turns into its documented multipliers. */
const SIZE_WORDS: ReadonlyArray<{ words: string[]; size: PortionSizeLabel }> = [
  { words: ['nhỏ', 'nho', 'small', 'ít', 'it'], size: 'small' },
  { words: ['lớn', 'lon', 'to', 'big', 'large', 'đầy', 'day', 'nhiều', 'nhieu'], size: 'large' },
];

/** Vietnamese number words, for "một tô phở" rather than "1 tô phở". */
const NUMBER_WORDS: Record<string, number> = {
  một: 1, mot: 1, one: 1,
  hai: 2, two: 2,
  ba: 3, three: 3,
  bốn: 4, bon: 4, four: 4,
  năm: 5, nam: 5, five: 5,
  sáu: 6, sau: 6, six: 6,
  nửa: 0.5, nua: 0.5, half: 0.5,
};

/** Default grams when a spoon is the measure — small enough not to distort a total. */
const SPOON_GRAMS = 15;
/** Default millilitres for a glass or can when no volume is stated. */
const GLASS_ML = 240;

export class RuleBasedMealParser implements MealParser {
  readonly name = 'rule-based-v1';

  async parse(text: string): Promise<ParsedMeal> {
    const cleaned = text.trim().replace(LEADING_NOISE, '');
    const fragments = cleaned
      .split(SEPARATORS)
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.length > 0);

    const items: ParsedItem[] = [];
    const ambiguous: string[] = [];

    for (const fragment of fragments) {
      const parsed = this.parseFragment(fragment);
      if (parsed) items.push(parsed);
      else ambiguous.push(fragment);
    }

    return { items, ambiguous, parser: this.name };
  }

  private parseFragment(fragment: string): ParsedItem | null {
    // "200g" and "2chén" arrive glued; separate the number from the measure first.
    const tokens = fragment
      .split(/\s+/)
      .flatMap((token) => splitGluedQuantity(token))
      .filter(Boolean);
    if (tokens.length === 0) return null;

    let index = 0;
    let quantity: number | null = null;
    let unit: MealUnit | null = null;
    let sizeLabel: PortionSizeLabel | undefined;

    // Leading quantity: a digit, a fraction, or a Vietnamese number word.
    const first = tokens[0]?.toLowerCase() ?? '';
    const numeric = parseQuantity(first);
    if (numeric !== null) {
      quantity = numeric;
      index = 1;
    } else if (NUMBER_WORDS[first] !== undefined) {
      quantity = NUMBER_WORDS[first];
      index = 1;
    }

    // A measure word may follow the quantity, or lead the fragment on its own
    // ("tô phở" is one bowl of phở). It may itself be followed by a size.
    const unitToken = tokens[index]?.toLowerCase();
    if (unitToken) {
      const matched = matchUnit(unitToken);
      if (matched) {
        unit = matched;
        index += 1;

        // "2 chén đầy cơm" — the size word sits between the measure and the food.
        const next = tokens[index]?.toLowerCase();
        if (next) {
          const size = matchSize(next);
          if (size) {
            sizeLabel = size;
            index += 1;
          }
        }
      }
    }

    // Skip filler between the measure and the food.
    while (FILLER_WORDS.has(tokens[index]?.toLowerCase() ?? '')) index += 1;

    // Trailing sentence punctuation is not part of the food's name.
    const name = tokens.slice(index).join(' ').trim().replace(/[.!?]+$/u, '');
    // A fragment with no food left after the measure is not something we can resolve.
    if (name.length === 0) return null;

    // A trailing size adjective: "phở tô lớn".
    const nameTokens = name.split(/\s+/);
    const lastToken = nameTokens.at(-1)?.toLowerCase();
    let finalName = name;
    if (nameTokens.length > 1 && lastToken) {
      const size = matchSize(lastToken);
      if (size) {
        sizeLabel = sizeLabel ?? size;
        finalName = nameTokens.slice(0, -1).join(' ');
      }
    }

    const inferredUnit = unit ?? 'serving';
    const resolvedQuantity = quantity ?? 1;

    return {
      name: finalName,
      // A spoon or a glass has no portion row of its own, so give the resolver a weight
      // it can use rather than a unit it will fall back on.
      quantity:
        unit === 'g' && isSpoon(tokens[Math.max(0, index - 1)])
          ? resolvedQuantity * SPOON_GRAMS
          : unit === 'ml' && isGlass(tokens[Math.max(0, index - 1)])
            ? resolvedQuantity * GLASS_ML
            : resolvedQuantity,
      unit: inferredUnit,
      ...(sizeLabel ? { sizeLabel } : {}),
      // Confidence in the *reading*, not the food: an explicit quantity and measure is a
      // clear sentence; an implied "1 serving" is an assumption.
      confidence: quantity !== null && unit !== null ? 0.9 : quantity !== null ? 0.8 : 0.7,
    };
  }
}

/** `"200g"` → `["200", "g"]`; anything else is returned unchanged. */
function splitGluedQuantity(token: string): string[] {
  const glued = /^(\d+(?:[.,]\d+)?|\d+\/\d+)(\p{L}+)$/u.exec(token);
  return glued && glued[1] && glued[2] ? [glued[1], glued[2]] : [token];
}

function parseQuantity(token: string): number | null {
  // "1/2", "2", "2.5"
  const fraction = /^(\d+)\/(\d+)$/.exec(token);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    return denominator === 0 ? null : numerator / denominator;
  }

  if (/^\d+(?:[.,]\d+)?$/.test(token)) return Number(token.replace(',', '.'));
  return null;
}

function matchUnit(token: string): MealUnit | null {
  const stripped = token.replace(/[^\p{L}\p{N}]/gu, '');
  for (const entry of UNIT_WORDS) {
    if (entry.words.includes(stripped)) return entry.unit;
  }
  return null;
}

function matchSize(token: string): PortionSizeLabel | undefined {
  const stripped = token.replace(/[^\p{L}\p{N}]/gu, '');
  for (const entry of SIZE_WORDS) {
    if (entry.words.includes(stripped)) return entry.size;
  }
  return undefined;
}

function isSpoon(token: string | undefined): boolean {
  if (!token) return false;
  return ['muỗng', 'muong', 'thìa', 'thia', 'spoon', 'tablespoon', 'teaspoon'].includes(
    token.toLowerCase(),
  );
}

function isGlass(token: string | undefined): boolean {
  if (!token) return false;
  return ['ly', 'cốc', 'coc', 'glass', 'cup', 'lon', 'can', 'chai', 'bottle'].includes(
    token.toLowerCase(),
  );
}

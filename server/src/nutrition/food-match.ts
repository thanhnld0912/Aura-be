import { normalizeFoodName } from './normalize.js';

/**
 * Ranking of local food candidates (NUTRITION_ARCHITECTURE.md §4, steps 2–3).
 *
 * Retrieval is SQL's job — `pg_trgm` and whole-word lookups gather the pool. Deciding
 * which row a phrase *means* is this module's, and it works on words rather than
 * character trigrams, because trigrams weigh a word by its length:
 *
 * - "thit ga" has eight trigrams; "thit" contributes five and "ga" three. Every chicken
 *   row shares only the three and scored below the fuzzy floor, so the pool held nothing
 *   but "thịt …" rows and the shortest of them — *thịt bò* — won. A generic word decided
 *   the match and the word that named the food was never consulted.
 * - Diacritics are stripped before comparison, so "bò" (beef) and "bơ" (avocado) are both
 *   `bo`, and "bò" resolved to avocado as an *exact* match.
 *
 * The rules, in order:
 *
 * 1. **Specific words decide.** A generic head such as "thịt" (meat) says what kind of
 *    food, not which one. It narrows the category and breaks ties; it cannot make a match
 *    on its own, and a row that shares only the generic word is not a candidate.
 * 2. **Diacritics are optional, but when typed they must agree.** "bo" may be either;
 *    "bò" is never *bơ*. A disagreeing word still counts for half, so a mistyped tone
 *    finds the right family rather than nothing.
 * 3. **An ambiguous query is never confident.** A diacritic-free phrase with more than one
 *    accented reading in the data, a query of generic words only, or a pick among several
 *    rows that all match fully is held at the fuzzy floor — `estimate`, for the user to
 *    check — instead of presenting a curated default as a certainty.
 *
 * Pure and synchronous, so it is tested against the real seed dataset without a database.
 */

/** A row as far as matching is concerned. */
export interface MatchableFood {
  id: string;
  nameVi: string | null;
  nameEn: string;
  category: string | null;
  /** Curated default for a bare term (`foods.search_priority`). Higher wins. */
  searchPriority: number;
}

export interface RankedFood<T extends MatchableFood> {
  food: T;
  /** 0.95 for an exact match; 0.70–0.90 for a fuzzy one (§4). */
  confidence: number;
  matchedBy: 'exact' | 'fuzzy';
}

export const EXACT_CONFIDENCE = 0.95;
export const FUZZY_FLOOR = 0.7;
export const FUZZY_CEILING = 0.9;

/**
 * Generic head words, keyed by their unaccented form, with the categories they imply.
 *
 * A closed class, not a list of fixes: "thịt X" is "the meat of X" for every X — gà,
 * vịt, heo, bò. A food that neither carries the word nor sits in the category is not what
 * was asked for, which is how "thịt vịt" stops resolving to a duck *egg*.
 */
export const GENERIC_HEADS: ReadonlyMap<string, readonly string[]> = new Map([['thit', ['meat']]]);

interface Token {
  /** Lowercased, NFC, diacritics intact. */
  raw: string;
  /** Diacritic-free, as `normalizeFoodName` produces. */
  folded: string;
  /** Whether the user typed any diacritic in this word. */
  marked: boolean;
}

function toTokens(value: string): Token[] {
  const words = value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);

  const seen = new Set<string>();
  const tokens: Token[] = [];
  for (const raw of words) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const folded = normalizeFoodName(raw);
    if (folded.length === 0) continue;
    tokens.push({ raw, folded, marked: folded !== raw });
  }
  return tokens;
}

const isGeneric = (token: Token) => GENERIC_HEADS.has(token.folded);

/**
 * The share of the deciding words a row must account for. The word-level counterpart of
 * the trigram floor (0.45) the resolver has always applied to the phrase as a whole.
 */
const MIN_ACCOUNTED = 0.5;

/** The same floor `pg_trgm` retrieval uses (`FUZZY_SIMILARITY_THRESHOLD`). */
const TYPO_SIMILARITY_FLOOR = 0.45;

/**
 * How well one query word is matched by a set of name words: 1 when it agrees, 0.5 when
 * only the diacritics disagree, and otherwise a partial credit below 0.5 when it is a
 * near-miss spelling ("banhmi" for *bánh mì*). `english` words carry no diacritics, so a
 * marked query word never fully agrees with one.
 */
function wordScore(query: Token, vi: readonly Token[], en: readonly Token[]): number {
  let best = 0;
  for (const word of vi) {
    if (word.folded !== query.folded) continue;
    if (!query.marked || word.raw === query.raw) return 1;
    best = 0.5;
  }
  for (const word of en) {
    if (word.folded !== query.folded) continue;
    if (!query.marked) return 1;
    best = 0.5;
  }
  return best > 0 ? best : typoCredit(query, vi);
}

/**
 * A misspelt or run-together word still points at a food; a *different* word does not.
 * "ga" against "bo" shares no trigram and earns nothing, which is what keeps "thịt gà"
 * away from *thịt bò*. Always below 0.5, so it never outranks a word typed correctly.
 */
function typoCredit(query: Token, vi: readonly Token[]): number {
  const words = vi.filter((word) => !isGeneric(word)).map((word) => word.folded);
  if (words.length === 0) return 0;

  const similarity = Math.max(
    trigramSimilarity(query.folded, words.join(' ')),
    ...words.map((word) => trigramSimilarity(query.folded, word)),
  );
  return similarity >= TYPO_SIMILARITY_FLOOR ? Math.min(0.49, similarity * 0.5) : 0;
}

/**
 * The reverse question: how much of a *name* word the query accounts for. Same rule as
 * `wordScore`, applied from the name's side — the query's own diacritics decide.
 */
function explainedBy(word: Token, query: readonly Token[]): number {
  let best = 0;
  for (const token of query) {
    if (token.folded !== word.folded) continue;
    if (!token.marked || token.raw === word.raw) return 1;
    best = 0.5;
  }
  return best;
}

/** pg_trgm's `similarity()`, over unaccented text — the last tiebreak only. */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function trigrams(value: string): Set<string> {
  const grams = new Set<string>();
  for (const word of normalizeFoodName(value).split(' ')) {
    if (word.length === 0) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * Every accented reading of a diacritic-free phrase that the pool contains, as a run of
 * consecutive words. Two or more — "bo" is both *bò* and *bơ* — means the phrase alone
 * cannot say which food was meant.
 */
function readingsOf(query: readonly Token[], names: ReadonlyArray<readonly Token[]>): Set<string> {
  const readings = new Set<string>();
  for (const name of names) {
    for (let start = 0; start + query.length <= name.length; start += 1) {
      const run = name.slice(start, start + query.length);
      if (run.every((word, i) => word.folded === query[i]?.folded)) {
        readings.add(run.map((word) => word.raw).join(' '));
      }
    }
  }
  return readings;
}

interface Scored<T extends MatchableFood> {
  food: T;
  exact: boolean;
  specificCoverage: number;
  totalCoverage: number;
  candidateCoverage: number;
  similarity: number;
}

/**
 * Orders `pool` by what `query` most plausibly names, dropping rows it cannot mean.
 * An empty result is an honest answer: the caller moves on to the next provider and,
 * failing that, to `unresolved`.
 */
export function rankLocalMatches<T extends MatchableFood>(
  query: string,
  pool: readonly T[],
): Array<RankedFood<T>> {
  const queryTokens = toTokens(query);
  if (queryTokens.length === 0) return [];

  const specific = queryTokens.filter((token) => !isGeneric(token));
  const genericOnly = specific.length === 0;
  // A query of generic words only ("thịt") is still a query; score it on what it has.
  const deciding = genericOnly ? queryTokens : specific;
  const generics = queryTokens.filter(isGeneric);
  const foldedQuery = queryTokens.map((token) => token.folded).join(' ');

  const unique = [...new Map(pool.map((food) => [food.id, food])).values()];
  const names = unique.map((food) => ({ food, vi: toTokens(food.nameVi ?? ''), en: toTokens(food.nameEn) }));

  const accentAmbiguous =
    queryTokens.every((token) => !token.marked) &&
    readingsOf(
      queryTokens,
      names.map((name) => name.vi),
    ).size > 1;

  const scored: Array<Scored<T>> = [];
  for (const { food, vi, en } of names) {
    // A generic head narrows the category: the meat of X is not X's egg or X's noodle soup.
    const fitsHeads = generics.every(
      (head) =>
        vi.some((word) => word.folded === head.folded) ||
        (food.category !== null && (GENERIC_HEADS.get(head.folded) ?? []).includes(food.category)),
    );
    if (!fitsHeads) continue;

    const decidingScores = deciding.map((token) => wordScore(token, vi, en));
    const specificCoverage = average(decidingScores);
    const totalCoverage = average(queryTokens.map((token) => wordScore(token, vi, en)));

    // A row must account for at least half of the words that decide. Sharing only the
    // generic word — "thịt" with *thịt bò* for "thịt gà" — accounts for none of them; one
    // incidental word in a long unknown phrase ("không" in "zzzqqq không có món này")
    // accounts for too few, and `unresolved` is the honest answer (§4 step 7). A near-miss
    // spelling counts as accounted for, and ranks below every correctly typed match.
    const accounted = decidingScores.filter((score) => score > 0).length / deciding.length;
    if (accounted < MIN_ACCOUNTED) continue;

    const nameWords = vi.filter((word) => !isGeneric(word));
    const candidateCoverage =
      nameWords.length === 0
        ? 1
        : average(nameWords.map((word) => explainedBy(word, queryTokens)));

    const exact =
      !accentAmbiguous &&
      vi.length === queryTokens.length &&
      vi.every((word, i) => {
        const token = queryTokens[i];
        return token !== undefined && word.folded === token.folded && (!token.marked || word.raw === token.raw);
      });

    scored.push({
      food,
      exact,
      specificCoverage,
      totalCoverage,
      candidateCoverage,
      similarity: Math.max(
        trigramSimilarity(foldedQuery, food.nameVi ?? ''),
        trigramSimilarity(foldedQuery, food.nameEn),
      ),
    });
  }

  scored.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.specificCoverage - a.specificCoverage ||
      b.totalCoverage - a.totalCoverage ||
      // The curated default only speaks when the query is matched outright (§4).
      priorityOf(b) - priorityOf(a) ||
      b.candidateCoverage - a.candidateCoverage ||
      b.similarity - a.similarity ||
      (a.food.nameVi ?? a.food.nameEn).length - (b.food.nameVi ?? b.food.nameEn).length ||
      a.food.id.localeCompare(b.food.id),
  );

  const fullMatches = scored.filter((entry) => entry.specificCoverage === 1).length;

  return scored.map((entry) => {
    if (entry.exact) return { food: entry.food, confidence: EXACT_CONFIDENCE, matchedBy: 'exact' as const };

    const ambiguous =
      accentAmbiguous || genericOnly || (fullMatches > 1 && entry.candidateCoverage < 1);
    const quality = entry.specificCoverage * (0.5 + 0.5 * entry.candidateCoverage);
    const confidence = ambiguous
      ? FUZZY_FLOOR
      : FUZZY_FLOOR + (FUZZY_CEILING - FUZZY_FLOOR) * quality;

    return { food: entry.food, confidence: round(confidence), matchedBy: 'fuzzy' as const };
  });
}

function priorityOf(entry: Scored<MatchableFood>): number {
  return entry.specificCoverage === 1 ? entry.food.searchPriority : 0;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

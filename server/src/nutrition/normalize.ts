/**
 * Vietnamese text normalisation — the basis of every food lookup.
 *
 * Real input arrives with inconsistent diacritics constantly, especially from voice
 * transcription and phone keyboards: `thịt kho`, `thit kho`, `THIT KHO`, `thit-kho` are
 * all the same dish. Exact matching would fail most of it
 * (NUTRITION_ARCHITECTURE.md §4 step 3).
 *
 * Stripping happens here rather than in SQL because PostgreSQL's `unaccent()` is only
 * STABLE, not IMMUTABLE, so it cannot be used in a generated column or an index
 * expression without wrapping it in a function whose immutability is a lie. Computing
 * the normalised form in the application keeps `foods.search_name` a plain indexed
 * column, and makes the rule unit-testable without a database.
 */

/**
 * `đ`/`Đ` is not a diacritic composition — NFD leaves it intact — so it needs an
 * explicit rule. Every other Vietnamese mark decomposes normally.
 */
const D_STROKE = /[đĐ]/g;

/** Combining marks left behind by NFD decomposition. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Anything that is not a letter, digit or space becomes a space. */
const NON_ALPHANUMERIC = /[^a-z0-9\s]/g;

const WHITESPACE_RUN = /\s+/g;

/**
 * Lowercased, diacritic-free, punctuation-free, single-spaced.
 *
 * `"Thịt Kho Tộ!"` → `"thit kho to"`
 */
export function normalizeFoodName(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(D_STROKE, 'd')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

/**
 * Tokens, for overlap scoring. Deduplicated so a repeated word cannot inflate a match.
 */
export function tokenize(value: string): string[] {
  const normalized = normalizeFoodName(value);
  return normalized.length === 0 ? [] : [...new Set(normalized.split(' '))];
}

/**
 * Token overlap in 0..1, measured against the *query* rather than the candidate.
 *
 * Asymmetric on purpose: a short query should match a longer dish name well ("com tam"
 * against "com tam suon bi cha" is a good hit), while a long query matching only part of
 * a short name is not. Used to rank within a fuzzy result set, never to decide a match
 * on its own — `pg_trgm` similarity does that.
 */
export function tokenOverlap(query: string, candidate: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const candidateTokens = new Set(tokenize(candidate));
  const matched = queryTokens.filter((token) => candidateTokens.has(token)).length;
  return matched / queryTokens.length;
}

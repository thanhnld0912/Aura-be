import type { PATTERN_KINDS } from '../insights/pattern-evidence.js';

/**
 * The hedge that travels with a pattern (PATTERN_ENGINE_DECISIONS.md D6): deterministic
 * text by kind and locale, owned by the engine and never written by a model. It is not
 * stored with the pattern, so changing the copy needs no data change.
 *
 * Only the text the design documents actually author is here: the English correlation
 * caveat of `API_DESIGN.md` §14. The Vietnamese copy and the copy for the other kinds are
 * open (D6) — for them `caveatFor` returns `null`, and a null caveat does not hide a pattern.
 */

type PatternKind = (typeof PATTERN_KINDS)[number];
export type CaveatLocale = 'en' | 'vi';

const CAVEATS: Partial<Record<PatternKind, Partial<Record<CaveatLocale, string>>>> = {
  correlation: { en: 'This is an association in your own logs, not a cause.' },
};

/**
 * The language of the evidence consumers hand the model: the weekly story and the agent
 * build numbered English statements and attach a pattern's caveat to them verbatim.
 */
export const EVIDENCE_CAVEAT_LOCALE: CaveatLocale = 'en';

export function caveatFor(kind: PatternKind, locale: CaveatLocale): string | null {
  return CAVEATS[kind]?.[locale] ?? null;
}

/**
 * Turning a causal claim into an honest one.
 *
 * ## The rule this enforces
 *
 * AURA looks at one person's own logs and notices things that happened near each other.
 * That is co-occurrence. It is never evidence of cause, and a health app that says
 * "skipping breakfast made you tired" has told someone a fact about their body that
 * nobody established (AI_ARCHITECTURE.md §6).
 *
 * So: *"X caused Y"* → *"X often occurred alongside Y"*.
 *
 * ## Why it rejects instead of trying harder
 *
 * A rewrite has to stay grammatical without knowing the sentence's subject, number or
 * tense. "often occurred alongside" was chosen precisely because it is invariant to all
 * three — it slots into "Late nights cause X", "A late night caused X" and "Late nights
 * lead to X" equally well.
 *
 * Some constructions have no such slot. "Sleeping late makes you skip breakfast" cannot
 * become an association without re-inflecting the verb that follows, and a filter that
 * guesses at that produces sentences no one wrote. Those are **rejected** — the caller
 * drops the sentence and says something it can stand behind, rather than shipping
 * mangled prose. Rejecting is the safe direction; inventing wording is not.
 *
 * ## Scope
 *
 * Pure, deterministic, no model call, no dependency. **It has no caller yet.** Nothing
 * in AURA generates prose today — `/meals/parse` returns structured data only. This is
 * infrastructure for daily and weekly analysis, pattern narration and agent replies,
 * which arrive in Phase 5 and Task 8. It is tested as a unit, not wired anywhere, and
 * wiring it into the meal parser purely to demonstrate a caller would be dishonest about
 * what the system does.
 */

export type CausalFilterResult =
  /** No causal claim found. `text` is byte-identical to the input. */
  | { action: 'unchanged'; text: string }
  /** Rewritten into association language. */
  | { action: 'rewritten'; text: string; rewrites: number }
  /** A causal claim that cannot be rewritten without inventing wording. */
  | { action: 'reject'; reason: 'unrewritable_causal_claim' };

/** The association wording. Invariant to subject number and to tense. */
const EN_ASSOCIATION = 'often occurred alongside';
const VI_ASSOCIATION = 'thường đi cùng với';

/**
 * Vietnamese words are not ASCII, and JavaScript's `\b` is. `\bgây\b` never matches,
 * because `â` is not a word character to the engine — the same trap the rule-based meal
 * parser documents. Real separators are matched instead.
 */
const BEFORE = '(?<=^|[\\s,;:.!?"\'(–—-])';
const AFTER = '(?=$|[\\s,;:.!?"\')–—-])';

function viPattern(phrase: string): RegExp {
  return new RegExp(`${BEFORE}${phrase}${AFTER}`, 'giu');
}

/**
 * Causal verbs with a clean association equivalent.
 *
 * Order matters: "gây ra" is tried before bare "gây", or the longer phrase would be
 * rewritten in halves.
 */
const REWRITABLE: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // ── English ──────────────────────────────────────────────────────────────
  // `\b` is correct here and load-bearing: it is what stops "because" matching
  // "cause", since there is no word boundary inside it.
  { pattern: /\b(?:is|are|was|were)\s+caused\s+by\b/gi, replacement: EN_ASSOCIATION },
  { pattern: /\bcaus(?:es|ed|e)\b/gi, replacement: EN_ASSOCIATION },
  { pattern: /\ble(?:ads|ad|d)\s+to\b/gi, replacement: EN_ASSOCIATION },
  /**
   * "results in" is a verb in "late meals result in poor sleep" and a noun in "the
   * search results in the app". The lookbehind is what separates them: a determiner
   * within one word before it means the noun reading, so the phrase is left alone.
   *
   * The cost is a miss on "these late meals result in X" — a determiner and two words.
   * A false negative here is a claim that survives for a later gate to catch; a false
   * positive rewrites a sentence that was never about causation. The first is the
   * better error.
   */
  {
    pattern:
      /(?<!\b(?:the|these|those|a|an|my|your|our|their|its|his|her)\s(?:\S+\s)?)\bresult(?:s|ed)?\s+in\b/gi,
    replacement: EN_ASSOCIATION,
  },
  { pattern: /\bcontributes?\s+to\b/gi, replacement: EN_ASSOCIATION },

  // ── Vietnamese ───────────────────────────────────────────────────────────
  { pattern: viPattern('gây\\s+ra'), replacement: VI_ASSOCIATION },
  { pattern: viPattern('dẫn\\s+đến'), replacement: VI_ASSOCIATION },
  { pattern: viPattern('gây'), replacement: VI_ASSOCIATION },
  // "khiến bạn bỏ bữa" → "thường đi cùng với việc bạn bỏ bữa": the extra "việc"
  // nominalises the clause that follows, which is what keeps it grammatical.
  { pattern: viPattern('khiến'), replacement: `${VI_ASSOCIATION} việc` },
  { pattern: viPattern('làm\\s+cho'), replacement: `${VI_ASSOCIATION} việc` },
];

/**
 * Causal constructions with no safe deterministic rewrite.
 *
 * `make/makes/made` only counts when it governs a person — "makes you skip breakfast".
 * Bare `made` is deliberately absent: "a bowl made with rice" is a description, and
 * matching it would be the over-matching this filter is supposed to avoid.
 */
const UNREWRITABLE: readonly RegExp[] = [
  /\bmak(?:es|e)\s+(?:you|your)\b/i,
  /\bmade\s+(?:you|your)\b/i,
  /\bis\s+(?:the\s+)?(?:reason|cause)\s+(?:why|for|of)\b/i,
];

/**
 * Rewrites causal language into association language, or reports that it cannot.
 *
 * Text with no causal claim is returned untouched — association wording ("is associated
 * with", "thường xuất hiện cùng") and ordinary explanatory language ("because", "vì")
 * pass through unchanged, because neither asserts that one thing produced another.
 */
export function filterCausalClaims(text: string): CausalFilterResult {
  // Checked first: if a sentence contains both kinds, the unrewritable one decides.
  // Returning a half-fixed sentence would be worse than returning none.
  if (UNREWRITABLE.some((pattern) => pattern.test(text))) {
    return { action: 'reject', reason: 'unrewritable_causal_claim' };
  }

  let result = text;
  let rewrites = 0;

  for (const { pattern, replacement } of REWRITABLE) {
    result = result.replace(pattern, () => {
      rewrites += 1;
      return replacement;
    });
  }

  if (rewrites === 0) return { action: 'unchanged', text };
  // Rewrites can leave doubled spacing where a two-word phrase became one.
  return { action: 'rewritten', text: result.replace(/\s{2,}/g, ' '), rewrites };
}

/** Whether the text asserts causation. Convenience for a caller that only needs a check. */
export function containsCausalClaim(text: string): boolean {
  return filterCausalClaims(text).action !== 'unchanged';
}

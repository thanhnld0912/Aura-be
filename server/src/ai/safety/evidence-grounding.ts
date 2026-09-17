/**
 * Holding generated prose to the evidence it was given.
 *
 * First written for the weekly story (Task 7) and shared here once the agent (Task 8)
 * needed the same guarantees. Domain-free: an evidence item is a numbered statement and a
 * kind, and nothing here knows what a meal or a plan is.
 *
 * ## What it guarantees, and what it does not
 *
 * - A cited ref exists, and is of a kind the caller allows.
 * - Every number in a sentence appears in the evidence *that sentence cites*.
 *
 * It does not bind a number to its noun ("5 workouts" citing "4 of 5 plan items" passes),
 * does not read every spelled-out number (see `SPELLED_NUMBERS`), and cannot tell an
 * invented event described without figures from a real one. Those stay prompt-level.
 */

export type EvidenceKind = 'fact' | 'comparison' | 'pattern' | 'limitation';

/** One numbered statement a model may cite. */
export interface EvidenceItem {
  /** What the model cites: `F1`, `C1`, `P1`, `L1`. Opaque, and never a database id. */
  ref: string;
  kind: EvidenceKind;
  /** A stable identifier returned to clients, e.g. `metric:plan.adherence`. */
  source: string;
  /** Deterministic text carrying the figures — the only numbers a model may use. */
  statement: string;
  /** Patterns only: the engine's hedge, attached to output verbatim. */
  caveat?: string;
  /** Patterns only. Kept server-side — the model is never shown an id. */
  patternId?: string;
}

const PREFIX: Record<EvidenceKind, string> = { fact: 'F', comparison: 'C', pattern: 'P', limitation: 'L' };

/** Numbers refs per kind, in the order items are added: `F1, F2, C1, …`. */
export class EvidenceCollector {
  readonly items: EvidenceItem[] = [];
  private readonly counters: Record<EvidenceKind, number> = { fact: 0, comparison: 0, pattern: 0, limitation: 0 };

  add(item: Omit<EvidenceItem, 'ref'>): EvidenceItem {
    this.counters[item.kind] += 1;
    const added = { ref: `${PREFIX[item.kind]}${this.counters[item.kind]}`, ...item };
    this.items.push(added);
    return added;
  }
}

/**
 * Output that has no business in generated prose, whatever the evidence: markup, links, ids
 * and anything shaped like a credential.
 */
const UNSAFE_MARKUP: readonly RegExp[] = [
  /<\/?[a-z][^>]*>/i,
  /\b(?:https?:\/\/|www\.)\S/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\bsk-[a-z0-9_-]{12,}|\bAIza[0-9a-z_-]{20,}/i,
];

export function hasUnsafeMarkup(text: string): boolean {
  return UNSAFE_MARKUP.some((pattern) => pattern.test(text));
}

/** Weekday names that contain a digit or a number word: "thứ 2", "thứ Hai", "T7". */
const WEEKDAY = /(?<![\p{L}\p{N}])(?:thứ\s*(?:[2-7]|hai|ba|tư|năm|sáu|bảy)|T[2-7])(?![\p{L}\p{N}])/giu;

/**
 * Spelled-out numbers the check can read without guessing. English "one" is left out
 * ("one of the days"), as are Vietnamese "một", "hai", "ba", "năm" and "chín", each of
 * which is also an ordinary word ("một tuần", "cả hai", "ba mẹ", "năm nay", "chín" as
 * cooked). The digit rule in a prompt is the main defence; this closes the easy bypass.
 */
const SPELLED_NUMBERS: ReadonlyArray<[RegExp, number]> = [
  ...(['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'] as const).map(
    (word, index): [RegExp, number] => [new RegExp(`\\b${word}\\b`, 'gi'), index + 2],
  ),
  ...([['bốn', 4], ['sáu', 6], ['bảy', 7], ['tám', 8], ['mười', 10]] as const).map(
    ([word, value]): [RegExp, number] => [new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'giu'), value],
  ),
];

/** Numbers in a string, as values. Signs are dropped: "-0.62" and "0.62" are the same figure. */
export function numbersIn(text: string, options: { prose: boolean }): number[] {
  const scanned = options.prose ? text.replace(WEEKDAY, ' ') : text;
  const values = [...scanned.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => Number(match[0].replace(',', '.')));

  if (options.prose) {
    for (const [pattern, value] of SPELLED_NUMBERS) {
      values.push(...Array.from(scanned.matchAll(pattern), () => value));
    }
  }
  return values;
}

/** Numbers in `text` that none of the `grounding` items contain. Empty means grounded. */
export function ungroundedNumbers(text: string, grounding: readonly EvidenceItem[]): number[] {
  const allowed = grounding.flatMap((item) => numbersIn(`${item.statement} ${item.caveat ?? ''}`, { prose: false }));
  return numbersIn(text, { prose: true }).filter(
    (value) => !allowed.some((candidate) => Math.abs(candidate - value) < 1e-9),
  );
}

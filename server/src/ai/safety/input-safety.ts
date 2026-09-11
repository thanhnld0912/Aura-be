import type { AiPurpose } from '../types.js';
import { ALLOW, block, isActive, type SafetyCategory, type SafetyDecision } from './safety-types.js';

/**
 * The gate in front of the model.
 *
 * ## What this is, and what it is not
 *
 * It is **not** the prompt-injection defence. That is architectural — user text travels
 * in the `messages` array, never in the system prompt, fenced in markers, constrained by
 * a strict schema that has no field an injected instruction could express itself in. All
 * of that holds whether or not a single pattern below ever matches.
 *
 * This is the cheap layer in front of it: an obvious attack or an obviously misdirected
 * request is refused before it costs a model call. A pattern that misses simply means
 * the architecture handles it instead, which is the ordering you want — the guarantee
 * lives in the structure and the screen is an optimisation.
 *
 * ## The bias, stated explicitly
 *
 * Blocking a real meal is worse than admitting a probe. Someone logging dinner and
 * getting refused loses the feature; a probe that gets through meets a strict schema and
 * achieves nothing. So every pattern here is multi-word and anchored, and none of them
 * fires on ordinary food language in either language AURA speaks. "I'm starving",
 * "đói chết đi được" and "nửa tô phở" are food, and the tests say so.
 */

/**
 * A matching copy of the input — never the text that gets forwarded.
 *
 * Zero-width characters are the standard way to break a pattern (`ig<ZWSP>nore`), and
 * compatibility normalisation folds fullwidth letters onto ASCII. Both are applied here
 * and nowhere else: the model still receives exactly what the person typed, because
 * silently rewriting someone's meal description is its own kind of wrong.
 */
function normalizeForMatching(text: string): string {
  return text
    .normalize('NFKC')
    // Zero-width space/non-joiner/joiner, BOM, and soft hyphen.
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Text trying to become instructions.
 *
 * Each pattern needs several words in a specific order. `[^.]{0,N}` lets a phrase be
 * interrupted without letting a match span whole sentences, which is what would start
 * catching innocent text.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  // "ignore all previous instructions", "disregard the above rules"
  /\b(ignore|disregard|forget|override|bypass)\b[^.]{0,30}\b(previous|prior|above|earlier|all|any|your)\b[^.]{0,25}\b(instruction|rule|prompt|direction|guideline|constraint)/,
  // Any reference to the system prompt as an object to act on.
  /\b(system|developer)\s+(prompt|message|instruction)/,
  // "show me your instructions", "repeat the prompt above"
  /\b(reveal|show|print|output|repeat|display|tell me|give me)\b[^.]{0,30}\b(your|the)\b[^.]{0,20}\b(prompt|instruction|rule|system|guideline)/,
  // Role reassignment.
  /\byou are now\b/,
  /\bnew instructions?\s*:/,
  /\b(act|behave|respond) as (a|an|if)\b/,
  /\bpretend (that )?you\b/,
  // Naming the machinery of structured output.
  /\b(additionalproperties|json[_ ]?schema|output[_ ]?config|max[_ ]?tokens|stop[_ ]?reason)\b/,
  /\bjson\b[^.]{0,20}\b(schema|format|only|output)\b/,
];

/**
 * Attempts to widen the extraction contract.
 *
 * These are injection by another name, and they are the ones that matter most here,
 * because the thing being asked for — a calorie count from the model — is precisely what
 * the architecture exists to prevent.
 *
 * Note what is *not* matched: a bare mention of a nutrient. "cơm 500 kcal" is someone
 * telling us what they think they ate, which is ordinary input and not an attack. The
 * patterns require a verb aimed at the model's *response*.
 */
const SCHEMA_MANIPULATION_PATTERNS: readonly RegExp[] = [
  /\b(return|output|include|add|emit|respond with|reply with|give)\b[^.]{0,30}\b(kcal|calorie|protein|carb|fat|fiber|fibre|macro|nutrition)/,
  /\b(add|include|return|output|emit|append)\b[^.]{0,20}\b(a |an |the )?(field|property|key|attribute)\b/,
  /\bset\s+(the\s+)?(confidence|ambiguous|unit|quantity|schema|field|property|name)\b[^.]{0,15}\bto\b/,
  /\b(in|to|for|with)\s+(your|the)\s+(response|output|answer|json|result)\b/,
];

/**
 * A request the extraction surface is not for.
 *
 * Narrow on purpose: an imperative *and* a clearly non-food object. The point is to
 * refuse a misdirected call cheaply, not to adjudicate what counts as a meal — a food
 * this list has never heard of must still parse, so nothing here reasons about food at
 * all.
 */
const OFF_TOPIC_PATTERNS: readonly RegExp[] = [
  /\b(write|compose|generate|draft|translate|summari[sz]e|explain|debug|refactor)\b[^.]{0,40}\b(poem|essay|story|code|script|program|function|email|letter|joke|song|homework|article|blog post|essay)\b/,
  // No `\b` on the Vietnamese side: JavaScript word boundaries are ASCII-only, so
  // `\bbài thơ\b` never matches — `ơ` is not a word character, so there is no boundary
  // after it. Real separators are matched instead, the same way the rule-based meal
  // parser and the causal filter do it.
  /(?<=^|[\s,;:."'(])(viết|dịch|giải thích|làm giúp)(?=[\s,;:."')])[^.]{0,40}(?<=^|[\s,;:."'(])(bài thơ|bài văn|bài luận|code|chương trình|email|bài tập)(?=$|[\s,;:.!?"')])/u,
];

const DETECTORS: Readonly<Record<string, (text: string) => boolean>> = {
  prompt_injection: (text) =>
    INJECTION_PATTERNS.some((pattern) => pattern.test(text)) ||
    SCHEMA_MANIPULATION_PATTERNS.some((pattern) => pattern.test(text)),
  off_topic_misuse: (text) => OFF_TOPIC_PATTERNS.some((pattern) => pattern.test(text)),
};

/**
 * Screens one piece of user text for one purpose.
 *
 * Pure and synchronous — no model call, no network, no state. A blocked decision carries
 * an internal category and nothing derived from the text itself, so it can be counted
 * without ever being stored.
 */
export function screenInput(text: string, purpose: AiPurpose): SafetyDecision {
  const normalized = normalizeForMatching(text);

  for (const [category, detect] of Object.entries(DETECTORS)) {
    const name = category as SafetyCategory;
    if (!isActive(purpose, name)) continue;
    if (detect(normalized)) return block(name);
  }

  return ALLOW;
}

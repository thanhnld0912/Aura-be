import type { AiPurpose } from '../types.js';
import {
  ACTIVE_CATEGORIES,
  ALLOW,
  block,
  type SafetyCategory,
  type SafetyDecision,
} from './safety-types.js';

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
  /\b(jailbreak|developer mode|dan mode)\b/,
  // Vietnamese phrasings of the same moves. Separators, not `\b` — see below.
  /(?<![\p{L}])(bỏ qua|phớt lờ|quên)(?![\p{L}])[^.]{0,20}(?<![\p{L}])(mọi|tất cả|các|những)(?![\p{L}])[^.]{0,20}(hướng dẫn|chỉ dẫn|quy tắc|lệnh)/u,
  /(?<![\p{L}])(tiết lộ|cho (tôi|mình) xem|in ra)(?![\p{L}])[^.]{0,20}(system prompt|lời nhắc hệ thống|hướng dẫn hệ thống|prompt của bạn)/u,
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

// ── Conversational categories (Task 8) ───────────────────────────────────────
//
// Active only for `chat` (see `ACTIVE_CATEGORIES`). Each list is phrase-level and anchored
// on real separators, for the reason given on the off-topic patterns above.
//
// The bias is the opposite of the meal gate's, and deliberately so. On a meal field a
// false positive refuses someone's dinner; here a false positive replaces an answer with a
// short, kind message pointing somewhere safer, while a false negative can hand dangerous
// guidance to someone at risk. So these lean towards catching — but never on hunger or
// tiredness idioms: "đói muốn chết", "mệt muốn chết" and "I'm starving" are how people talk,
// and the tests say so.

/** A phrase that must stand alone: not glued to a letter or digit on either side. */
function phrase(source: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, 'u');
}

/**
 * Self-harm and suicidal intent.
 *
 * "muốn chết" alone is not here: "đói muốn chết" means starving. It counts only with a
 * pronoun directly before it — "tôi muốn chết", not "tôi mệt muốn chết".
 */
const CRISIS_PATTERNS: readonly RegExp[] = [
  phrase(
    '(?:kill(?:ing)?|hurt(?:ing)?|harm(?:ing)?|cut(?:ting)?|injur(?:e|ing)) myself|suicid(?:e|al)|end (?:it all|my life)|take my (?:own )?life',
  ),
  phrase("(?:want|wanna|going|plan|planning) to die|don[’']?t want to (?:live|be alive|exist|wake up)"),
  phrase('self[- ]?harm(?:ing)?|no reason to (?:live|go on)|better off dead'),
  phrase('tự tử|tự sát|tự vẫn|chán sống|rạch tay'),
  phrase('tự làm (?:hại|đau) (?:bản thân|chính mình|mình)|không muốn sống(?: nữa)?'),
  phrase('kết liễu (?:cuộc đời|đời mình|bản thân|chính mình)'),
  phrase('(?:tôi|mình|em|tớ|tao|anh|chị) (?:chỉ |thật sự |thực sự )?muốn chết'),
];

/**
 * The same, typed without diacritics. Only phrases that stay unambiguous once folded:
 * "tu tu" is also "từ từ" (slowly), "tu van" is also "tư vấn" (advice), and "chan song"
 * is also "chắn sóng" (a breakwater), so none of them is here.
 */
const CRISIS_FOLDED_PATTERNS: readonly RegExp[] = [
  phrase('tu sat|rach tay|khong muon song(?: nua)?|tu lam hai ban than'),
  phrase('ket lieu (?:cuoc doi|doi minh|ban than)'),
  phrase('(?:toi|minh|em|tao) (?:chi |that su |thuc su )?muon chet'),
];

/**
 * Restriction, purging, compensation and weight-manipulation *as something to do*.
 * Mentioning a diet or a calorie count is not this; asking how to vomit after eating is.
 */
const FOOD_BEHAVIOR_PATTERNS: readonly RegExp[] = [
  phrase('(?:make|making|made) myself (?:throw up|vomit|puke|sick)'),
  /(?<![\p{L}])purg(?:e|ing)[^.]{0,20}(?:eat|food|meal|binge)|(?:binge|eat|ate)[^.]{0,20}purg(?:e|ing)/u,
  /(?<![\p{L}])laxatives?[^.]{0,30}(?:weight|slim|thin|lose)|(?:weight|slim|thin|lose)[^.]{0,30}laxatives?/u,
  phrase('diet pills?|weight[- ]loss pills?|appetite suppressants?|starv(?:e|ing) myself'),
  phrase('(?:not eat(?:ing)?|without eating|fast(?:ing)?|stop eating) for (?:\\d+|a few|several|many) (?:days|weeks)'),
  phrase('eat(?:ing)? (?:only |under |less than |below )+\\d+ ?(?:kcal|calories|cals?)'),
  phrase('(?:burn|work) off (?:what|everything|all) i ate|punish(?:ing)? myself|earn (?:my|the right to) (?:food|meals?|dinner)'),
  phrase('móc họng|(?:tự )?gây nôn|(?:cố|tự) (?:ói|nôn) ra|ăn xong (?:thì )?(?:nôn|ói)'),
  phrase('thuốc (?:giảm cân|xổ|nhuận tràng|ức chế thèm ăn)'),
  phrase('nhịn (?:ăn|đói) (?:\\d+|hai|ba|bốn|năm|mấy|vài|nhiều|cả) (?:ngày|tuần)|(?:bỏ|nhịn) ăn hoàn toàn'),
  phrase('(?:chỉ )?ăn (?:dưới|ít hơn|không quá) \\d+ ?(?:calo|kcal)'),
  phrase('tập bù (?:để )?(?:đốt|trả)|(?:trừng )?phạt bản thân|bỏ đói bản thân'),
];

const FOOD_BEHAVIOR_FOLDED_PATTERNS: readonly RegExp[] = [
  phrase('moc hong|gay non|thuoc (?:giam can|nhuan trang)'),
  phrase('nhin (?:an|doi) (?:\\d+|hai|ba|bon|nam|may|vai|nhieu) (?:ngay|tuan)'),
];

/**
 * Asking for a diagnosis, a prescription or a dose — or describing an acute symptom that
 * needs a person, not an app.
 */
const HEALTH_REQUEST_PATTERNS: readonly RegExp[] = [
  phrase('(?:what|which) (?:disease|illness|condition|disorder) do i have|diagnose (?:me|my|what)'),
  phrase('do i have (?:cancer|diabetes|an? (?:eating )?disorder|depression|anemia|a tumou?r)'),
  phrase('how (?:much|many) (?:mg|milligrams?|pills|tablets|capsules)|(?:dosage|dose) (?:of|for)|prescribe(?: me)?'),
  phrase('(?:stop|quit|change|skip) (?:taking )?my (?:medication|meds|medicine|insulin)'),
  phrase("chest pain|can[’']?t breathe|trouble breathing|short(?:ness)? of breath|fainted|passing out|coughing (?:up )?blood"),
  phrase('(?:bị|mắc) bệnh gì|chẩn đoán (?:giúp|cho|bệnh)|kê (?:đơn|thuốc)'),
  phrase('(?:uống|dùng) bao nhiêu (?:viên|mg|liều)|liều (?:lượng|dùng)|(?:ngừng|bỏ|đổi|dừng) (?:uống )?thuốc'),
  phrase('đau (?:ngực|thắt ngực)|khó thở|ngất xỉu|bị ngất|ngất đi|ho ra máu'),
];

const HEALTH_REQUEST_FOLDED_PATTERNS: readonly RegExp[] = [
  phrase('bi benh gi|kho tho|dau nguc|lieu (?:luong|dung)|ke (?:don|thuoc)'),
];

/** The input twice: normalised, and with Vietnamese diacritics folded away. */
interface MatchText {
  normalized: string;
  folded: string;
}

/** `ư` → `u`, `đ` → `d`. Only for the explicitly unambiguous folded pattern lists. */
function foldDiacritics(normalized: string): string {
  return normalized.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');
}

const any = (patterns: readonly RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

/**
 * Detectors, in priority order.
 *
 * Order decides the answer when a message trips more than one: someone who asks what they
 * ate today *and* says they want to die gets the crisis response, not a boundary about
 * prompt formatting. The last two keep the relative order Task 5 gave them.
 */
const DETECTORS: ReadonlyArray<[SafetyCategory, (text: MatchText) => boolean]> = [
  ['sensitive_crisis', (text) => any(CRISIS_PATTERNS, text.normalized) || any(CRISIS_FOLDED_PATTERNS, text.folded)],
  [
    'unsafe_food_behavior',
    (text) => any(FOOD_BEHAVIOR_PATTERNS, text.normalized) || any(FOOD_BEHAVIOR_FOLDED_PATTERNS, text.folded),
  ],
  [
    'unsafe_health_request',
    (text) => any(HEALTH_REQUEST_PATTERNS, text.normalized) || any(HEALTH_REQUEST_FOLDED_PATTERNS, text.folded),
  ],
  [
    'prompt_injection',
    (text) => any(INJECTION_PATTERNS, text.normalized) || any(SCHEMA_MANIPULATION_PATTERNS, text.normalized),
  ],
  ['off_topic_misuse', (text) => any(OFF_TOPIC_PATTERNS, text.normalized)],
];

/**
 * Screens text against an explicit set of categories. The primitive both gates share —
 * `screenInput` passes a purpose's input policy, `screenOutputText` its output policy.
 */
export function screenCategories(text: string, categories: readonly SafetyCategory[]): SafetyDecision {
  const normalized = normalizeForMatching(text);
  const match: MatchText = { normalized, folded: foldDiacritics(normalized) };

  for (const [category, detect] of DETECTORS) {
    if (!categories.includes(category)) continue;
    if (detect(match)) return block(category);
  }

  return ALLOW;
}

/**
 * Screens one piece of user text for one purpose.
 *
 * Pure and synchronous — no model call, no network, no state. A blocked decision carries
 * an internal category and nothing derived from the text itself, so it can be counted
 * without ever being stored.
 */
export function screenInput(text: string, purpose: AiPurpose): SafetyDecision {
  return screenCategories(text, ACTIVE_CATEGORIES[purpose]);
}

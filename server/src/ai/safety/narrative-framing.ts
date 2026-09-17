/**
 * Framing a generated story about someone's week must never use.
 *
 * ## Why this exists now
 *
 * Task 5 left "an output blocklist on dieting/appearance language" unbuilt because no
 * surface generated prose (AI_ARCHITECTURE.md §6). The weekly story is the first one.
 * This is that list — for model-authored narrative only, never for anything a person
 * typed, and it is not a crisis or health classifier: it does not screen what users
 * say, only what AURA is about to say to them.
 *
 * ## What it is for
 *
 * AURA's stories are about consistency, logging and routines. A sentence that reaches for
 * weight, body shape, calorie restriction, a diagnosis or a supplement has left that
 * brief, whatever the evidence behind it — so the answer is to refuse the sentence, not
 * to soften it. The caller treats a match as a failed response.
 *
 * ## Why so narrow
 *
 * Every entry is a phrase with one reading in a behaviour story. "diet" alone is absent
 * ("a varied diet" is fine), as are "meal" and "skip" alone. Over-matching would refuse
 * honest sentences about someone's week, and a refused story is a real cost where a
 * narrow list's misses are bounded by the schema, the evidence refs and the prompt.
 */

/** JavaScript's `\b` does not treat `ả` or `â` as word characters; see `causal-filter.ts`. */
const BEFORE = '(?<![\\p{L}\\p{N}])';
const AFTER = '(?![\\p{L}\\p{N}])';

function phrase(source: string): RegExp {
  return new RegExp(`${BEFORE}(?:${source})${AFTER}`, 'iu');
}

const PROHIBITED: readonly RegExp[] = [
  // ── English ────────────────────────────────────────────────────────────────
  phrase('los(?:e|ing)\\s+(?:some\\s+)?weight|weight[-\\s]loss|gain(?:ing)?\\s+weight|weight\\s+gain'),
  phrase('calorie\\s+(?:deficit|restriction|counting)|cut(?:ting)?\\s+(?:back\\s+on\\s+)?calories'),
  phrase('burn(?:ing)?\\s+(?:off\\s+)?(?:calories|fat)|body\\s+fat|belly\\s+fat|bmi'),
  phrase('overweight|obes(?:e|ity)|underweight|skinny|slim\\s+down|your\\s+(?:body\\s+shape|figure|physique)'),
  phrase('diagnos(?:e|es|ed|is)|disorder|deficiency|supplements?|medications?'),
  phrase('fasting|eat\\s+less|skip(?:ping)?\\s+(?:a\\s+|your\\s+)?meals?|restrict(?:ing)?\\s+(?:your\\s+)?(?:food|eating|calories)'),

  // ── Vietnamese ─────────────────────────────────────────────────────────────
  phrase('giảm\\s+cân|tăng\\s+cân|giảm\\s+mỡ|đốt\\s+mỡ|đốt\\s+calo|mỡ\\s+bụng'),
  phrase('cắt\\s+giảm\\s+calo|thâm\\s+hụt\\s+calo|hạn\\s+chế\\s+calo'),
  phrase('béo\\s+phì|thừa\\s+cân|thiếu\\s+cân|vóc\\s+dáng|thân\\s+hình|chỉ\\s+số\\s+bmi'),
  phrase('chẩn\\s+đoán|bệnh\\s+lý|rối\\s+loạn|thực\\s+phẩm\\s+chức\\s+năng|thuốc'),
  phrase('nhịn\\s+ăn|ăn\\s+kiêng|bỏ\\s+bữa|ăn\\s+ít\\s+lại'),
];

/** Whether a generated sentence uses framing a weekly story must not use. */
export function containsProhibitedFraming(text: string): boolean {
  return PROHIBITED.some((pattern) => pattern.test(text));
}

/**
 * Framing a *conversational* reply must never use.
 *
 * Narrower than `containsProhibitedFraming`, on purpose. A weekly story is never asked
 * about weight, so any mention of it means the story left its brief. A chat reply is
 * sometimes asked — "what is BMI?", "is intermittent fasting healthy?" — and refusing
 * every answer that names the topic would turn honest questions into errors. So this list
 * targets what makes a reply harmful rather than what it is about: advice to restrict,
 * purge or compensate, extreme weight targets, doses, supplements pushed as advice, a
 * diagnosis stated about the reader, and body labels applied to them.
 */
const HARMFUL: readonly RegExp[] = [
  // ── English ────────────────────────────────────────────────────────────────
  phrase('calorie\\s+deficit|cut(?:ting)?\\s+(?:back\\s+on\\s+)?(?:your\\s+)?calories|eat(?:ing)?\\s+(?:only|under|less\\s+than|below)\\s+\\d+\\s*(?:kcal|calories)'),
  phrase('(?:try|start|consider|you\\s+should|you\\s+could)\\s+(?:intermittent\\s+)?fasting|(?:try|you\\s+(?:should|could|can))\\s+skip(?:ping)?\\s+(?:a\\s+|your\\s+)?meals?'),
  phrase('burn\\s+off\\s+(?:what|everything)|earn\\s+(?:your|the)\\s+(?:food|meals?|dinner)|punish(?:ing)?\\s+yourself|make\\s+up\\s+for\\s+(?:eating|what\\s+you\\s+ate)'),
  phrase('laxatives?|diet\\s+pills?|appetite\\s+suppressants?|purg(?:e|ing)|make\\s+yourself\\s+(?:throw\\s+up|vomit)'),
  phrase('lose\\s+\\d+\\s*(?:kg|kilos?|pounds|lbs)'),
  phrase('\\d+\\s*mg|(?:take|try|consider|buy)\\s+(?:a\\s+|some\\s+)?supplements?'),
  phrase('you\\s+(?:have|may\\s+have|might\\s+have|probably\\s+have)\\s+(?:an?\\s+)?(?:\\S+\\s+)?(?:disorder|disease|deficiency|illness)'),
  phrase("you(?:'re|\\s+are)\\s+(?:too\\s+|a\\s+bit\\s+)?(?:fat|overweight|obese|skinny|too\\s+thin)"),

  // ── Vietnamese ─────────────────────────────────────────────────────────────
  phrase('thâm\\s+hụt\\s+calo|cắt\\s+giảm\\s+calo|ăn\\s+(?:dưới|ít\\s+hơn)\\s+\\d+\\s*(?:calo|kcal)'),
  phrase('(?:hãy|nên|thử)\\s+(?:nhịn\\s+ăn|bỏ\\s+bữa|ăn\\s+ít\\s+lại)'),
  phrase('tập\\s+bù|đốt\\s+(?:bù|hết)\\s+(?:năng\\s+lượng|calo)|(?:trừng\\s+)?phạt\\s+bản\\s+thân'),
  phrase('thuốc\\s+(?:giảm\\s+cân|xổ|nhuận\\s+tràng)|móc\\s+họng|gây\\s+nôn'),
  phrase('giảm\\s+\\d+\\s*(?:kg|ký|cân)'),
  phrase('(?:hãy|nên|thử)\\s+(?:uống|dùng)\\s+(?:thuốc|thực\\s+phẩm\\s+chức\\s+năng)'),
  phrase('bạn\\s+(?:bị|mắc|có\\s+thể\\s+bị|có\\s+lẽ\\s+bị)\\s+(?:bệnh|rối\\s+loạn|chứng)'),
  phrase('bạn\\s+(?:quá\\s+|hơi\\s+)?(?:béo|mập|gầy|thừa\\s+cân|béo\\s+phì)'),
];

/** Whether a conversational reply uses harmful health, food or body framing. */
export function containsHarmfulFraming(text: string): boolean {
  return HARMFUL.some((pattern) => pattern.test(text));
}

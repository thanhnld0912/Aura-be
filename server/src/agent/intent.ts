/**
 * What a chat message is about, and which days it is about — decided without a model.
 *
 * ## Why deterministic
 *
 * Context selection decides which of a person's records leave the database. That is an
 * access decision, and it should be one a test can pin: the same message always selects
 * the same context, and nothing a message says can talk the selector into reading more.
 * Keyword matching is crude, and the failure mode is benign — a missed topic gets a
 * narrower context and an answer that says it lacks the data, never someone else's data
 * and never a larger dump.
 *
 * ## Personal or general
 *
 * "Protein là gì?" is a general question and gets no personal context at all. A message
 * becomes personal when it speaks in the first person ("tôi", "my") or names a time
 * ("hôm nay", "this week"). Only then are records read.
 */

export const AGENT_TOPICS = [
  'patterns',
  'habits',
  'plan',
  'meals',
  'nutrition',
  'activity',
  'checkins',
] as const;

/** Topics in priority order: the first one present names the intent. */
export type AgentTopic = (typeof AGENT_TOPICS)[number];

export const AGENT_INTENTS = ['today', 'weekly', 'general', ...AGENT_TOPICS] as const;
export type AgentIntent = (typeof AGENT_INTENTS)[number];

export type AgentScope =
  | { kind: 'day'; day: 'today' | 'yesterday' }
  | { kind: 'week'; week: 'this' | 'last' }
  | { kind: 'none' };

export interface IntentClassification {
  intent: AgentIntent;
  topics: AgentTopic[];
  scope: AgentScope;
}

/**
 * Matching runs on a folded copy — lowercase, no diacritics, `đ` → `d` — so "hôm nay",
 * "hom nay" and "Hôm Nay" are one phrase. Folding creates collisions ("tối" and "tôi"
 * both become "toi"); every one of them here only widens a topic, never a scope beyond
 * the user's own records.
 */
function fold(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ');
}

function words(source: string): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${source})(?![a-z0-9])`);
}

const TOPIC_PATTERNS: Record<AgentTopic, RegExp> = {
  patterns: words('pattern|patterns|xu huong|quy luat|thuong xuyen|thuong|hay bi|trend|trends|usually|often'),
  habits: words('thoi quen|habit|habits|streak|duy tri'),
  plan: words('ke hoach|plan|plans|planned|lich trinh|con viec|viec gi|schedule|to-?do'),
  meals: words(
    'an gi|da an|bua an|bua sang|bua trua|bua toi|bua phu|bo bua|mon an|do an|an sang|an trua|an toi|meal|meals|breakfast|lunch|dinner|ate|eat|eaten|food',
  ),
  nutrition: words('calo|calories|calorie|kcal|protein|dam|carb|carbs|tinh bot|chat beo|chat xo|fiber|dinh duong|nutrition|macro|macros'),
  activity: words('tap|tap luyen|workout|workouts|gym|chay bo|di bo|walk|walks|run|running|exercise|van dong|the duc|ngu|giac ngu|sleep|slept'),
  checkins: words('tam trang|mood|nang luong|energy|check-?in|cam xuc'),
};

const LAST_WEEK = words('tuan truoc|tuan qua|last week|previous week');
const THIS_WEEK = words('tuan nay|trong tuan|this week|weekly|hang tuan|tuan|week|dao nay|gan day|lately|recently|tong ket|summary');
const YESTERDAY = words('hom qua|dem qua|yesterday|last night');
const TODAY = words('hom nay|sang nay|toi nay|chieu nay|today|tonight|this morning');
// Not "tớ": folded it is "to", and English "how to sleep better" would read as personal.
const FIRST_PERSON = words("toi|minh|em|tao|cua toi|my|me|mine|i|i'm|i've|im");

/** Topics that only mean something across days, whatever the message says about time. */
const WEEK_ONLY: ReadonlySet<AgentTopic> = new Set(['patterns', 'habits']);

export function classifyIntent(message: string): IntentClassification {
  const text = fold(message);
  const topics = AGENT_TOPICS.filter((topic) => TOPIC_PATTERNS[topic].test(text));

  const week = LAST_WEEK.test(text) ? 'last' : THIS_WEEK.test(text) ? 'this' : null;
  const day = YESTERDAY.test(text) ? 'yesterday' : TODAY.test(text) ? 'today' : null;
  const personal = FIRST_PERSON.test(text) || week !== null || day !== null;

  if (!personal) return { intent: 'general', topics, scope: { kind: 'none' } };

  if (week !== null || topics.some((topic) => WEEK_ONLY.has(topic))) {
    return { intent: topics[0] ?? 'weekly', topics, scope: { kind: 'week', week: week ?? 'this' } };
  }

  if (day !== null || topics.length > 0) {
    return { intent: topics[0] ?? 'today', topics, scope: { kind: 'day', day: day ?? 'today' } };
  }

  // First person, but nothing to anchor it to ("tôi thấy hơi mệt"): no records are read.
  return { intent: 'general', topics, scope: { kind: 'none' } };
}

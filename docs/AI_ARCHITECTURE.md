# AURA — AI Architecture

> Model IDs, pricing and API shapes in this document were verified against the current
> Anthropic API reference (cached 2026-06-24), not recalled. Re-verify before Phase 4.

---

## 1. Two capabilities, two vendors, one boundary

| Capability | Provider | Model | Job |
|---|---|---|---|
| **Vision** | Google | `gemini-2.5-flash` | Meal photo → *which foods, roughly what portion* |
| **Reasoning** | Anthropic | `claude-opus-5` | Behaviour analysis, pattern narration, suggestions, planning, chat |
| **Bulk extraction** | Anthropic | `claude-haiku-4-5` | Vietnamese text → structured meal items (high volume, narrow task) |

Both sit behind interfaces in `server/src/ai/providers/`. No module outside `ai/` imports a
vendor SDK.

**The boundary that matters most:** neither model is ever asked for a nutrition figure.
Vision says *"white rice, about two bowls."* Claude says *"rice, quantity 2, unit bowl."*
The number of calories comes from `NutritionProvider` (Rule 6, `NUTRITION_ARCHITECTURE.md`).

### Model selection rationale

`claude-opus-5` is the default for everything in `agent/`. Reasoning about a person's
health behaviour is exactly the case where hedging correctly, refusing to overclaim
causation, and noticing when there is not enough data all matter more than token price —
and where a cheap model's confident-but-wrong output is a product risk, not just a
quality regression.

`claude-haiku-4-5` handles `meals/parse` only: a narrow, high-volume extraction task with a
strict output schema, where the hard part is Vietnamese food vocabulary rather than judgment.
This is the one place a smaller model is clearly appropriate.

Both are configurable per purpose via `AI_MODEL_REASONING` / `AI_MODEL_EXTRACTION`, so the
split can be re-tuned from measurement (`ai_runs`) rather than assumption.

---

## 2. Directory layout

```
server/src/ai/                      # vendor adapters — knows nothing about AURA
├── providers/
│   ├── ai-provider.ts              # interfaces: ReasoningProvider, VisionProvider
│   ├── claude-provider.ts          # @anthropic-ai/sdk
│   ├── vision-provider.ts          # Gemini adapter
│   └── provider-registry.ts        # selection, fallback, circuit breaker
├── prompts/                        # versioned prompt text
├── schemas/                        # Zod — every model output shape
└── ai.service.ts                   # call + validate + meter + record ai_runs

server/src/agent/                   # AURA's reasoning — uses ai/, knows the domain
├── context/
│   ├── context-builder.ts          # assembles the minimum sufficient context
│   ├── daily-context.ts
│   ├── weekly-context.ts
│   └── user-context.ts             # memory: preferences, frequent meals, patterns
├── analysis/
│   ├── meal-analyzer.ts
│   ├── behavior-analyzer.ts
│   ├── pattern-analyzer.ts         # narrates patterns/ output — does not compute them
│   └── adherence-analyzer.ts
├── planning/
│   ├── daily-plan-generator.ts
│   └── meal-suggestion-engine.ts
├── llm/
│   ├── agent-provider.ts
│   ├── claude-agent.ts
│   └── prompts/                    # system prompts, tone reference, safety rules
└── agent.service.ts
```

The split exists so that swapping Claude for another model touches `ai/`, while changing what
AURA *reasons about* touches `agent/`. `agent/` is where the product lives; `ai/` is plumbing.

### As built (Phase 4, Tasks 2–7)

The layout above is the destination. What exists today is smaller, and the names differ:

```
server/src/ai/
├── providers/
│   ├── ai-provider.ts              # one interface: AiProvider
│   ├── fake-provider.ts            # scripted outcomes; the suite needs no API key
│   ├── claude-provider.ts          # @anthropic-ai/sdk — the ONLY file importing it
│   └── gemini-provider.ts          # @google/genai — the ONLY file importing it
├── safety/                         # input/output gates, causal filter (§6)
├── ai-runs.repository.ts           # append-only ledger writer
├── pricing.ts                      # model → published price; unknown model → null
├── types.ts                        # AiRequest / AiCompletion / AiProviderFailure
└── ai.service.ts                   # call + validate + retry + meter + record
```

`server/src/agent/` is still empty, and there is no `provider-registry.ts`: `AiService` holds a
name-keyed map of providers, which is all a two-vendor system needs.

The interface is one method, `complete()`, rather than the separate `ReasoningProvider` and
`VisionProvider` sketched above — reasoning and vision differ in the *request*, not in the
transport, so one adapter per vendor carries both.

### Who owns what

| | `AiService` | `ClaudeProvider` |
|---|---|---|
| Zod validation | ✅ caller-supplied schema | ❌ never — it could "repair" output |
| Retry policy | ✅ max 2 provider calls | ❌ SDK built with `maxRetries: 0` |
| Timeout | ✅ owns the `AbortController` | passes the signal to the SDK |
| `ai_runs` | ✅ one row per attempt | ❌ never writes |
| Cost | ✅ via injected `estimateCost` | ❌ no pricing inside the adapter |
| Prompt text | caller's, passed through | ❌ builds nothing |
| Anthropic types | ❌ never sees one | ✅ confined to this file |

The provider does exactly one thing: `AiRequest` → `AiCompletion`, or throw
`AiProviderFailure`. It reports *what happened* (kind, HTTP status, `Retry-After`); it does not
decide what that means. `AiProviderFailure` carries no `retryable` flag for that reason — the
policy lives in `AiService.isRetryable`, in one place.

**Model choice is the caller's.** `AiRequest.model` is forwarded verbatim, so the extraction
path (Haiku) and the reasoning path (Opus) are the same code with different arguments. Nothing
in the provider special-cases a model, and nothing adds `thinking` or `output_config.effort` —
see the warning in §1, and note that Haiku 4.5 would reject both with a 400.

**Structured output.** When a caller supplies `AiRequest.jsonSchema`, it is sent as
`output_config: { format: { type: 'json_schema', schema } }`. Callers build that JSON Schema
from their Zod schema with `zod-to-json-schema`, which the project already depends on. The
SDK's `zodOutputFormat()` helper is **not** usable here: it imports from `zod/v4`, and AURA is
on Zod 3. Structured output constrains the shape; it does not replace validation, and the
response is still `safeParse`d by `AiService`.

### The first caller: meal extraction (Task 4)

```
POST /api/meals/parse → MealsService.parseToDraft → MealParser
                                                      ↓
                                             ClaudeMealParser  (parser: "claude-v1")
                                                      ↓
                                        AiService → ClaudeProvider → Anthropic
                                                      ↓ on failure
                                             RuleBasedMealParser  (parser: "rule-based-v1")
                                                      ↓
                                    ParsedMeal → foodResolver → nutrition
```

`src/nutrition/parser/meal-extraction.ts` holds the prompt, the strict Zod schema and the
JSON Schema derived from it. It lives in `nutrition/` rather than `ai/` because it imports
`MEAL_UNITS`, and `ai/` must stay free of domain types.

**Claude never supplies a number about food.** The schema is `.strict()` on both objects, so a
response carrying `kcal` fails validation, is recorded as a `schema_error`, and falls back —
the value never reaches the domain. Every figure in the response still comes from the food
database by way of the resolver.

**Which failures fall back.** `AI_SCHEMA_ERROR`, `PROVIDER_ERROR` and `PROVIDER_UNAVAILABLE` —
schema failure after the retry, 4xx, 5xx, connection loss, timeout, and refusal. Each one is
already written to `ai_runs` with its status and a sanitised code, so falling back degrades
the reading without hiding the cause: a bad key shows up as a run of `provider_error status
401` rows. Anything else — a `TypeError`, a missing caller identity — propagates, because a
parser that swallowed bugs would make every one look like an outage.

An empty reading is *not* a fallback case. If Claude reports no food, that is an answer, and
`parseToDraft` raises its existing `VALIDATION_ERROR`.

`ParseContext.userId` was added to `MealParser` for one reason: `ai_runs.user_id` is `NOT NULL`
under RLS, so a model-backed parser has to know the authenticated caller. It comes from the
verified token via `MealsService`, never from the meal text.

### The second caller: meal photos (Task 6)

```
POST /api/meals/analyze-image   multipart: image (required) · mealType? · description?
  → auth preHandler — before a byte of the body is read
  → ai-vision bucket (20/day)
  → lib/images.ts: size · declared type · magic bytes · declared-dimension guard
                   · re-encode to WebP · all metadata, GPS included, stripped
  → MealsService.analyzeImageToDraft
  → GeminiVisionMealParser  (parser: "gemini-vision-v1")
  → AiService → GeminiProvider → Gemini   (AI_MODEL_VISION, default gemini-2.5-flash)
  → ParsedMeal → foodResolver → nutrition → draft
```

**Responsibility.** Vision estimates food identity and visual portion information; it does
not provide authoritative nutrition values or exact measurements. A single image cannot
reliably determine exact food weight in all cases, and the contract is built so the model
cannot pretend otherwise:

| Enforcement | Where |
|---|---|
| No `g` or `ml` unit — an exact weight is inexpressible | `meal-vision.ts`, `VISION_UNITS` |
| `quantity: null` is valid — "the photo doesn't show how much" is an answer | same schema |
| An uncounted item becomes 1 of its unit, confidence capped at 0.6 | `gemini-vision-meal-parser.ts` |
| `.strict()` — a volunteered `kcal` fails validation and is recorded as `schema_error` | same schema |
| Every number comes from the food database | the existing resolver and calculator |
| Nothing reaches the day until the user confirms | draft only: no event, no summary |

**Input and output.** The response is exactly the `/parse` shape — `{ meal, ambiguous, parser }`
— so a client treats both the same way. The image is never stored: `meals.image_key` stays null,
the upload buffer is dropped after re-encoding, and no image byte enters `ai_runs`, because
`record()` reads `meta` and never `AiRunRequest.image`.

**Prompt injection.** Two untrusted text channels. The optional description is fenced in
`<meal_description>` and screened with `screenInput(…, 'meal_vision')`; a refused description is
dropped and the photo is still read. Text visible *in the photo* is defined by the system prompt
as content, never instruction. Model-authored `name` and `ambiguous` pass through
`safeDisplayText`, exactly as on the text path.

**No fallback.** A sentence has a deterministic reading; a photo does not. A Gemini failure is the
`AppError` `AiService` chose — `422 AI_SCHEMA_ERROR`, `502 PROVIDER_ERROR` or
`503 PROVIDER_UNAVAILABLE` — never a text parse of the caption presented as the photo's contents.
Without `GEMINI_API_KEY` the route still exists, so the OpenAPI document does not depend on which
keys a machine holds, and it answers `503`.

**The provider.** `GeminiProvider` owns `@google/genai` and nothing else:

- `retryOptions` is never set. Verified in the installed SDK that it then makes one `fetch` per
  call; the tests count the fetches.
- Cancellation is the service's own `AbortSignal`, passed as `config.abortSignal` — no second
  timer. Tests assert the signal `fetch` receives is really aborted.
- Structured output uses `responseJsonSchema`, narrowed to the keywords Google documents
  (`minLength`/`maxLength` are dropped; Zod still enforces them on the way back).
- No thinking configuration: the controls differ between Gemini generations.
- Usage: `promptTokenCount` includes cached tokens, so input = prompt − cached, and cache reads are
  reported separately; output = candidates + thoughts, because Google bills thinking as output.
- A blocked prompt, or a safety finish reason, is `refused`, keeping only the enum label.

**Timeout.** 25 s per attempt (`API_DESIGN.md`); with the one retry, a worst case of about 51 s.

### The third caller: the weekly story (Task 7)

The first caller that writes prose. Everything numeric is computed before Claude is involved,
and Claude's output is checked against those numbers rather than trusted to respect them.

```
GET  /api/insights/weekly        InsightsRepository (grouped SQL) → buildWeeklyReport → report
                                 no model call, ever

POST /api/insights/weekly/story  report → buildWeeklyEvidence → ClaudeWeeklyStoryGenerator
                                 → AiService (purpose weekly, AI_MODEL_REASONING) → ClaudeProvider
                                 → Zod shape + evidence refinement → toWeeklyStory
                                 → { status, report, story }
```

```
server/src/insights/                 # library: no HTTP, no auth
├── weekly-report.ts                 # pure aggregation: coverage, sections, comparison, limitations
├── pattern-evidence.ts              # the Pattern Engine contract, consumed — not an engine
├── weekly-story.ts                  # evidence, prompt, schema, grounding checks, mapping
└── weekly-story-generator.ts        # the AiService call
server/src/modules/insights/         # repository, service, schema, routes
server/src/ai/safety/narrative-framing.ts
```

| | Backend | Claude |
|---|---|---|
| Counts, rates, averages, week-on-week deltas | ✅ `weekly-report.ts`, pure and tested | ❌ copies figures, never calculates |
| Pattern statistics and their thresholds | Pattern Engine (Phase 5), through `PatternEvidenceSource` | ❌ |
| A pattern's caveat | the engine's text, attached verbatim | ❌ never paraphrased |
| Choosing, ordering and phrasing claims | | ✅ |
| Suggestions | | ✅ routines only, each citing evidence |

**The week.** Monday to Sunday in `users.timezone` (`startOfLocalWeek`), aggregated by the stored
`local_date` — so Sunday 23:59 and Monday 00:00 local land in different weeks even though they
share a UTC day. Days after today are *not elapsed*, not missing. `weekStart` must be a real
Monday no later than the current week.

**Missing is not zero.** Every section separates *coverage* (how many days had a log of this kind
— a real count, and 0 is true) from *behaviour* (meals, rates, averages — `null` with no data,
never 0). A section with nothing logged is `no_data` and contributes a limitation code
(`no_meal_logs`, …) instead of a figure, so the narrator never holds a "0 meals" it could repeat.
Averages are over days with logs, never over seven. A plan item still `pending` on a closed day
counts as `not_logged` — what `reconcile()` returns once `dayClosed` is true, applied here because
reconciliation only reruns on a write.

**Previous week.** Rates only, never counts. `available` needs ≥3 tracked days (and ≥3 resolved plan
items or habit logs, for those rates) on *both* sides; below that `insufficient_data`; a previous
week with no logs at all is `unavailable`. A change under 10 points is `flat` — presentation, not
statistics.

**Patterns.** The engine does not exist. `NO_PATTERN_ENGINE` returns `null`, which the report shows
as `patterns.status = "unavailable"` plus a limitation — different from `"none"`, an engine that
found nothing. The consumer validates, keeps `active` only, ranks by the engine's own score and
caps at three. It deliberately does **not** re-check `n ≥ 10`, `|r| ≥ 0.45` and the rest: those
are the engine's gates, and a second copy would be a second place for them to drift.

**What Claude receives.** Numbered English statements — `F` facts, `C` comparisons, `P` patterns,
`L` limitations — in a fenced `<weekly_evidence>` block, plus the reader's language and goal focus.
No ids, no dates, no check-in notes, no meal names, no titles. The system prompt contains no data.

**How "do not invent" is enforced.** Every statement in the response carries `evidenceRefs`, and a
refinement bound to *this request's* evidence checks, inside the Zod schema:

| Check | Fails when |
|---|---|
| Refs | a ref does not exist, or is the wrong kind for its section (a highlight citing a limitation) |
| Numbers | a digit — or `two`…`twelve`, `bốn`/`sáu`/`bảy`/`tám`/`mười` — is not in the evidence *that statement cites*; the headline may carry none |
| Patterns | a `patternRef` was not supplied, or repeats |
| Interpretations | nothing under it is a pattern or a comparison |
| Causation | `filterCausalClaims` rejects it; a rewritable claim passes and ships rewritten |
| Framing | `containsProhibitedFraming`: weight, body shape, calorie restriction, diagnosis, supplements |
| Safety | `safeDisplayText(…, 'weekly')` drops it, or it holds markup, a link, a uuid or a key-shaped string |

Because these run inside the schema, a violation is an ordinary `schema_error`: recorded by path,
retried once, then `422 AI_SCHEMA_ERROR`. Nothing partial is returned or stored.

What this does **not** catch, stated so nobody relies on it: a number that *is* in the cited
evidence attached to the wrong noun ("5 workouts" citing "4 of 5 plan items"); Vietnamese number
words that are also ordinary words (`một`, `hai`, `ba`, `năm`, `chín`); and an invented event
described without any number. Those are held by the prompt and by the refs, not by a check.

**Structured output.** `weeklyStoryJsonSchema` keeps only the keywords Anthropic structured
outputs accept — no `minLength`, `maxItems`, `pattern` or ranges. Zod still enforces all of them on
the response.

**When no call is made.** `ai_insights_enabled = false` → `status: "disabled"`. Fewer than 3 tracked
days → `status: "insufficient_data"`. No `ANTHROPIC_API_KEY` → `503`, with the report still served
by `GET`. Evidence that trips the input gate → a `blocked` ledger row and `502`. There is no
templated fallback story.

**Model and limits.** `AI_MODEL_REASONING`; 60 s per attempt (about two minutes worst case with the
retry); `maxTokens` 3,000; `ai-heavy`, 3 per day. `ai_runs.request_meta` is `promptVersion`
(`weekly-story-v1`) and `inputChars` only.

**Not persisted.** There is no `weekly_summaries` table, and a generated story is not stored in an
improvised JSON column. Each `POST` is a new call; the rate limit is what bounds the cost.

### The fourth caller: the conversational agent (Task 8)

A person types a question; AURA answers from their own records, or from general wellness
knowledge, and never from a model's idea of what their records might say.

```
POST /api/agent/chat { message }
  → screenInput(message, 'chat') ──blocked──→ fixed reply, no model call, blocked ledger row
  → aiInsightsEnabled?            ──off──────→ fixed reply
  → classifyIntent                  deterministic: topics + scope (day | week | none)
  → AgentContextBuilder             existing read paths only → numbered evidence
  → ClaudeAgentReplyGenerator → AiService (purpose chat, AI_MODEL_REASONING) → ClaudeProvider
  → Zod shape + evidence refinement → toAgentReply
  → { kind, intent, answer, sections, suggestions, caveats, usedContext, promptVersion }
```

```
server/src/agent/                    # pure: no HTTP, no database
├── intent.ts                        # message → intent, topics, scope
├── agent-reply.ts                   # prompt, schema, grounding checks, mapping
├── agent-generator.ts               # the AiService call; recordBlocked
└── safety-responses.ts              # fixed supportive and boundary replies
server/src/modules/agent/            # context builder, service, schema, routes
server/src/ai/safety/evidence-grounding.ts   # shared with the weekly story
server/src/ai/structured-output.ts           # shared with the weekly story
```

**No tools.** Claude cannot query the database, call an endpoint or fetch a URL, and there is no
function calling. The server decides what is read; the model phrases what it is given. A future
tool-using design would replace `AgentContextBuilder`'s selection, and is deliberately not built.

**Intent and scope, without a model.** Keyword matching on a folded copy of the message (lowercase,
diacritics removed), in Vietnamese and English. A message is *personal* only when it speaks in the
first person or names a time; otherwise it is `general` and **no record is read**. `patterns` and
`habits` always mean a week; "hôm nay"/"today" and "hôm qua"/"yesterday" mean a day; "tuần
này"/"tuần trước" mean this or last week. A missed topic narrows the context — it never widens it,
and it never reaches another user.

**Context, from existing read paths only.**

| Scope · topic | Read through | Evidence |
|---|---|---|
| day · meals / nutrition | `MealsService.listForDay` (drafts included, then filtered to that date), `MealsRepository.nutritionByDay` | confirmed meals with food names; drafts labelled "unconfirmed, not counted"; confirmed totals; unresolved-item count |
| day · plan | `DailyPlansService.comparison` | adherence, each item's outcome and time, unplanned logs |
| day · activity | `DailyEventsService.listForDay` | walks, workouts, sleep, with time and duration |
| day · check-ins | `DailyEventsService.checkinForDay` | mood, energy, day tag — **never the note** |
| day · none | events, plan, check-in | counts by type, plan, check-in |
| week | `InsightsService.weeklyReport` + `buildWeeklyEvidence` (Task 7) | the whole weekly evidence set, reused as-is |
| week · meals | `MealsRepository.mealTypesByDay` (new, one grouped read) | which weekdays had a breakfast, lunch or dinner logged — "not logged does not show it was skipped" |
| general | nothing | — |

Every read takes `user.id` from the verified token. No statement carries an id, an email, a
timestamp or `raw_input`. Text a person wrote (plan and event titles, food names) is sanitised,
stripped of `<`, `>` and `"`, clipped to 60 characters, and replaced by a neutral label if it trips
the chat input gate. Lists are capped (6 meals, 6 foods per meal, 3 drafts, 10 plan items, 10
activity logs, 40 statements) and the rest summarised as a count. Calories appear only when
`showCalories` is on; otherwise a limitation tells the model not to mention them. A gap is a
limitation ("unknown, not zero"), and an unavailable Pattern Engine is reported as unavailable — not
as "no patterns".

`DailyPlansService.comparison` reconciles before answering, exactly as `GET
/daily-plan/comparison` does; the write is idempotent.

**The message is fenced.** Context and message travel in the user turn, never the system prompt:
`<aura_context>` JSON, then `<untrusted_user_message>`. Any `<untrusted_user_message>` or
`<aura_context>` tag inside the message is replaced by `[tag removed]`, so a message cannot close
its fence or forge a context.

**How a reply is checked.** Inside the Zod schema, against this request's evidence:

| Part | Refs | Numbers | Causal filter | Also |
|---|---|---|---|---|
| `answer` | optional | only from cited refs; none without refs | when refs are cited | framing, output screen, markup |
| `fact` section | required: fact, comparison or limitation | only from cited refs | yes | same |
| `interpretation` section | required: any kind | only from cited refs | yes | same |
| `general` section | forbidden | **none** | no — general physiology is not a claim about someone's logs | same |
| `suggestions`, `caveats` | optional | only from cited refs; none without refs | when refs are cited | same |

`inScope: false` must come with no sections and no suggestions, and is returned as `kind:
"boundary"`. Framing uses `containsHarmfulFraming` — narrower than the weekly story's list, because a
chat may be *asked* about BMI or fasting: it refuses advice to restrict, purge or compensate, weight
targets, doses, supplements as advice, a diagnosis stated about the reader and body labels applied to
them. A cited pattern gets the engine's caveat appended verbatim; text equal to that caveat bypasses
the causal rewrite, because the filter would otherwise rewrite "not a cause". A violation is a
`schema_error`: recorded, retried once, then `422`.

**What the checks do not catch.** A number that *is* in the cited evidence attached to the wrong noun;
the Vietnamese number words that are also ordinary words; an invented claim with no number in it;
general education that happens to be wrong. Those are held by the prompt and the refs. General answers
cannot contain numbers at all ("7 to 9 hours of sleep" fails), which errs towards a `422` over an
unsourced figure.

**When no model is called.** A blocked message (crisis, unsafe food behaviour, unsafe health request,
injection) gets a fixed reply from `safety-responses.ts`, in the user's language, whether or not AI
features are on. A blocked row is written only when AI features are on and a generator is configured,
with `inputChars` and `safety: "blocked"` — never the text, never the category. `aiInsightsEnabled:
false` → `kind: "disabled"`. No `ANTHROPIC_API_KEY` → `503` for anything that needs a model.

**Stateless, and no memory.** Each message stands alone. There is no conversation table, no history
sent to the model and no memory written; `conversationId` is rejected. A follow-up that depends on
the previous turn gets an answer that says what it lacks.

**Model and limits.** `AI_MODEL_REASONING`; 30 s per attempt (about a minute worst case);
`maxTokens` 1,500; `ai-chat`, 30 per hour, counting messages the gate answers too.
`ai_runs.request_meta` is `promptVersion` (`agent-chat-v1`) and `inputChars` — the length of the
person's message, not of the prompt.

---

## 3. Every model call is validated (Rule 10)

```
Claude/Gemini  →  raw response  →  Zod  →  ✅ domain object → DB → frontend
                                     └──  ❌ retry once with the error
                                            └── ❌ 422 AI_SCHEMA_ERROR, ai_runs.status='schema_error'
```

Claude is asked for structured output natively rather than being asked to "reply in JSON":

```ts
// server/src/ai/providers/claude-provider.ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { DailyAnalysisSchema } from "../schemas/daily-analysis.schema.js";

const client = new Anthropic();   // ANTHROPIC_API_KEY from server env only

const response = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 16000,
  system: [
    { type: "text", text: AURA_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ],
  messages: [{ role: "user", content: buildDailyContext(day) }],
  thinking: { type: "adaptive" },
  output_config: {
    effort: "medium",
    format: zodOutputFormat(DailyAnalysisSchema),
  },
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
});

if (response.stop_reason === "refusal") {
  return degradedInsight(response.stop_details);   // never surface a raw refusal
}

const analysis = response.parsed_output;           // null if parsing failed — guard
```

Notes on this shape, each of which is a real constraint of the current API:

- `output_config.format` — **not** the deprecated top-level `output_format`.
- `thinking: { type: "adaptive" }` — `budget_tokens` returns a 400 on `claude-opus-5`.
  Thinking is on by default on this model; depth is controlled by `effort`, not a token budget.
- `effort: "medium"` for daily analysis (routine, well-specified); `"high"` for weekly
  analysis and pattern narration, where the reasoning is genuinely harder.
- `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta — a health app will
  occasionally trip a safety classifier on legitimate input (a user describing disordered
  eating, for instance). Without fallbacks the request simply stops. With them the same
  request re-runs on a fallback model inside the same call.
- **Assistant prefill is not available** on this model (400). Output shape is controlled by
  the schema, never by prefilling `{`.

**This snippet is the *reasoning* path only.** `thinking` and `output_config.effort` are
Opus-family parameters: `claude-haiku-4-5`, which handles `meals/parse`, rejects `effort`
and has no adaptive thinking — it takes `budget_tokens` if thinking is wanted at all, and
for a narrow extraction task it is not. The extraction call is therefore the same shape
minus `thinking`, `effort` and `fallbacks`: a model, a cached system prompt, a user
message, and `output_config.format`. Copying the block above into the extractor is a 400.

### Schemas as the single source of truth

```ts
// server/src/ai/schemas/daily-analysis.schema.ts
export const DailyAnalysisSchema = z.object({
  observations: z.array(z.object({
    text: z.string().max(240),
    evidence: z.array(z.string()),          // must cite context keys it was given
  })).max(5),
  deviations: z.array(z.object({
    planned: z.string(), actual: z.string(),
    framing: z.enum(["shifted", "substituted", "not_logged"]),   // no "failed"
  })).max(5),
  suggestions: z.array(z.object({
    text: z.string().max(200),
    kind: z.enum(["meal", "movement", "rest", "hydration", "reflection"]),
    actionable: z.boolean(),
  })).max(3),
  confidence: z.number().min(0).max(1),
});
```

The enums do real safety work. `framing` cannot be `"failed"` because the schema has no such
value — the model *cannot* emit a judgmental framing even if a prompt regression invited one.
**Constraining the vocabulary in the type system is more reliable than asking politely in a
prompt.**

`observations[].evidence` forces each claim to reference a key from the supplied context.
An observation citing nothing is a hallucination, and it is rejected before it reaches the user.

---

## 4. Context building — the memory system (§16)

Claude never queries the database, and never receives raw rows. `context-builder.ts` assembles
a compact, structured brief:

```
Daily Memory      → daily_summaries        (1 row/day, pre-aggregated)
      ↓
Weekly Memory     → weekly_summaries       (1 row/week)
      ↓
Long-term Memory  → patterns, user_preferences, user_food_aliases, frequent meals
```

A daily analysis context is roughly:

```json
{
  "user": { "locale": "vi", "goalFocus": "consistency", "showCalories": true },
  "today": { "date": "2026-09-06", "mealsLogged": 3, "vegetableServings": 3,
             "firstMealTime": "08:40", "bedtime": null, "mood": "good",
             "planAdherencePct": 71 },
  "plannedVsActual": [ { "planned": "Gym 17:30", "actual": "Walk 18:30",
                         "adherence": "substituted" } ],
  "recentDays": [ /* 7 × compact daily_summaries */ ],
  "activePatterns": [ { "key": "late-bedtime-breakfast", "strength": -0.62,
                        "sampleSize": 14 } ],
  "frequentMeals": ["cơm + cá kho", "phở bò", "bún bò Huế"],
  "preferences": { "dislikedFoods": [], "dietaryFlags": [] }
}
```

**~800–1,500 input tokens.** Sending 30 days of raw events would be 40,000+, cost ~30× more,
and produce *worse* analysis — the model would spend its effort re-deriving statistics that
Postgres already computed exactly.

This is the concrete meaning of Rule 7: **Claude is a reasoning layer, not a database.**

### Memory is structured, not a transcript (§16)

Long-term memory is rows, not chat history:

| Memory | Storage | Written by |
|---|---|---|
| `user_preferences` | table | user settings |
| `frequent_meals` | query over `meal_items` | derived on read |
| `behavior_patterns` | `patterns` | Pattern Engine |
| `meal_preferences` | `user_food_aliases` | user corrections |
| `logging_patterns` | `daily_summaries` aggregate | nightly job |
| `historical_insights` | `insights` | past AI runs |

Chat history is retained per conversation for continuity, but it is **not** the memory system.
Storing a rolling transcript as memory would grow without bound, cost more each turn, and make
what AURA "knows" unqueryable and unauditable.

---

## 5. Prompt caching

Request assembly order is `tools` → `system` → `messages`, and cache matching is a **prefix**
match — so the layout is deliberate:

```
[ system: AURA identity + tone + safety rules ]   ← stable, cache_control: ephemeral
[ system: user preferences + active patterns  ]   ← changes weekly, second breakpoint
[ messages: today's context                   ]   ← volatile, never cached
```

The system prompt (identity, voice, safety rules — roughly 1,200 tokens) is byte-identical
across every user and every request, so it caches broadly.

**Silent invalidators to avoid**: never interpolate `new Date()` into the system prompt,
never serialise context objects with unsorted keys, never vary the tool list per request.
Any of these turns the cache hit rate to zero without raising an error.
Verify with `usage.cache_read_input_tokens` — if it stays 0 across repeated calls,
something upstream is changing bytes.

Prompts are **versioned files**, and `ai_runs.request_meta` records the prompt version. When
insight quality changes, you can tell whether a prompt edit caused it.

> **Not yet enabled.** Nothing in the codebase sets `cache_control` today, so
> `cache_read_input_tokens` is absent on every call and `ai_runs.cache_read_input_tokens` is
> null throughout. `ClaudeProvider` passes the field through when the API reports it, and
> deliberately leaves it *absent* rather than writing 0 — absent means "we do not know",
> whereas 0 would assert that caching ran and missed.
>
> One gap to close when caching is switched on: cache **writes** bill at 1.25x input, and
> neither `AiUsage` nor `ai_runs` carries `cache_creation_input_tokens`, so `pricing.ts` cannot
> include that term. Until then the estimate is exact (the term is always zero); afterwards it
> runs low until a column and a field are added.

---

## 6. Health safety (§31)

> **As built (Task 5).** The previous version of this section described a safety system
> that did not exist — an input classifier, output blocklists, a `safetyFlag` on
> responses, a `PatternNarrationSchema`. What follows is what the code does. The gap
> between the two is recorded at the end.

```
user text → screenInput → AiService → provider → Zod → safeDisplayText → domain
                 │                                          │
            blocked: no provider call,              model-authored strings
            ai_runs(status=blocked)                 sanitised before storage
                 ↓
          RuleBasedMealParser
```

Everything lives in `src/ai/safety/` and imports no domain type, so the same gates serve
vision and agent surfaces later. What varies per surface is the *policy*, which is one
table — `ACTIVE_CATEGORIES` in `safety-types.ts`.

### Input gate — purpose-scoped, deliberately narrow

`screenInput(text, purpose)` is pure and synchronous. A category is screened for only
where a detector actually runs:

| Purpose | Active categories |
|---|---|
| `meal_parse`, `meal_vision` | `prompt_injection`, `off_topic_misuse` |
| `chat` | `sensitive_crisis`, `unsafe_food_behavior`, `unsafe_health_request`, `prompt_injection` |
| `daily`, `weekly`, `pattern`, `plan` | `prompt_injection` |

> **As built (Task 8).** The three health categories are active for `chat` and nowhere else. A
> meal-logging field is still the wrong place for them: "đói chết đi được" and "I'm starving" are
> how people describe being hungry. On a conversation they run first, in priority order — crisis,
> food behaviour, health request, then injection — so a message that trips several gets the
> supportive reply. Each detector is phrase-level, in Vietnamese and English, plus a short list of
> diacritic-free phrases chosen because they stay unambiguous once folded ("tu sat", not "tu tu",
> which is also "từ từ"). Idioms are pinned as allowed by tests: "đói muốn chết", "mệt muốn chết",
> "I'm starving". `off_topic_misuse` stays inactive for chat, as Task 5 decided: an off-topic
> question reaches the model, which answers with a boundary.
>
> **Output is screened with the input policy minus those three categories** (`outputCategories`).
> A reply that points someone towards help has to name what it is helping with.
>
> **Known gaps, stated plainly.** Pattern matching misses paraphrase, sarcasm, misspelling beyond
> diacritics, and distress that names no act ("mọi thứ vô nghĩa quá"). It over-catches some honest
> questions: "khó thở khi chạy" gets the health redirect. The design treats the gate as one layer —
> the prompt, the reply schema, the framing list and the causal filter are the others — and not as
> a classifier that understands a person.

The governing bias: **blocking a real meal is worse than admitting a probe.** A probe
that gets through meets a strict schema and achieves nothing; a refused dinner loses the
feature. Every pattern is multi-word and anchored, and the test suite carries an
allow-corpus of real Vietnamese and English meal language — with and without diacritics,
with emoji, with hunger idioms — that must never be blocked.

A block is **not** an error. The text still goes to `RuleBasedMealParser`, which has no
instructions to override and cannot be injected, so the meal is still logged. No new
error code, no change to the `/meals/parse` contract, and no `safetyFlag` on the
response — the meal-parse contract is frozen.

### Prompt injection — architecture first, patterns second

The real defence is structural, and holds whether or not any pattern matches:

```
system instructions (never contain user text)
  + user content in the messages array, fenced in <meal_description>
  + strict JSON schema with no field an instruction could express itself in
  + property-by-property mapping into the domain
```

The pattern screen in front of it is a cost optimisation: it refuses an obvious probe
before it becomes a billed call. Treating it as the guarantee would be the mistake.

### Nutrition boundary (unchanged from Task 4)

`.strict()` on both extraction objects, and a mapping that copies five named fields. A
response carrying `kcal` fails validation, is recorded as `schema_error`, and falls back.
Nothing numeric the model authored can reach the domain; every figure still comes from
the food database through the resolver.

### Output gate

The Zod schema guarantees *shape*, not string contents — and two model-authored strings
travel further than they look. `ParsedItem.name` becomes `detectedName`, which is stored
on the meal item and returned; `ambiguous[]` is echoed verbatim. `safeDisplayText`
removes control, zero-width and bidirectional characters, collapses whitespace, and drops
anything shaped like an instruction.

It deletes and never substitutes, so `cơm tấm sườn bì chả`, `bún bò Huế` and `🍚 cơm`
survive byte-identical. A food name is not a safety problem, and treating it as one would
cost more than the risk.

### Medical boundary

Prompt-level, and honestly so: the extraction prompt forbids diagnosis, dietary advice
and health judgements, and the extraction schema has no field in which advice could be
returned. There is **no medical classifier**. `/meals/parse` returns structured data only;
the weekly story (Task 7) is prose, and there the prompt forbids medical, weight and
restriction advice while `containsProhibitedFraming` refuses a response that uses such
framing anyway. That is an output list for generated narrative, not a classifier of what
people say. When a conversational surface exists, its policy is Task 8's.

### Causal filtering — first caller: the weekly story

`filterCausalClaims(text)` is pure, deterministic and dependency-free. Its first caller is
the weekly story (Task 7): a claim it rejects fails the response schema, and a claim it can
rewrite ships rewritten. Daily analysis, pattern narration and agent replies should reuse it
the same way rather than reinvent it.

*"X caused Y"* → *"X often occurred alongside Y"*. The association wording is invariant
to subject number and tense, which is what makes a deterministic rewrite grammatical.

| Input | Result |
|---|---|
| `causes` / `caused` / `leads to` / `results in` / `contributes to` | rewritten |
| `gây ra` / `gây` / `dẫn đến` / `khiến` / `làm cho` | rewritten |
| `makes you …` / `made you …` / `is the reason why` | **rejected** — no safe rewrite exists |
| `because`, `vì`, `is associated with`, `thường xuất hiện cùng` | untouched |

It rejects rather than guesses. Re-inflecting the verb after "makes you" would produce a
sentence nobody wrote, so the caller is told to drop it and say something it can stand
behind. `because` is not matched, and `\b` is what prevents it matching the `cause`
inside it.

### Privacy

Nothing about a blocked request is persisted beyond the fact that one happened:

```json
{ "promptVersion": "meal-extract-v1", "inputChars": 42, "safety": "blocked" }
```

`ai_runs.error` stays `null` for a block, and the category that matched is never written
down — which rule fired is a classifier's claim about a person, and a health app should
not accumulate those. No raw prompt, no raw response, no user text, in the ledger or in
the logs.

### What is not built

| Described before | Status |
|---|---|
| `safetyFlag` on the API response | Not built. It would change the frozen `/meals/parse` contract; it belongs to the agent response shape. |
| `PatternNarrationSchema`, `isEstimate` | Not built. Phase 5, with pattern narration. A pattern's `caveat` is required by the evidence contract the weekly story consumes (Task 7). |
| Output blocklist on dieting/appearance language | Built for generated prose: `containsProhibitedFraming` (weekly story, Task 7) and the narrower `containsHarmfulFraming` (agent, Task 8). |
| Input crisis and health screening | Built for `chat` in Task 8, with fixed supportive replies. |
| Conversation history, long-term memory | Not built. The agent is stateless (Task 8). |

---

## 7. Cost analysis (§26)

Pricing per million tokens (Anthropic first-party, re-verified 2026-09-10 against
[platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing)):

| Model | Input | Output |
|---|---|---|
| `claude-opus-5` | $5.00 | $25.00 |
| `claude-sonnet-5` | $2.00 | $10.00 |
| `claude-haiku-4-5` | $1.00 | $5.00 |
| `gemini-2.5-flash` | $0.30 | $2.50 |

The executable copy of this table is `src/ai/pricing.ts`, and it is deliberately shorter: only
the three models `env.ts` is configured to call — `claude-haiku-4-5`, `claude-opus-5` and
`gemini-2.5-flash`. The Gemini row was verified on 2026-09-13 against
[ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing), Standard
tier: $0.30 input (images at the text rate), $2.50 output including thinking, $0.03 cache read.
A model that is not in the table prices as `null`, never as an approximation. Rows get added when
a model is actually wired up.

### Per-call estimates

| Operation | Model | In | Out | Cost/call |
|---|---|---|---|---|
| Meal photo | Gemini Flash | ~1,100 (image+prompt) | ~300 | **~$0.0011** |
| Text meal parse | Haiku 4.5 | ~700 | ~350 | **~$0.0025** |
| Daily insight | Opus 5 | ~1,400 (≈900 cached) | ~600 | **~$0.018** |
| Weekly insight | Opus 5 | ~3,000 (≈900 cached) | ~1,400 | **~$0.048** |
| Pattern narration | Opus 5 | ~900 | ~350 | **~$0.013** |
| Chat turn | Opus 5 | ~2,000 (≈900 cached) | ~500 | **~$0.019** |

Cached input bills at a fraction of the input rate, which is why the stable system prompt is
worth its own breakpoint.

### Monthly cost, one moderately active user

| Activity | Volume | Cost |
|---|---|---|
| Meal photos | 20/mo | $0.02 |
| Text meal logs | 40/mo | $0.10 |
| Daily insights | 25/mo | $0.45 |
| Weekly insights | 4/mo | $0.19 |
| Pattern narrations | 6/mo | $0.08 |
| Chat turns | 25/mo | $0.48 |
| **Total** | | **≈ $1.32 / user / month** |

A *light* user (logs meals, rarely chats, reads insights) costs **≈ $0.35/month**.
A heavy user who chats daily reaches **≈ $3/month**.

Chat and daily insight together are ~70% of the bill. If cost becomes a constraint, the first
lever is moving chat to `claude-sonnet-5` (a ~60% reduction on that line) — measured against
quality, not assumed. Downgrading the pattern narration is the *last* thing to try: that
output carries the highest correctness risk in the product.

### The rules that keep it there

1. **No AI on read.** `GET /insights/today` reads `daily_summaries`. Opening the app costs $0.
2. **Daily analysis is capped** at 1/day, runs after 20:00, and is skipped entirely when the
   day has fewer than 2 events — no manufactured insight from one data point.
3. **Weekly analysis is one scheduled job**, cached in `weekly_summaries`.
   *As built (Task 7):* not yet. There is no scheduler and no `weekly_summaries` table. The
   weekly *report* is deterministic and free on read; the *story* is generated only on an
   explicit `POST`, is not cached, and is bounded by the `ai-heavy` limit (3/day).
4. **Pattern narration runs only when a pattern newly crosses threshold**, not on every
   recompute. Statistics recompute nightly and cost nothing.
5. **Meal drafts are reused.** Re-opening an unconfirmed draft does not re-run vision.
6. **Rate limits are cost limits** (`API_DESIGN.md` §17) — 20 vision/day, 3 heavy/day per user
   bounds worst-case spend per user at roughly $0.30/day.

`ai_runs` records tokens, cost and latency for every call, so §26 is a dashboard rather than
an estimate. Cost per active user is a tracked metric from Phase 4 onward.

---

## 8. Failure and degradation

| Failure | Behaviour |
|---|---|
| Provider timeout | Retry once with backoff; then `502 PROVIDER_ERROR` |
| Schema validation fails | Retry once including the validation error; then `422` |
| `stop_reason: "refusal"` | Server-side fallback; if the chain refuses, a templated safe response |
| Vision unavailable | Photo mode answers `503 PROVIDER_UNAVAILABLE`. There is no server-side text fallback and nothing is saved; describing the meal instead goes through `/meals/parse` |
| Claude unavailable | Designed: insights show the last cached value marked `stale: true`. As built (Task 7), nothing is cached: `POST /insights/weekly/story` answers `503`/`502`/`422` and `GET /insights/weekly` keeps serving the deterministic report. No templated story is substituted |
| All providers down | App remains **fully usable** — logging, history, plans and nutrition never depend on AI |

That last row is the design goal: **AI is additive.** A user with no AI availability can still
log meals, follow a plan, and see their history. Nothing in the core loop blocks on a model.

Circuit breaker: 5 consecutive provider failures opens the breaker for 60 s; AI-dependent
endpoints return `503 PROVIDER_UNAVAILABLE` immediately rather than queueing timeouts.

---

## 9. Prompt injection (§23)

Untrusted text reaches the model from three directions: meal descriptions, chat messages, and
group status quotes.

- User content is passed as **`user` messages**, never concatenated into the system prompt.
- Operator instructions mid-conversation use the `{"role": "system"}` message form (supported
  on `claude-opus-5`), not string interpolation into the top-level system prompt — this is
  both cache-preserving and injection-safe.
- The reasoning model has **no tools** in AURA. It cannot read the database, call an endpoint,
  or fetch a URL. A successful injection can only make it produce text — which is then
  schema-validated and filtered.
- Output is never `eval`'d, never rendered as HTML, and never used to build a query.

The strongest protection is architectural: a model with no tools and a validated output schema
has a very small blast radius.

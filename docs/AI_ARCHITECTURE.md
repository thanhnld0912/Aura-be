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

### As built (Phase 4, Tasks 2–3)

The layout above is the destination. What exists today is smaller, and the names differ:

```
server/src/ai/
├── providers/
│   ├── ai-provider.ts              # one interface: AiProvider
│   ├── fake-provider.ts            # scripted outcomes; the suite needs no API key
│   └── claude-provider.ts          # @anthropic-ai/sdk — the ONLY file importing it
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
| `daily`, `weekly`, `pattern`, `chat`, `plan` | `prompt_injection` |

`sensitive_crisis`, `unsafe_health_request` and `unsafe_food_behavior` exist in the type
and are active **nowhere**. That is deliberate, not an oversight:

> **Broad conversational crisis and health screening is deferred to the Agent layer
> (Task 8).** A meal-logging field is the wrong place for it. "đói chết đi được" and
> "I'm starving" are how people describe being hungry, and a classifier that treats them
> as distress makes the app unusable while helping no one. Screening belongs where
> somebody is actually talking to the app.

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
returned. There is **no medical classifier**, because there is no prose surface to apply
one to — `/meals/parse` returns structured data only. When a conversational surface
exists, its policy is Task 8's.

### Causal filtering — infrastructure, not yet wired

`filterCausalClaims(text)` is pure, deterministic, dependency-free, and **has no caller**.
Nothing in AURA generates prose today. It exists so that daily analysis, weekly analysis,
pattern narration and agent replies inherit the rule rather than each reinventing it;
actual consumption belongs to Phase 5 and Task 8.

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
| `PatternNarrationSchema`, `isEstimate`, `caveat` | Not built. Phase 5, with pattern narration. |
| Input crisis classifier | Deferred to Task 8, on purpose (above). |
| Output blocklist on dieting/appearance language | Not built. No prose surface to filter. |

---

## 7. Cost analysis (§26)

Pricing per million tokens (Anthropic first-party, re-verified 2026-09-10 against
[platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing)):

| Model | Input | Output |
|---|---|---|
| `claude-opus-5` | $5.00 | $25.00 |
| `claude-sonnet-5` | $2.00 | $10.00 |
| `claude-haiku-4-5` | $1.00 | $5.00 |
| `gemini-2.5-flash` | ~$0.30 | ~$2.50 |

The executable copy of this table is `src/ai/pricing.ts`, and it is deliberately shorter: only
`claude-haiku-4-5` and `claude-opus-5`, the two models `env.ts` is configured to call. A model
that is not in it prices as `null`, never as an approximation — including the Gemini row above,
whose `~` figures are planning estimates and not something to bill against. Rows get added when
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
| Vision unavailable | Photo mode degrades to "describe it instead" with the image still saved |
| Claude unavailable | Insights show the last cached value marked `stale: true` |
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

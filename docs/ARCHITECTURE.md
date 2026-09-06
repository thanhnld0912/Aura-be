# AURA — System Architecture

> Status: **proposed**, awaiting confirmation (Rule 16). No backend implementation has begun.
> Companion documents: `FRONTEND_AUDIT.md`, `DATABASE_DESIGN.md`, `API_DESIGN.md`,
> `AI_ARCHITECTURE.md`, `NUTRITION_ARCHITECTURE.md`, `PATTERN_ENGINE.md`, `SECURITY.md`,
> `DEPLOYMENT.md`, `IMPLEMENTATION_PLAN.md`.

---

## 1. What AURA is

AURA is not a calorie tracker and not a gym chatbot. It is a companion that **observes
behaviour over time and reflects it back**. The product value is not in any single log —
it is in the accumulated difference between what a person planned and what actually happened.

```
PLAN → LIVE DAY → LOG ACTUAL → COMPARE → ANALYZE → DISCOVER PATTERNS → SUGGEST → ADAPT NEXT PLAN
```

Three architectural consequences follow directly, and they drive every decision below:

1. **Planned and Actual are different data, never the same row** (Rule 9). A plan is an
   intention; an event is an observation. Overwriting one with the other destroys the
   product's only real signal.
2. **Patterns are computed from data, not remembered by a model** (Rule 8). Correlation
   over 30 days is a SQL problem. The LLM's job begins only after the numbers exist.
3. **Confidence and provenance are first-class columns, not metadata.** Every nutrition
   number AURA shows is an estimate from some source with some reliability, and the user
   must always be able to overrule it (Rules 6, 11).

---

## 2. Decisions taken

| Area | Decision | Rationale |
|---|---|---|
| Workspace | `AURA/` with `aura-companion/` + `server/` + `shared/` + `docs/` | Matches §30; frontend moved intact, byte-verified |
| Backend runtime | Node.js 22 LTS + TypeScript 5.8 (ESM) | Matches frontend toolchain; one language across the stack |
| HTTP framework | **Fastify 5** | TS-first, plugin encapsulation maps onto modular-monolith boundaries, ~2× Express throughput, first-class lifecycle hooks for auth/rate-limit |
| Database | **PostgreSQL 16** (Supabase) | Relational integrity for plan↔event↔meal; window functions and `CORR()` do the Pattern Engine's real work |
| ORM / query layer | **Drizzle ORM** | SQL-first and type-safe; drops to raw SQL without escape hatches — essential for the Pattern Engine's window functions; small bundle, fast cold start |
| Validation | **Zod 3** | One schema definition serving request validation, AI output validation, and shared types |
| Auth | **Supabase Auth** | Email + OAuth today, official Android SDK later (Rule 15); backend verifies JWT and owns all domain data |
| Storage | **Supabase Storage** | Meal photos out of Postgres (§22); same vendor as DB and auth |
| Reasoning AI | **Claude** (`claude-sonnet-5`) | Analysis, patterns, suggestions, chat |
| Vision AI | **Gemini** (`gemini-2.5-flash`) | Meal photo → food identification + portion estimation |
| Nutrition | **USDA FDC** + **Open Food Facts** + **Local VN DB** behind one interface | Rule 6: real data before model guesses |
| Architecture style | **Modular monolith** | Rule 14/§32: one deployable, module boundaries enforced in code, not over the network |

### Why not the alternatives

- **Not microservices.** At MVP the whole system is one team and one database. Splitting
  meals from patterns would turn a `JOIN` into an HTTP call and buy nothing.
- **Not Prisma.** The Pattern Engine's core is window functions, `LAG()`, `CORR()` and
  lateral joins. With Prisma that is `$queryRaw` — untyped strings — for the most important
  code in the product. Drizzle keeps it typed.
- **Not "Claude reads the database".** Sending 30 days of rows to an LLM is expensive,
  slow, and produces unreproducible statistics. Postgres computes; Claude narrates.

---

## 3. System diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            aura-companion (EXISTING)                         │
│                React 19 · Vite 6 · Tailwind 4 · TypeScript 5.8               │
│                                                                              │
│   TodayView   InsightsView   HistoryView   CrewView   AICoachView  LogModal   │
│        └───────────┴──────────────┴────────────┴──────────┴───────────┘       │
│                                     │                                        │
│                     src/services/  (API client · NEW)                        │
│                     src/adapters/  (domain → view-model · NEW)               │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │  HTTPS · REST · JSON
                                      │  Authorization: Bearer <supabase jwt>
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              server/  (NEW BACKEND)                          │
│                          Fastify 5 · TypeScript · Zod                        │
│                                                                              │
│  middleware:  auth · rate-limit · CORS · Helmet · validation · error · log   │
│  ──────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│  modules/          auth  users  daily-plans  daily-events  meals             │
│                    nutrition  workouts  habits  insights  patterns  groups   │
│                                                                              │
│  agent/            context/  analysis/  planning/  llm/                      │
│  ai/               providers/  prompts/  schemas/                            │
│  nutrition/        providers/  resolver  calculator                          │
│  patterns/         aggregation  detectors  ranking                           │
└──────┬──────────────────────┬───────────────────────┬────────────────────────┘
       │                      │                       │
       ▼                      ▼                       ▼
┌──────────────┐    ┌──────────────────┐    ┌────────────────────────┐
│  PostgreSQL  │    │   AI SERVICES    │    │     FOOD DATA          │
│  (Supabase)  │    │                  │    │                        │
│              │    │  Claude          │    │  USDA FoodData Central │
│  Storage     │    │   → reasoning    │    │  Open Food Facts       │
│   (photos)   │    │  Gemini Vision   │    │  Local VN food DB      │
│              │    │   → food recog.  │    │   (owned, seeded)      │
└──────────────┘    └──────────────────┘    └────────────────────────┘
```

Later, unchanged backend:

```
                  ┌── aura-companion (web)
                  │
   server API ────┼── Android
                  │
                  └── iOS
```

---

## 4. Request flow — the meal photo path

This is the most involved path in the system and demonstrates every architectural rule at once.

```
 1. User picks a photo in LogModal (photo mode — TO BE BUILT)
 2. POST /api/meals/analyze-image   multipart, ≤8 MB, jpeg/png/webp
 3. Middleware: verify JWT → rate-limit (AI bucket) → validate magic bytes → strip EXIF
 4. Upload to Supabase Storage        → returns storage key (NOT stored in Postgres as bytes)
 5. VisionProvider.identifyFoods()    → Gemini, structured output
 6. Zod validation of model output    ← untrusted until proven (Rule 10)
 7. FoodResolver: detected names      → local VN DB → USDA → OFF
 8. NutritionCalculator: portion × per-100g values → totals + per-item confidence
 9. Persist meals row  status='draft'  + ai_runs row (cost/latency/tokens)
10. 200 → MealDraft { items[], nutrition, confidence, source, imageUrl }
11. Frontend renders detection + confidence; user confirms or edits (Rule 11)
12. POST /api/meals/:id/confirm       → status='confirmed', user_confirmed=true
13. daily_events row created (type='meal') → feeds Plan vs Actual and the Pattern Engine
```

**Step 6 is non-negotiable.** Vision output is parsed, schema-checked, and rejected on failure.
An LLM response is input, not truth.

**Step 7 is Rule 6.** The model identifies *what* the food is; it never states its calories.
Nutrition comes from a database. If no provider can resolve an item, it is stored with
`source='unresolved'` and surfaced to the user rather than filled in with a guess.

---

## 5. Module boundaries

`server/src/modules/*` each follow the same four-file shape:

```
modules/meals/
├── meals.routes.ts      # Fastify plugin — HTTP only, no business logic
├── meals.schema.ts      # Zod — request, response, shared with frontend
├── meals.service.ts     # business logic — the only layer allowed to orchestrate
└── meals.repository.ts  # Drizzle queries — the only layer touching the DB
```

Enforced rules:

- Routes never touch the repository directly.
- A module's repository is private to it. Cross-module reads go through the owning service.
- `agent/` and `ai/` are called **only** by services, never by routes.
- `nutrition/` and `patterns/` are libraries: no HTTP awareness, no auth awareness.

This is what makes the monolith *modular*: if a module ever needs extracting, the seam is
already the service interface.

### The three layers that are not modules

| Directory | Role | Why separate |
|---|---|---|
| `ai/` | Raw provider adapters — Claude, Gemini. Knows nothing about AURA. | Swappable vendors |
| `agent/` | AURA's reasoning — context building, analysis, planning. Uses `ai/`. | Domain logic that happens to use an LLM |
| `patterns/` | Statistics over Postgres. **Contains no AI at all.** | Rule 8 — patterns are computed, then narrated |

The `patterns/` ↔ `agent/` split is the most important boundary in the system. Statistics
must be reproducible, testable and cheap. Narration must be warm and human. Mixing them
gives unreproducible statistics *and* robotic prose.

---

## 6. Data model core — Planned vs Actual (Rule 9)

```
daily_plans ──< plan_items          "what the user intended"
                    │
                    │  linked_event_id  (nullable, 1:1)
                    ▼
              daily_events           "what actually happened"
                    │
      ┌─────────────┼──────────────┬─────────────┐
      ▼             ▼              ▼             ▼
    meals       workouts      habit_logs     checkins
```

`plan_items` are never mutated by logging. Reconciliation writes `linked_event_id` and a
computed `adherence` (`on_time` / `shifted` / `substituted` / `not_logged`), leaving both
sides intact. This preserves the delta the whole product is built on.

**`daily_events` is the spine.** Every loggable thing is an event with a `type`
(`meal | workout | walk | sleep | water | habit | checkin | custom`) and a typed detail row.
Adding a future event type means one enum value and one detail table — never a schema rewrite
(§12).

---

## 7. AI cost discipline (§26)

The single rule: **AI runs on write and on schedule, never on read.**

| Trigger | Model | Frequency | Cached |
|---|---|---|---|
| Meal photo | Gemini Flash | per photo | draft reused if unconfirmed |
| Text meal parse | Claude Haiku | per text log | — |
| Daily insight | Claude Sonnet | ≤1×/day, after 20:00, only if the day has ≥2 events | `daily_summaries` |
| Weekly insight | Claude Sonnet | 1×/week, Sunday cron | `weekly_summaries` |
| Pattern narration | Claude Sonnet | only when a *new* pattern crosses threshold | `patterns.narrative` |
| Chat | Claude Sonnet | per user message | — |

Opening the Home tab performs **zero** AI calls; it reads `daily_summaries`. Full modelling
in `AI_ARCHITECTURE.md` §7 — projected steady-state cost is roughly **$0.02–0.05 per active
user per month**.

---

## 8. Where serverless breaks (§25)

Most of the API is short-lived and serverless-friendly. Three workloads are not:

| Workload | Duration | Problem |
|---|---|---|
| Meal photo analysis | 3–10 s | Near serverless timeouts; upload + vision + 2 nutrition lookups |
| Weekly analysis | 20–60 s / user | Exceeds most function timeouts outright |
| Sunday batch | minutes | Needs a scheduler and retries |

**Recommendation:** deploy the API to an always-on container (Railway or Render), not to
Vercel functions. Cold starts hurt AI latency, and connection pooling against Postgres is
simpler. At MVP scale a single container plus `pg_cron` (or one scheduled job) is sufficient
— **do not introduce a queue and workers yet**. The trigger to add BullMQ + Redis is when
p95 weekly-analysis latency blocks requests or a single user's batch exceeds ~60 s.
Detail in `DEPLOYMENT.md`.

---

## 9. Frontend contract (Rules 3, 4, 5)

```
✅  aura-companion → HTTPS → server → Postgres / Claude / Gemini / USDA
❌  aura-companion → Postgres
❌  aura-companion → Claude or Gemini
```

`ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `USDA_API_KEY` exist **only** in `server/.env`.
The frontend holds only `VITE_API_BASE_URL`, `VITE_SUPABASE_URL` and the Supabase **anon**
key (a public client key by design, protected by Row Level Security).

Removing `@google/genai` from the frontend `package.json` (`FRONTEND_AUDIT.md` §7) makes
Rule 4 structurally impossible to violate rather than merely discouraged.

---

## 10. `shared/`

```
shared/
├── types/     # domain models — Meal, DailyEvent, Pattern, Insight
└── schemas/   # Zod schemas the API validates with and the client infers from
```

Consumed by both sides via path alias. The rule: **`shared/` contains no runtime dependency
beyond Zod** — no DB imports, no Fastify, no React. If it cannot run in a browser and in Node,
it does not belong there.

At MVP this is a plain directory referenced by relative path, not an npm workspace package.
Promote it to a workspace only when the Android client needs to consume it independently.

---

## 11. Trade-offs accepted

| Decision | Cost | Why accepted |
|---|---|---|
| Modular monolith | Scales vertically only | One team, one DB. Extraction seams exist if needed. |
| Supabase Auth | Vendor coupling for identity | Android SDK saves weeks (Rule 15). Domain data stays in our schema, keyed by uid — migrating auth later does not touch it. |
| Drizzle over Prisma | Smaller ecosystem, manual migrations | Pattern Engine needs real SQL. Typed window functions beat generated CRUD here. |
| Two AI vendors | Two SDKs, two failure modes | Gemini Flash is markedly cheaper for vision; Claude is stronger at careful, hedged reasoning. Both sit behind interfaces. |
| Photos in object storage | Extra network hop, signed URLs | Postgres is not a blob store (§22). |
| No queue at MVP | Weekly analysis blocks a worker | Avoids Redis + worker + retry infrastructure for a Sunday job. Documented trigger to revisit. |
| Nutrition estimates | Never perfectly accurate | Honesty over false precision — every number carries source + confidence and is user-editable (§10). |

---

## 12. Non-goals for MVP

Explicitly out of scope, recorded so they are not accidentally built:
microservices · Kafka/event sourcing · Kubernetes · GraphQL · real-time websockets ·
offline-first sync · wearable integrations · multi-tenancy · i18n framework
(the UI is deliberately bilingual VN/EN in copy, not machine-translated).

# AURA — Implementation Plan

> Phase 0 is complete. Phases 1+ begin only once this architecture is confirmed (Rule 16).

---

## Phase 0 — Audit ✅ COMPLETE

- [x] Repository audited — frontend was the repo root, not a container
- [x] Frontend audited — 13 files, ~3,217 lines, no backend/DB/API/AI/auth/persistence
- [x] 16 integration points identified
- [x] `activeMode` found to be decorative — photo and quick-add modes do not exist
- [x] Workspace promoted to `AURA/`; frontend moved intact (22 files, MD5-verified)
- [x] `git init`, `docs/`, `shared/`, `server/` skeleton created
- [x] Ten architecture documents written

**Outcome:** the frontend is a high-fidelity prototype with no data layer to unpick. The
backend fills a vacuum rather than retrofitting around prior decisions.

---

## Phase 1 — Backend foundation

**Goal:** a running, secured, observable Fastify server that does nothing yet.

- `server/` — TypeScript ESM, Fastify 5, Vitest, tsx watch
- `config/env.ts` — Zod-parsed config, fails loudly at boot
- Middleware: Helmet, CORS allowlist, rate limiting, request ID, pino logging
- Global Zod validator + serializer compilers (an unvalidated route cannot register)
- Uniform error envelope + typed `AppError` hierarchy
- `GET /api/health` with DB check
- Drizzle + migration tooling; Docker Compose for local Postgres
- GitHub Actions: typecheck, test, `npm audit`, gitleaks

**Also, on the frontend (small, isolated):** commit `package-lock.json` (audit risk R1),
add `"include": ["src"]` to `tsconfig.json`, remove the 6 unused scaffold deps, rename the
package to `aura-companion`.

**Done when:** `/api/health` returns 200 in CI, and a malformed request returns the documented
error envelope.

---

## Phase 2 — Core data

**Goal:** the Planned-vs-Actual spine exists and is exercisable.

- Schema + migrations: `users`, `user_preferences`, `daily_plans`, `plan_items`,
  `daily_events`, `meals`, `meal_items`, `foods`, `food_portions`, `workout_sessions`,
  `workout_exercises`, `habits`, `habit_logs`, `checkins`
- Supabase Auth: JWT verification, JIT user provisioning, `POST /api/auth/session`
- RLS policies + policy tests
- Modules: `auth`, `users`, `daily-plans`, `daily-events`, `checkins`
- **Reconciliation engine** — `plan_items.adherence` (`on_time`/`shifted`/`substituted`/
  `not_logged`), never mutating the plan
- `daily_summaries` recompute on write
- Seed: system habits

**Done when:** a plan can be created, an event logged, and
`GET /api/daily-plan/comparison` returns a correct `shifted`/`substituted` classification.

**This is the phase that most determines whether AURA works.** Everything downstream —
patterns, insights, the weekly story — is a function of the plan/actual delta being modelled
correctly. Do not rush it to reach the AI phases.

---

## Phase 3 — Nutrition

**Goal:** real nutrition numbers with provenance, no AI involved.

- `NutritionProvider` interface + resolver chain
- `LocalFoodProvider` + **~300-row Vietnamese food dataset with `food_portions`** ← the long pole
- `UsdaProvider`, `OpenFoodFactsProvider` (with the required User-Agent), caching into `foods`
- `pg_trgm` fuzzy matching over diacritic-stripped names
- `FoodResolver` (7-step chain), `PortionResolver`, `NutritionCalculator`
- Confidence assembly (weighted-minimum meal confidence)
- `user_food_aliases` learning loop
- Endpoints: `/nutrition/search`, `/barcode/:code`, `/calculate`, `/daily`
- `POST /api/meals` (quick add / manual) + `/meals/:id/confirm`

**Done when:** `"2 chén cơm + thịt kho"` resolves to real grams and real macros with per-item
sources, and an unresolvable item returns `kcal: null` rather than a guess.

**Budget realistically for the dataset.** Authoring 300 Vietnamese foods with credible
per-100g values and household portions is genuine research work, not data entry. It is also
the single highest-leverage asset in the product — no competitor's USDA-only tracker can
resolve *cá kho tộ*.

---

## Phase 4 — AI

**Goal:** vision and reasoning, both schema-validated.

- `ai/providers/` — `claude-provider` (`messages.parse` + `zodOutputFormat`),
  `vision-provider` (Gemini), registry with fallback + circuit breaker
- `ai/schemas/` — Zod for every model output; enums that exclude judgmental vocabulary
- `ai.service.ts` — call, validate, retry once, meter into `ai_runs`
- Prompt files, versioned; tone calibrated to the existing UI copy (`FRONTEND_AUDIT.md` §3.4)
- Safety: input classifier, output blocklist, crisis routing, causal-language filter
- `agent/context/` — context builders (~800–1,500 tokens, never raw rows)
- `agent/analysis/` — meal, behaviour, adherence analyzers
- Endpoints: `/meals/parse`, `/meals/analyze-image`, `/agent/chat`, `/agent/analyze-day`
- Image pipeline: magic bytes → `sharp` re-encode → EXIF strip → Supabase Storage → signed URLs
- Prompt caching with a stable system-prompt breakpoint

**Done when:** a photo produces a validated draft with per-item confidence, a schema failure
produces `422` rather than corrupt data, and `ai_runs` shows real cost per call.

---

## Phase 5 — Pattern Engine

**Goal:** statistics that earn the right to be narrated.

- Nightly `daily_summaries` aggregation job
- Detectors: correlation (curated pairs only), trend, timing/conditional, frequency/streak
- Gating: n ≥ 10, |r| ≥ 0.45, variance > 0, coverage ≥ 70%, p < 0.10
- Ranking, lifecycle (candidate → active → stale/dismissed)
- `evidence` series stored for the chart
- Narration of newly-active patterns only, with required `caveat`
- `weekly_summaries` + weekly narrative, Sunday cron
- Endpoints: `/patterns`, `/patterns/:id/series`, `/patterns/:id/dismiss`, `/insights/*`
- **Synthetic fixture tests — including the random-noise fixture that must yield nothing**

**Done when:** the noise fixture produces zero patterns in CI, and a real correlation produces
a narrative containing no causal verbs.

---

## Phase 6 — Frontend integration

**Goal:** the existing UI, unchanged in appearance, running on real data.

Order matters — one vertical slice proves the whole stack before breadth:

1. **Infrastructure:** `src/services/api-client.ts` (auth header, refresh, error mapping),
   TanStack Query provider, `src/adapters/` domain→view-model mappers, error boundaries,
   loading skeletons
2. **Auth:** Supabase client, login/signup, session handling, 401 → re-auth
3. **Vertical slice — meals:** split `LogModal.tsx` into `LogModal/` **first** (audit R3), then
   wire describe mode → `/meals/parse`, portions → `/nutrition/calculate`, save → `/meals`
4. **Build the two missing UIs:** photo mode and quick-add mode (audit §6.1) + `ConfidenceBadge`
5. **Read paths:** Today timeline, Plan vs Actual, History
6. **Check-ins, insights, patterns, chat**
7. **Groups**

**Constraints throughout:** no visual redesign, no component rewrites, no new top-level views,
no changes to `index.css`. Components keep their current props; only the source of those props
changes.

**Done when:** every one of the 16 audited integration points is live and `initialData.ts` is
used only by tests.

---

## Phase 7 — Weekly story & insights polish

Weekly reels from real `weekly_summaries`, correlation chart from `evidence`, insight feedback
loop (`ai_feedback`), stale-insight handling, empty and cold-start states (0–6 days of data).

---

## Phase 8 — Groups

Group creation, invite codes, membership, feed, reactions, cheers.
**The privacy constraint is the feature here:** activity titles and streaks only, enforced in
the repository layer.

---

## Phase 9 — Android readiness

No new backend features — verification that the existing API is sufficient:
`shared/` promoted to a consumable package, OpenAPI spec generated from the Zod schemas,
pagination and idempotency verified under mobile conditions, Supabase Auth Android SDK flow,
signed-URL expiry behaviour on slow connections, offline-friendly error semantics.

If Phases 1–8 respected Rules 3, 4, 5 and 15, this phase is validation rather than work.

---

## Sequencing notes

**Dependency order is real for 1→2→3.** Phase 4 depends on 3 (AI needs somewhere to send
resolved food), Phase 5 depends on 2 (patterns need the plan/actual delta). Phase 6 can begin
its infrastructure work (step 1–2) in parallel with Phase 4 — the API client and adapters do
not depend on AI existing.

**Recommended parallelisation if more than one person is working:** the Vietnamese food
dataset (Phase 3) is independent research work that can run alongside Phases 1–2 from day one.
It is the most likely thing to become the critical path.

---

## Definition of done, applied to every phase

- Zod validation on every input; typed errors out
- `userId` from the token, never from input
- Tests: unit for pure logic, integration for endpoints, fixtures for detectors
- Migrations reviewed and committed, never auto-pushed
- No secret outside `server/.env`
- Docs updated when the design changes — these documents are the contract, not a snapshot

---

## Open questions for you

1. **Timeline and team size.** The plan is written as a sequence, not a schedule. Phase 3's
   food dataset in particular scales with how much research time is available.
2. **Vietnamese food data sourcing.** Do you have access to Vietnamese National Institute of
   Nutrition composition tables, or should the seed be built from USDA component
   approximations with `dataQuality: 'medium'` and improved over time?
3. **Groups priority.** Phase 8 is currently last, but `CrewView` is fully built. If the
   social loop matters for early retention, it could move ahead of Phase 7 — it needs no AI.
4. **Age range.** `SECURITY.md` §7 sets a 13+ gate. If AURA is aimed at school-age users,
   minors-privacy needs a deliberate review before launch rather than after.

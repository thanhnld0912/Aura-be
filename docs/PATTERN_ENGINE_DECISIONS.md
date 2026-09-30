# AURA — Pattern Engine: Canonical Decisions

> Scope: the specification questions that block Phase 5.2+ implementation, resolved from the
> repository where the repository settles them, and marked **OPEN** where it does not.
> Companion to `PATTERN_ENGINE.md` (design), `DATABASE_DESIGN.md` §3.7/§3.11 (storage) and the
> Phase 5.1 code in `server/src/patterns/`. Nothing here changes a statistical threshold.
>
> Status legend: **RESOLVED** — settled by existing evidence, cited. **RESOLVED (conservative)** —
> the documents give no rule, so the safe behaviour already built is kept and declared canonical.
> **OPEN** — requires a product or statistical decision; implementation that depends on it waits.

## Summary

| # | Question | Status | Blocks |
|---|---|---|---|
| D1 | Bedtime across midnight | Representation RESOLVED · cut-off hour **OPEN** | `bedtime_min` in any detector |
| D2 | `breakfast_logged` on an observed day with no meal | **RESOLVED → 0** (amends 5.1) | — |
| D3 | `partial` workout sessions | **RESOLVED → 0** (amends 5.1) | — (data has no write path) |
| D4 | Several planned workouts in a day | RESOLVED (conservative) → null | — |
| D5 | Vegetable / protein servings | **BLOCKED — OPEN** | `vegetable_servings`, `protein_servings`, pair 6 |
| D6 | Detector output vs persisted pattern vs consumer view | Contract RESOLVED · `support`, caveat copy, `narrativeEn` **OPEN** | table migration details |
| D7 | Frequency vs streak | **RESOLVED** — one detector family, two kinds | — |
| D8 | Duplicate `mood_score ↔ plan_adherence_pct` pair | **RESOLVED** — one undirected test | — |
| D9 | Trend "slope materially different from zero" | Statistical part RESOLVED (implied by R²) · magnitude **OPEN** | trend detector |
| D10 | Ranking `recency_weight`, `actionability` | **OPEN** | ranking, lifecycle promotion order |
| D11 | Scheduler timezone | **RESOLVED** — one global trigger, per-user closed-day semantics | — |
| D12 | `weekly_summaries`, `insights`, `ai_feedback` scope | **RESOLVED** — boundary below | — |
| D13 | Noise fixture vs frequency/streak | **RESOLVED** — noise fixture covers inferential detectors | — |
| D14 | Data source per detector | **RESOLVED** | — |
| D15 | Plan-change recomputation | **RESOLVED** — nightly job is authoritative for closed days | — |
| D16 | Frequency/streak emission threshold and cold-start day count | **OPEN** (found during this review) | frequency/streak detector |

---

## D1 — Bedtime across midnight

**Decision.** The canonical bedtime for detection is a *sleep-day* value, not the Phase 5.1 clock
value: a bedtime belongs to the **day it precedes** (the day the person wakes up on), measured in
minutes from midnight at the start of the **previous** calendar day, so it runs past 1440 for
bedtimes after midnight. The cut-off hour that separates "last night's bedtime" from "a sleep
starting today" is **OPEN**. Until it is set, `bedtime_min` is excluded from every detector.

**Rationale.** The design already uses this representation in its own worked example, even though
it never states the rule: `PATTERN_ENGINE.md` §6 stores evidence points
`{ "date": "2026-08-20", "subject": 1425 }` and `{ "date": "2026-08-21", "subject": 1502 }`. 1502 is
25:02 — only meaningful as minutes past the *previous* midnight — and it sits on the row whose
`object` (breakfast) belongs to that same morning. §5 narrates the pair as "the days you slept after
23:45 … breakfast was logged later or not at all", which pairs a night with the **following**
breakfast. The Phase 5.1 metric (`bedtime` = earliest sleep event on the event's own `local_date`,
0–1439) cannot express either property: 23:30 on the 20th and 00:30 on the 21st land on different
rows at 1410 and 30, and the earliest sleep event of a day can be the *previous* night's late sleep.
What the documents do not give is the cut-off: without one, a 05:00 or 14:00 sleep event cannot be
classified as a late bedtime or a nap.

**Canonical behaviour.**
- Representation: `bedtime_sleepday_min = minutes since 00:00 of (wakeDay − 1)`; e.g. 23:45 → 1425,
  01:02 → 1502. Attributed to `wakeDay`.
- Classification of a sleep event as "the night before `wakeDay`" requires the **OPEN** cut-off
  (a local clock time C: a sleep starting in `[C on D−1, C on D)` is the bedtime for `wakeDay = D`).
- The Phase 5.1 `bedtime_min` (clock, event day) stays as it is — correct as a clock reading — and
  keeps `scale: 'clock'`; no detector may use it linearly.
- Pairing with `breakfast_logged` is same-row on the **wake day**, which the sleep-day attribution
  makes true by construction.

**Examples.** Sleep at 23:30 on 20 Aug → wake day 21 Aug, value 1410. Sleep at 00:30 on 21 Aug →
wake day 21 Aug, value 1470. Both describe the night before 21 Aug's breakfast; the gap between them
is 60 minutes, not 1380.

**Impact on detectors.** Correlation pair 1 (`bedtime_min ↔ breakfast_logged`) and any trend on
bedtime are **blocked** until the cut-off is decided. Implementing the sleep-day value will require a
new derived day fact (stored in `daily_summaries.metrics`, no migration) and a change to how the
summary picks the night's sleep event — an amendment to Phase 5.1 derivation, to be made together
with the cut-off. `sleep_minutes` has the same attribution question (it sums sleeps *started* on the
day); pair 2 inherits it, but that pair is also data-blocked (D3).

**Impact on tests.** When unblocked: 23:30/00:30 on either side of midnight land on the same wake
day with a 60-minute difference; the earliest-event trap (a late sleep and an evening sleep on one
calendar day) is attributed to two different wake days; values ≥ 1440 are accepted by the series and
coverage code; the clock metric keeps its current tests.

## D2 — `breakfast_logged`

**Decision.** On an **observed** day (`events_logged > 0`), `breakfast_logged` is `1` if the first
confirmed meal is strictly before 10:30, otherwise `0` — **including a day with no meal logged**.
On an unobserved day it is `null`. This amends Phase 5.1, which returns `null` for an observed day
with no meal.

**Rationale.** The metric measures *logging*, as its name says, and the design treats "not logged"
as an outcome: §5's approved narration is "bữa sáng được ghi nhận muộn hơn hoặc không được ghi"
("logged later or not logged"), and `API_DESIGN.md` §14 renders it as "a later or unlogged
breakfast". An observed day with no breakfast in the log is therefore a measured 0 — the same
standing `meals_logged = 0` already has on an observed day (`PATTERN_ENGINE.md` §2.1). A day with no
log at all says nothing and stays `null`, so missing ≠ zero is preserved.

**Canonical behaviour.** `observed && firstMeal < 630 → 1`; `observed && (no meal || firstMeal ≥ 630)
→ 0`; `!observed → null`. Narration must say "logged", never "ate" or "skipped".

**Examples.** Walk logged, no meal → 0. First meal 10:29 → 1; 10:30 → 0. Nothing logged → null.

**Impact on detectors.** Coverage of `breakfast_logged` equals the observed days; correlation pair 1
gains the no-meal days as 0 (once D1 unblocks it); a trend on it is a trend in breakfast *logging*;
frequency may report its rate.

**Impact on tests.** Replace the Phase 5.1 unit test "leaves breakfast unknown on a day with no meal
logged" and the integration assertion in "does not count a draft" with the 0 rule; keep the
unobserved-day null test.

## D3 — Workout completion

**Decision.** Per day: any `completed` session → `1`; sessions exist but none `completed` (only
`partial` and/or `skipped`) → `0`; no session → `null`. This amends Phase 5.1, which returns `null`
for a partial-only day.

**Rationale.** The repository never counts `partial` as completed: the weekly report keeps
`completed`, `partial` and `skipped` as separate counts (`weekly-report.ts`, `activity.workoutSessions`), and
the parallel habit metric's completion rate counts `done` only, with `partial` outside it
(`weekly-report.ts` habits, `API_DESIGN.md` §11). `workout_completed` is defined as "0/1 from
`workout_sessions.status`" (`PATTERN_ENGINE.md` §2), so a logged session that did not reach
`completed` is a measured 0. Partial is still *activity* — `activeDays` counts it — which is a
different metric and unaffected.

**Canonical behaviour.** Multiple sessions: the day is 1 if any is completed. A deleted event's
session is ignored (5.1 already scopes to live events).

**Examples.** `[completed]` → 1 · `[partial]` → 0 · `[partial, skipped]` → 0 · `[skipped, completed]` → 1 · `[]` → null.

**Impact on detectors.** Pairs 2 and 3 and the timing detector's completion rate read this value.
All are **data-blocked**: no endpoint writes `workout_sessions` (`API_DESIGN.md` §19 "have their
tables but not their endpoints"; `POST /api/events` rejects `workout`). Detectors may be built and
tested on fixtures; in production they will see only nulls until `/api/workouts` exists.

**Impact on tests.** Change the Phase 5.1 unit expectations for `['partial']` and
`['partial','skipped']` from null to 0.

## D4 — `workout_planned_time` with several planned workouts

**Decision (conservative).** 0 planned → `null`; exactly 1 → its `planned_time` in minutes; 2+ →
`null`. This is the Phase 5.1 behaviour, now canonical.

**Rationale.** The timing detector splits *days* by "the" planned time (§3.3). No document names a
rule for choosing among several; picking the earliest, latest or mean would each change which days
count as "late" and would be an invented rule.

**Impact.** Multi-workout days fall out of the timing detector's sample. If product later defines a
per-*item* timing analysis, it would read `plan_items` directly (D14), not this day metric.
**Tests:** unchanged.

## D5 — Serving definitions

**Decision.** **BLOCKED — OPEN, requires a product/nutrition decision.** `vegetable_servings` and
`protein_servings` stay `null`. Correlation pair 6 (`distinct_foods ↔ vegetable_servings`) is
disabled.

**Rationale.** No authoritative definition exists. `foods.category` is a *dish* category from the
seed (`vegetable`, `meat`, `seafood`, `egg`, `tofu_bean`, `soup`, …), not a food group: "canh cải
thịt bằm" is one dish holding both, and a category says nothing about quantity.
`NUTRITION_ARCHITECTURE.md` §3's category table is a dataset overview, and §8 lists "vegetable
servings" as a signal without defining it. The as-built `GET /api/nutrition/daily` `focus` object
omits both fields. Counting `category = 'vegetable'` items would be a new metric ("vegetable
dishes"), not a serving count, and would be invented.

**What Phase 5 can use instead.** `distinct_foods` (available), `meals_logged`,
`first_meal_min`/`last_meal_min`, and item-level repetition for the frequency detector (D14). The
decision needed to unblock: a food-group taxonomy (which foods, or which share of a dish, count) and
a serving unit (grams per serving by group, or portion-based).

**Tests.** Keep the existing "always null" tests; add a test that pair 6 is not evaluated while
either metric is `undefined_definition`.

## D6 — Detector output, persisted pattern, consumer view

**Decision.** Four objects, each owning its fields:

| Object | Owner | Fields |
|---|---|---|
| **DetectorResult** (pure, per recompute) | detectors | `key`, `kind`, `subjectMetric`, `objectMetric \| null`, `direction`, `strength` (−1..1), `pValue \| null`, `sampleSize` (n), `coverage` (§2.2), `windowDays`, `windowEnd`, kind-specific stats (R², slope, group rates/n), `evidence` (the chart series) |
| **PersistedPattern** (`patterns` row) | lifecycle | DetectorResult fields + `id`, `userId`, `status`, `score`, `firstDetectedAt`, `lastComputedAt`, and the timestamp the status last changed |
| **PatternEvidence** (existing `patternEvidenceSchema`) | consumers | projection of an `active` PersistedPattern + `subjectLabel`/`objectLabel` + `caveat` |
| **API pattern** (`GET /api/patterns`) | route | PatternEvidence + `narrative` (nullable) |

- **Evidence:** `evidence` series, `sampleSize`, `coverage`, `pValue`, `strength`, stats.
- **Lifecycle state:** `status`, `score`, the timestamps. `score` is persisted because the consumer
  orders by it (`selectPatternEvidence`), but its formula is **OPEN** (D10).
- **Narration:** `narrative`, `narrativeEn`.
- **Derived, not persisted:** `subjectLabel`/`objectLabel` come from `METRICS[key].label` at read time,
  so relabelling needs no data change.
- **`key`:** deterministic identity — kind, then the metric keys (pairs in canonical order, D8), then
  any condition (e.g. the timing split). Unique with `(user_id, key, window_days)` as designed.

**Field mismatches and their resolution.**

| Field | Where | Resolution |
|---|---|---|
| `coverage` vs `support` | schema has `coverage`; table/API have `support` | Persist **`coverage`** — the only one defined (§2.2), and the one the gate uses. `support` has no definition: the `API_DESIGN.md` §14 example (`sampleSize 14, windowDays 30, support 0.75`) is not coverage (14/30 = 0.47). **OPEN:** define `support` or drop it from the table/API design. |
| `score` | schema only | Persist on the table (lifecycle); formula OPEN (D10). |
| `subjectLabel`/`objectLabel` | schema only | Derived from the metric catalog; not stored. |
| `caveat` | schema + API required; table absent | Engine-owned deterministic text per `kind` × locale, never model-authored (`AI_ARCHITECTURE.md`). The only authored text is the English correlation caveat in `API_DESIGN.md` §14. **OPEN (copy):** Vietnamese text, and texts for trend, timing, frequency, streak. |
| `pValue`, `n` | schema `pValue`/`sampleSize`; table `p_value`/`sample_size` | Same fields, naming only. `pValue` null for frequency/streak (no test). |
| `narrativeEn` | API only | **OPEN:** whether both locales are stored, or one per user `locale`. Not needed before narration. |
| status timestamp | spec requires "stale 30 d → deleted", "dismissed excluded 60 d" | The table needs a status-changed timestamp to evaluate those rules; add it with the table. |

**Impact on tests.** Detector tests assert DetectorResult only; lifecycle tests assert
PersistedPattern transitions; the existing `pattern-evidence.test.ts` remains the consumer contract.

## D7 — Frequency vs streak

**Decision.** **One detector family, two pattern kinds.** The four detector families are those of
`PATTERN_ENGINE.md` §3 ("four detector families": correlation, trend, timing/conditional,
frequency/streak). The kinds are the five already canonical in `DATABASE_DESIGN.md`
(`correlation|trend|streak|frequency|timing`) and in code (`PATTERN_KINDS`). No new kind is created.

**Canonical behaviour.** The frequency/streak detector emits `kind: 'streak'` for current/longest runs,
and `kind: 'frequency'` for repetition and distributions (most-repeated foods, weekday/weekend
logging split, skip-reason distribution). Both have `pValue: null`, `objectMetric` as applicable,
and an `evidence` payload describing the counts they state.

**Impact.** Ranking's actionability (D10) can distinguish them. Emission thresholds are OPEN (D16).

## D8 — Duplicate correlation pair

**Decision.** Correlation is **undirected**: one test per unordered pair. The duplicate
`['plan_adherence_pct', 'mood_score']` is removed from the evaluated list.

**Canonical behaviour.**
- **Pair key:** the two metric keys sorted lexicographically — `correlation:mood_score:plan_adherence_pct`.
- **Orientation for display/narration:** the first listing in `PATTERN_ENGINE.md` §3.1 wins
  (`mood_score` is the subject). Orientation never changes the statistic.
- **Deduplication:** building the pair list from `CORRELATION_PAIRS` drops any pair whose sorted key
  is already present.
- **Variance:** Pearson *r* is undefined when either series is constant, so both series must vary; the
  documented `subject_sd > 0` gate is kept and the object side is covered by *r* being defined.

**Evaluated pairs after D1/D3/D5.**

| # | Pair | Status |
|---|---|---|
| 1 | `bedtime_min ↔ breakfast_logged` | blocked (D1) |
| 2 | `sleep_minutes ↔ workout_completed` | data-blocked (D3), attribution (D1) |
| 3 | `workout_planned_time ↔ workout_completed` | data-blocked (D3) |
| 4 | `mood_score ↔ plan_adherence_pct` | **ready** |
| 5 | `logging_gap_hours ↔ meals_logged` | **ready** |
| 6 | `distinct_foods ↔ vegetable_servings` | blocked (D5) |

**Impact on tests.** A test that the pair list has no two entries with the same sorted key, and that
swapping subject and object yields the same r and p.

## D9 — Trend significance

**Decision.** The *statistical* test is resolved; the *magnitude* test is **OPEN**.

**Rationale.** For a simple linear regression the slope's t-test p-value equals the p-value of
Pearson *r* between the metric and time, and R² = r². At n = 14, R² ≥ 0.3 means |r| ≥ 0.548, t(12) ≥
2.27, two-tailed p ≈ 0.043; the critical |r| only falls as n grows. So the documented gates
`n ≥ 14` and `R² ≥ 0.3` already imply p < 0.05 — and therefore also the lenient p < 0.10 used
elsewhere in the engine. A separate alpha cannot reject anything those gates accept. What "slope
materially different from zero" can still add is a **practical magnitude** (a minimum change per
week, in the metric's own units), and no document gives one.

**Canonical behaviour.**
- Minimum n = 14 observed days; R² ≥ 0.3 (unchanged).
- x is the **calendar-day offset** within the window, not the observation index — gaps must not
  compress time (consistent with coverage, §2.2). Missing days are skipped, never interpolated.
- Only metrics whose scale is linear may be trended (not `clock` until D1; not `binary`).
- **OPEN:** minimum practical slope per metric (or none).

**Impact.** The trend detector can be implemented with the n and R² gates; it must not emit until the
magnitude question is answered or explicitly waived. Cold start still puts trends at 30+ days (§7).

## D10 — Ranking

**Decision.** **OPEN — requires a product decision.** The formula's structure is documented
(`0.4·|strength| + 0.3·min(n/30,1) + 0.2·recency_weight + 0.1·actionability`), the two terms are not.

**Information required before ranking is implemented.**
1. `recency_weight` ∈ [0,1]: what is measured — e.g. the share of evidence points in the last 14 days,
   or whether the pattern also holds on the last 14 days alone — and how it maps to [0,1].
2. `actionability` ∈ [0,1] per kind: the order is given ("timing/frequency > abstract correlation"),
   the values and where trend and streak sit are not.
3. `|strength|` for kinds without *r*: frequency and streak need a defined strength in [0,1].
4. Tie-break: the consumer already breaks ties by n then id (`selectPatternEvidence`); confirm.

Until then, lifecycle may promote and list patterns without a score; `score` must not be fabricated.

## D11 — Scheduler timezone

**Decision.** **One global trigger** at `CRON_TIMEZONE` (default `Asia/Ho_Chi_Minh`, `DEPLOYMENT.md`
§6), processing every user with **per-user local-date semantics**: each run recomputes, for each
user, their most recent **closed** local day (`addLocalDays(todayIn(user.timezone), -1)`). Triggering
at 02:00 in each user's own wall clock is a **later architectural decision**, not Phase 5.

**Rationale.** The operational documents specify one scheduled job in one timezone
(`DEPLOYMENT.md` §6; `ARCHITECTURE.md` "a single container plus `pg_cron` (or one scheduled job)"),
and the env schema already carries `CRON_ENABLED`/`CRON_TIMEZONE`. `PATTERN_ENGINE.md` §8's "02:00
local" is satisfied for the product's primary market and, more importantly, correctness does not
depend on the trigger time: `lib/local-date.ts` resolves "yesterday" per user, and a closed day is a
function of the user's clock, not the server's. Per-user triggering needs bucketing by timezone or a
queue, which `ARCHITECTURE.md` explicitly defers.

**Impact.** Jobs must be idempotent per `(user, localDate)` and isolate failures per user
(`DEPLOYMENT.md` §6). A user far from UTC+7 may see yesterday's patterns a few hours later than at
their own 02:00 — acceptable, never wrong.

## D12 — Weekly scope

**Decision.**

| Item | Phase | Evidence |
|---|---|---|
| `patterns` table, detectors, gating, ranking, lifecycle, evidence, `/patterns*` | **5** | `IMPLEMENTATION_PLAN.md` Phase 5 |
| Pattern narration (`PatternNarrationSchema`, newly-active only) | **5**, last, optional-AI | Phase 5; `AI_ARCHITECTURE.md` "Phase 5, with pattern narration" |
| `weekly_summaries` + Sunday weekly narrative | **5 tail** — after the pattern core; separable | Phase 5 lists it; `API_DESIGN.md` §13 "As built" keeps the design "for the Phase 5/7 work it describes" |
| `insights` table, `/insights/today`, `/insights/:id` | **5 tail** | Phase 5 `/insights/*` |
| `ai_feedback`, `POST /insights/:id/feedback`, feedback loop | **7** | Phase 7: "insight feedback loop (`ai_feedback`)" |
| Weekly reels from `weekly_summaries`, correlation chart, stale-insight handling | **7** | Phase 7 |

The existing deterministic `GET /api/insights/weekly` and on-request story stay as they are; the
pattern core only replaces `NO_PATTERN_ENGINE` behind `PatternEvidenceSource`. Lifecycle must leave
room for the §4 rule that `ai_feedback.rating = 'wrong'` forces recomputation, but implementing that
input belongs to Phase 7.

## D13 — Noise fixture vs frequency/streak

**Decision.** **Option A.** The random-noise fixture ("pure random noise, n = 30 → no pattern
emitted", §9) applies to the **inferential** detectors — correlation, trend, timing. Frequency/streak
is tested with its own fixtures.

**Rationale.** §3.4 defines frequency/streak as "no inference required, so no significance test": a
streak of 30 logged days is a fact about the log, not a claim that can be spurious, and randomising
values does not make it false. Inserting gaps to suppress it (option B) would be tuning the fixture
to the detector, and would silently test less. The noise fixture's purpose — "a pattern engine that
finds structure in random data" — is about inferred structure.

**Testing strategy.**
- Noise fixture: 30 complete days, values from a **seeded** PRNG; assert zero correlation, trend and
  timing results across all evaluated pairs. Fixed seeds are mandatory: at n = 30 the |r| ≥ 0.45
  gate corresponds to p ≈ 0.013 per pair, so a random draw passes some gate a few percent of the time;
  the test pins seeds and must never be "fixed" by changing a threshold.
- Frequency/streak fixtures: a known run length, a known repeated food, a known weekday split — each
  asserting exactly the fact present. On the noise fixture, frequency/streak may only report facts
  that are true of it.

## D14 — Data source per detector

**Decision.** `daily_summaries` (through `extractDailyFeatures`) is the source for every **per-day
numeric series**; item-level **distributions** are read as SQL aggregates from their own tables.
No second per-day aggregation pipeline.

| Detector / output | Source |
|---|---|
| Correlation, trend | `daily_summaries` → `extractDailyFeatures` → `seriesFor` |
| Timing (planned time × completion) | `daily_summaries` (`workout_planned_time`, `workout_completed`) |
| Streak (logging runs), weekday/weekend split | `daily_summaries` (observed days) |
| Most-repeated foods | grouped counts over `meal_items.food_id` in confirmed meals (as `InsightsRepository` already queries) |
| Skip-reason distribution | grouped counts over `workout_sessions.skip_reason` (data-blocked, D3) |

**Rationale.** §2: "The Pattern Engine reads only these rows, never raw events" is about the day
series, and keeps a 30-day window at 30 rows. A per-day summary cannot hold "which foods recur" or a
reason distribution, and the weekly report already reads those as grouped aggregates rather than
rows (`insights.repository.ts`). Evidence for these outputs is the grouped counts, not raw items.

## D15 — Plan-change recomputation

**Decision.**
- **Real-time** (built, 5.1): event, check-in and meal writes recompute that day. Best-effort for the
  current day; plan writes do not recompute.
- **Nightly (Phase 5.2+, authoritative):** recomputes each user's most recent closed day (D11). A
  closed day reconciles with `dayClosed = true` (`daily-plans.service.ts`), so pending items become
  `not_logged` and `plan_adherence_pct` / `workout_planned_time` reflect the final plan.
- **Detection windows end at the last closed day**, so a stale *today* never enters a detector.
- **Historical backfill:** an explicit, idempotent recompute over a date range using
  `DayService.refresh`, run once per release that changes derivation (e.g. D2/D3, D1), with approval;
  it also fills the `metrics` keys absent from rows written before 5.1.

**Not decided here:** a plan edited for a past, already-closed day after the nightly run stays stale
until the next backfill or write for that day. Making plan writes trigger a recompute is an optional
Phase 5.1 amendment, not required by any document.

## D16 — Found during this review (OPEN)

1. **Frequency/streak emission threshold.** §3.4 lists what the detector computes but not when a
   result becomes a pattern (minimum streak length, minimum repetitions, minimum split difference).
   Without it, every user with two logged days has a "streak". **OPEN — product decision.**
2. **"Days of data" for cold start (§7).** Whether tiers count observed days in the user's whole
   history, or in the analysis window. The correlation gates (n ≥ 10, coverage ≥ 70%) already subsume
   the 14-day tier for correlations; the 7-day tier matters for frequency/streak. **OPEN.**

---

## Phase 5.1 amendments these decisions require

| Change | Decision | Files |
|---|---|---|
| `breakfast_logged`: observed day with no meal → 0 | D2 | `patterns/metrics.ts`, `METRICS.breakfast_logged.unresolved` removed; unit + integration tests |
| `workout_completed`: partial-only → 0 | D3 | `patterns/day-facts.ts` (`UNRESOLVED.partialWorkout` removed); unit tests; historical backfill (D15) |
| Sleep-day bedtime fact | D1, after the cut-off is decided | `patterns/day-facts.ts`, summary recompute, tests |

None needs a migration: all live in code and in `daily_summaries.metrics`.

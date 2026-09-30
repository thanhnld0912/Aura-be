# AURA — Pattern Engine

> Rule 8: patterns are computed by the data layer. Rule 7: Claude explains them.
> The engine contains **no AI code at all**.

---

## 1. Why this is a separate subsystem

The naive version is to hand Claude 30 days of logs and ask "notice anything?". That fails
in four ways:

| Problem | Consequence |
|---|---|
| Cost | ~40,000 input tokens per analysis, every time |
| Reproducibility | The same data yields different "findings" on different runs |
| Statistical validity | LLMs pattern-match on narrative, not on significance |
| Auditability | No way to show *why* a claim was made, or to chart it |

So the pipeline splits at the point where the work changes character:

```
PostgreSQL
    ↓  aggregation           SQL — deterministic, indexed, cheap
Feature series
    ↓  detectors             statistics — thresholds, correlation, significance
Candidate patterns
    ↓  ranking + gating      only survivors are stored
patterns (DB)
    ↓  narration             Claude — one small call, only for new patterns
Human-friendly insight
```

Everything above the narration step is testable with fixed inputs and expected outputs.
That matters: this is the subsystem most likely to tell a user something wrong about
themselves.

---

## 2. Layer 1 — Feature extraction

A nightly job materialises one row per user per day into `daily_summaries`. The Pattern
Engine reads only these rows, never raw events. That is what keeps a 30-day window at
30 rows instead of ~400.

Metrics extracted per day:

| Metric | Type | Source |
|---|---|---|
| `bedtime_min` | int, minutes past midnight | `daily_events` type=sleep |
| `sleep_minutes` | int | sleep event duration |
| `first_meal_min` | int | earliest meal `occurred_at` |
| `last_meal_min` | int | latest meal |
| `breakfast_logged` | 0/1 | meal before 10:30 |
| `meals_logged` | int | count |
| `vegetable_servings` | int | `meal_items` joined to `foods.category` |
| `protein_servings` | int | ditto |
| `distinct_foods` | int | distinct `food_id` |
| `workout_completed` | 0/1 | `workout_sessions.status` |
| `workout_planned_time` | int, nullable | `plan_items` |
| `plan_adherence_pct` | numeric | reconciliation |
| `mood_score` | 1–4 | `checkins.mood` ordinal |
| `water_ml` | numeric | water events |
| `logging_gap_hours` | numeric | max gap between logs |

`metrics jsonb` on `daily_summaries` holds anything added later without a migration.

> **As built (Phase 5.1).** Layer 1 is `server/src/patterns/`: `metrics.ts` (the metric catalog and
> `extractDailyFeatures`, one summary row → one day of named metrics), `day-facts.ts` (the derived
> facts stored in `metrics` jsonb) and `coverage.ts` (series over a window, and coverage). Pure,
> deterministic, no AI. The summary is still recomputed on write; the nightly job (§8) is not
> built. No detector, gate, ranking or lifecycle exists yet.

| Metric | Stored as | Status |
|---|---|---|
| `bedtime_min`, `first_meal_min`, `last_meal_min` | `time` columns → minutes past local midnight | available — `bedtime_min` has an open question (§2.3) |
| `sleep_minutes`, `meals_logged`, `plan_adherence_pct`, `water_ml`, `distinct_foods` | columns | available |
| `breakfast_logged` | observed day: first meal strictly before 10:30 → 1, otherwise (including no meal) 0 | available (decision D2) |
| `mood_score` | `mood` → low 1, okay 2, good 3, great 4 | available |
| `logging_gap_hours` | `metrics.logging_gap_hours`: longest gap between consecutive events of the local day | available |
| `workout_planned_time` | `metrics.workout_planned_time`: the day's one planned workout | available — several planned workouts give null (§2.3) |
| `workout_completed` | `metrics.workout_completed`: any completed session → 1, sessions but none completed → 0 (decision D3) | **no write path** — no endpoint writes `workout_sessions`, so it is null in practice |
| `vegetable_servings`, `protein_servings` | always null | **undefined** — no document defines a serving or which `foods.category` values count |

### 2.1 Missing is not zero

Every metric is `number | null`, and null means "the log does not say". Nothing substitutes
a 0 for an absence, because a detector cannot tell a fabricated 0 from a real one:

- **No water event is not 0 ml.** `water_ml` is the sum of `ml` on the day's water events, and
  null when none carries one. A logged `ml: 0` stays a measured 0.
- **No resolved food is not 0 foods.** `distinct_foods` is null when no confirmed meal item
  resolved to a food.
- **No definition is not 0 servings.** The serving columns are null until a serving is defined.
- **An unobserved day is not a skipped breakfast.** `breakfast_logged` measures *logging*: on an observed day with
  no breakfast in the log it is 0, on an unobserved day null (decision D2).
- **One event has no gap.** `logging_gap_hours` needs two events.
- **A day is observed only if something was logged** (`events_logged > 0`). A summary row that
  outlived its events is unobserved, and every metric on it is null.
- Counts of the log itself (`events_logged`, `meals_logged`) are measurements: on an observed
  day, 0 meals logged is true.

`daily_summaries` enforces this in the schema (`DATABASE_DESIGN.md` §3.11).

### 2.2 Coverage

Coverage is measured against **the days in the analysis window**, never against the rows that
exist. `daily_summaries` only has a row for a day on which something was written, so counting
rows would call 20 logged days out of 30 "fully covered".

`seriesFor(features, metric, window)` lays a metric over every calendar day of an inclusive
local-date window, with `null` for a day that has no row, is unobserved, or has no value.
`coverage(...series)` returns `{ days, observed, rate }`: `days` is the window length,
`observed` the days on which **every** series given has a value (both metrics, for a pair), and
`rate = observed / days`, unrounded. 21 of 30 is exactly 0.7; 20 of 30 is below it.

The ≥ 70% gate (§3.1) is the correlation detector's and is not applied here.

### 2.3 Open decisions

> Superseded by **`PATTERN_ENGINE_DECISIONS.md`**, which resolves or re-scopes each question below
> (D1–D5) and records the rest of the Phase 5 decisions. The table is kept as the Phase 5.1 record.

The documents do not settle these. Each is isolated — left null, or flagged on the metric
definition — so that no detector can depend on a guess:

| Question | Where it is held |
|---|---|
| Bedtimes across midnight: 23:30 is 1410 and 00:30 is 30 on a clock scale, and a sleep begun after midnight is filed under the next local day. How should bedtimes be compared? | `METRICS.bedtime_min.unresolved`; the metric's scale is `clock`, not linear |
| ~~Is a day with logs but no meal "breakfast not logged" (0) or unknown (null)?~~ Resolved: 0 (D2, Phase 5.2A). | — |
| ~~Does a `partial` workout session count as completed?~~ Resolved: no, a partial-only day is 0 (D3, Phase 5.2A). | — |
| Which planned time does `workout_planned_time` take when a day plans several workouts? Built as null. | `day-facts.ts` `UNRESOLVED.multiplePlannedWorkouts` |
| What is a serving, and which `foods.category` values are vegetable or protein? | `METRICS.*_servings.status = 'undefined_definition'` |

---

## 3. Layer 2 — Detectors

Four detector families, each a pure function of a metric series.

> **As built (Phase 5.2C).** `server/src/patterns/registry.ts` is the single place that decides
> which families may emit; `runApprovedDetectors` runs only those.
>
> | Family | Status | Code |
> |---|---|---|
> | Correlation | **emits** — the two approved pairs only (D8) | `correlation.ts` |
> | Timing | evaluation built, **blocked** — D16 (the "30+ days" tier of §7), and no `workout_sessions` write path | `timing.ts` |
> | Trend | assessment built (n ≥ 14, R² ≥ 0.3, calendar-day x), **blocked** — D9 magnitude, D16 | `trend.ts` |
> | Frequency / streak | **blocked** — D16, not implemented | — |
>
> Measured on the seeded noise fixture (1,000 datasets): correlation passes ≈ 1.4% per pair and
> trend ≈ 0.3% per metric, close to theory; the timing gates of §3.3 pass ≈ 9% of pure-noise
> 45-day datasets. Timing also refuses a perfect 0-vs-1 split, because Welch's t is undefined
> when both groups are constant. Both belong to the decision that unblocks timing.

### 3.1 Correlation detector

Pairs a subject metric with an object metric over a window and computes Pearson's *r* in SQL:

```sql
-- late bedtime vs. breakfast logged, 30-day window
WITH d AS (
  SELECT local_date, bedtime_min, breakfast_logged
  FROM daily_summaries
  WHERE user_id = $1
    AND local_date >= CURRENT_DATE - INTERVAL '30 days'
    AND bedtime_min IS NOT NULL
)
SELECT
  corr(bedtime_min, breakfast_logged::numeric) AS r,
  count(*)                                     AS n,
  avg(bedtime_min)                             AS subject_mean,
  stddev_pop(bedtime_min)                      AS subject_sd
FROM d;
```

Gating — a candidate is discarded unless **all** hold:

| Gate | Threshold | Why |
|---|---|---|
| `n ≥ 10` | sample size | fewer days cannot support a claim about a person |
| `abs(r) ≥ 0.45` | effect size | weaker is noise at this sample size |
| `subject_sd > 0` | variation | a constant metric correlates with nothing |
| both metrics present ≥ 70% of days | coverage | sparse logging fabricates structure |
| `p < 0.10` (two-tailed) | significance | deliberately lenient, paired with the hedged copy |

The pair list is **curated, not exhaustive**. Testing every metric against every other metric
over 15 metrics is 105 tests — at p<0.10 you expect ~10 spurious "findings" per user by
chance alone. Only pairs with a plausible behavioural link are tested:

```ts
const CORRELATION_PAIRS = [
  ['bedtime_min',          'breakfast_logged'],
  ['sleep_minutes',        'workout_completed'],
  ['workout_planned_time', 'workout_completed'],
  ['mood_score',           'plan_adherence_pct'],
  ['logging_gap_hours',    'meals_logged'],
  ['distinct_foods',       'vegetable_servings'],
  ['plan_adherence_pct',   'mood_score'],
];
```

**Restricting the hypothesis space is the single most important correctness decision in this
subsystem.** It is cheaper and more honest than post-hoc multiple-comparison correction.

### 3.2 Trend detector

Linear regression over a metric across the window; reports slope and R².
Gates: `n ≥ 14`, `R² ≥ 0.3`, slope materially different from zero.

Example: `distinct_foods` rising over 3 weeks → *"variety trending up"*.

### 3.3 Timing / conditional detector

Splits a series on a condition and compares group means with a Welch t-test:

```sql
-- do workouts planned after 18:00 complete less often?
SELECT
  (workout_planned_time >= 1080) AS is_late,
  avg(workout_completed::numeric) AS completion_rate,
  count(*)                        AS n
FROM daily_summaries
WHERE user_id = $1
  AND workout_planned_time IS NOT NULL
  AND local_date >= CURRENT_DATE - INTERVAL '45 days'
GROUP BY 1;
```

Gates: each group `n ≥ 5`; absolute difference in rates `≥ 0.25`; `p < 0.10`.

### 3.4 Frequency / streak detector

Repetition and consistency — no inference required, so no significance test:
current and longest streaks, most-repeated meals, weekday/weekend logging split,
skip-reason distribution from `workout_sessions.skip_reason`.

The skip-reason breakdown is quietly one of the most useful outputs in the product: it turns
"you skipped 4 workouts" into "3 of 4 skipped sessions were logged as `tired`, and all were
scheduled after 18:00" — an observation a person can actually act on, and one that reframes
the skip as a scheduling problem rather than a character problem.

---

## 4. Layer 3 — Ranking and lifecycle

Surviving candidates are scored:

```
score = |strength| × 0.4
      + min(n / 30, 1) × 0.3        // more evidence ranks higher
      + recency_weight × 0.2         // last 14 days weighted up
      + actionability × 0.1          // timing/frequency > abstract correlation
```

The top 3–5 are shown. `InsightsView` displays three pattern cards, so the engine surfaces at
most five and the UI picks.

Lifecycle:

```
candidate ──(passes gates)──> active ──(narrated by Claude)──> shown
    ↑                            │
    │                            ├──(fails on recompute)──> stale ──(30d)──> deleted
    └──(re-crosses threshold)────┘
                                 └──(user dismisses)──> dismissed (excluded 60 days)
```

Recomputed nightly. A pattern that stops holding goes `stale` and disappears — AURA must not
keep repeating a claim that the data no longer supports.

`ai_feedback.rating = 'wrong'` on a pattern-derived insight forces immediate recomputation and
lowers that pattern's ranking. **User contradiction is the strongest available signal that a
correlation is spurious**, and it is treated as such.

---

## 5. Layer 4 — Narration

Only patterns newly reaching `active` are narrated. Claude receives the computed statistics,
never the raw data:

```json
{
  "kind": "correlation",
  "subject": { "metric": "bedtime_min", "label": "Bedtime",
               "mean": 1418, "unit": "minutes past midnight" },
  "object":  { "metric": "breakfast_logged", "label": "Breakfast logged" },
  "direction": "negative", "strength": -0.62,
  "sampleSize": 14, "windowDays": 30,
  "contrast": { "when_late": { "breakfast_rate": 0.25, "n": 8 },
                "when_early": { "breakfast_rate": 0.83, "n": 6 } },
  "locale": "vi"
}
```

Output is validated against `PatternNarrationSchema`, which **requires** a `caveat` field and
runs a causal-language filter (`AI_ARCHITECTURE.md` §6).

✅ *"Trong dữ liệu 14 ngày gần đây, những ngày bạn ngủ sau 23:45 thường đi kèm với bữa sáng
được ghi nhận muộn hơn hoặc không được ghi."*

❌ *"Ngủ ít khiến bạn bỏ bữa sáng."*

The existing UI already frames this correctly — `InsightsView.tsx:96` labels the card
**"Gentle Correlation"** and line 100 reads *"a ripple gently touched the rest of your day"*.
The engine's job is to make sure the *statistics* deserve that framing, and the narration
schema's job is to make sure the *language* never exceeds it.

---

## 6. Evidence and the chart

`patterns.evidence` stores the exact series the frontend chart renders
(`InsightsView.tsx:137`, "10-Day Sleep vs. Meal Timing Curve"):

```json
{ "subjectLabel": "Bedtime", "objectLabel": "Breakfast logged",
  "points": [ { "date": "2026-08-20", "subject": 1425, "object": 1 },
              { "date": "2026-08-21", "subject": 1502, "object": 0 } ] }
```

Served by `GET /api/patterns/:id/series`.

Storing the series alongside the narrative guarantees the chart and the sentence describe the
same numbers. If they could diverge, a user would eventually catch AURA contradicting itself
about their own life — which costs more trust than the insight was ever worth.

---

## 7. Cold start

| Days of data | Behaviour |
|---|---|
| 0–6 | No patterns. Insights describe the day only. |
| 7–13 | Frequency and streak patterns only — no correlations |
| 14–29 | Correlations with `n ≥ 10` on curated pairs |
| 30+ | Full detector set including trends and timing |

**AURA says nothing rather than something premature.** The frontend already has copy for this
posture; the engine must earn the right to make claims. A correlation from 4 days of data is
worse than silence, because it teaches the user that AURA's observations are noise.

---

## 8. Scheduling and cost

```
02:00 local  →  recompute daily_summaries for yesterday      (SQL, ~10 ms/user)
02:15 local  →  run detectors, update patterns               (SQL, ~50 ms/user)
02:30        →  narrate NEWLY active patterns only           (Claude, ~$0.013 each)
Sunday 03:00 →  weekly_summaries + weekly narrative          (Claude, ~$0.048)
```

Steps 1 and 2 are pure SQL and effectively free. A user with stable behaviour generates
**zero** narration calls in a week, because no pattern newly crossed a threshold — the engine
runs constantly and costs nothing until it has something new to say.

---

## 9. Testing

The detectors are pure functions over fixed series, so they are tested with synthetic
fixtures rather than live data:

| Fixture | Expectation |
|---|---|
| perfectly correlated series | detected, `r` ≈ ±1 |
| pure random noise, n=30 | **no pattern emitted** |
| strong correlation, n=8 | rejected — below sample gate |
| constant metric | rejected — zero variance |
| 40% missing days | rejected — below coverage gate |
| real correlation + 2 outliers | still detected, strength reduced |

The noise fixture is the important one and runs on every commit. **A pattern engine that finds
structure in random data is worse than no pattern engine**, because it produces confident,
personal, and false statements about a user's health behaviour.

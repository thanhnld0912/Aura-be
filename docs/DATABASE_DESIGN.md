# AURA — Database Design

PostgreSQL 16 (Supabase) · Drizzle ORM · SQL migrations in `server/src/database/migrations/`

---

## 1. Design principles

1. **Planned ≠ Actual** (Rule 9). `plan_items` and `daily_events` are separate tables joined
   by a nullable link. Logging never mutates a plan.
2. **`daily_events` is the spine** (§12). One row per thing that happened, with a typed detail
   row hanging off it. New event types cost one enum value, not a migration of the world.
3. **Provenance is a column, not a comment.** Every nutrition figure carries `source` and
   `confidence`, and records whether the user confirmed it (§9, Rules 6 & 11).
4. **Aggregates are materialised.** `daily_summaries` and `weekly_summaries` are written once
   and read many times, so opening the app costs one indexed read and zero AI calls (§26).
5. **Soft-delete user content.** `deleted_at` on meals, events and checkins — an accidental
   swipe must not destroy history the Pattern Engine depends on.
6. **UTC in, local day out.** All timestamps are `timestamptz`. Every table that represents
   "a day" also stores `local_date date` computed in the user's timezone, because
   "did they eat breakfast on Tuesday" is a local-calendar question, not a UTC one.

---

## 2. ERD

```mermaid
erDiagram
    users ||--o| user_preferences : has
    users ||--o{ daily_plans : owns
    users ||--o{ daily_events : owns
    users ||--o{ habits : defines
    users ||--o{ daily_summaries : has
    users ||--o{ weekly_summaries : has
    users ||--o{ patterns : has
    users ||--o{ insights : receives
    users ||--o{ ai_runs : triggers
    users ||--o{ group_members : joins
    users ||--o{ user_food_aliases : teaches

    daily_plans ||--o{ plan_items : contains
    plan_items  |o--o| daily_events : reconciled_with

    daily_events ||--o| meals : detail
    daily_events ||--o| workout_sessions : detail
    daily_events ||--o| habit_logs : detail
    daily_events ||--o| checkins : detail

    meals ||--o{ meal_items : contains
    meal_items }o--o| foods : resolved_to
    foods ||--o{ food_portions : defines

    workout_sessions ||--o{ workout_exercises : contains
    habits ||--o{ habit_logs : logged_as

    patterns ||--o{ insights : supports
    insights }o--o| ai_runs : produced_by
    insights ||--o{ ai_feedback : rated_by

    groups ||--o{ group_members : has
    groups ||--o{ group_events : feeds

    users {
        uuid id PK "= Supabase auth uid"
        text email UK
        text display_name
        text avatar_url
        text timezone "default Asia/Ho_Chi_Minh"
        text locale "default vi"
        date date_of_birth "nullable"
        int  streak_days
        date streak_last_date
        timestamptz created_at
        timestamptz updated_at
    }

    user_preferences {
        uuid user_id PK
        text unit_system
        bool show_calories "§10 opt-out"
        text nutrition_display "focus|detail|hidden"
        jsonb dietary_flags
        jsonb disliked_foods
        text goal_focus "consistency|variety|movement"
        time  quiet_hours_start
        time  quiet_hours_end
        bool  ai_insights_enabled
        timestamptz updated_at
    }

    daily_plans {
        uuid id PK
        uuid user_id FK
        date local_date "UK with user_id"
        text source "user|ai|template"
        text status "draft|active|archived"
        uuid generated_by_ai_run FK "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    plan_items {
        uuid id PK
        uuid plan_id FK
        text event_type "meal|workout|walk|sleep|water|habit|checkin|custom"
        text title
        time planned_time
        int  planned_duration_min "nullable"
        jsonb target "nullable"
        int  sort_order
        uuid linked_event_id FK "nullable UK"
        text adherence "pending|on_time|shifted|substituted|not_logged"
        int  shift_minutes "nullable"
        timestamptz reconciled_at "nullable"
    }

    daily_events {
        uuid id PK
        uuid user_id FK
        date local_date
        text type "meal|workout|walk|sleep|water|habit|checkin|custom"
        timestamptz occurred_at
        int  duration_min "nullable"
        text title
        text note "nullable"
        text input_method "photo|text|quick|manual|auto"
        text source "user|ai|imported"
        timestamptz created_at
        timestamptz deleted_at "nullable"
    }

    meals {
        uuid id PK
        uuid event_id FK UK "nullable while draft"
        uuid user_id FK
        text meal_type "breakfast|lunch|dinner|snack|drink"
        text status "draft|confirmed|discarded"
        text raw_input "nullable"
        text image_key "nullable, storage key not bytes"
        numeric total_kcal "nullable"
        numeric total_protein_g
        numeric total_carbs_g
        numeric total_fat_g
        numeric total_fiber_g
        text nutrition_source "aggregate of items"
        numeric confidence "0..1"
        bool user_confirmed
        bool user_edited
        timestamptz created_at
        timestamptz deleted_at
    }

    meal_items {
        uuid id PK
        uuid meal_id FK
        uuid food_id FK "nullable if unresolved"
        text detected_name
        text display_name_vi
        text display_name_en
        numeric quantity
        text unit "g|ml|bowl|piece|plate|serving"
        numeric grams_resolved "nullable"
        text portion_label "small|medium|large|custom"
        numeric kcal
        numeric protein_g
        numeric carbs_g
        numeric fat_g
        numeric fiber_g
        text source "vision|text|quick|usda|off|local|user"
        numeric confidence "0..1"
        bool user_confirmed
        int  sort_order
    }

    foods {
        uuid id PK
        text canonical_name
        text name_vi "nullable"
        text name_en
        text provider "usda|off|local"
        text external_id "UK with provider"
        text barcode "nullable, indexed"
        text category
        numeric kcal_per_100g
        numeric protein_per_100g
        numeric carbs_per_100g
        numeric fat_per_100g
        numeric fiber_per_100g
        jsonb micronutrients
        text data_quality "high|medium|low"
        tsvector search_vector
        timestamptz cached_at
    }

    food_portions {
        uuid id PK
        uuid food_id FK
        text label "1 bowl|1 cutlet|medium plate"
        text label_vi "1 chen|1 to"
        numeric grams
        bool is_default
    }

    workout_sessions {
        uuid id PK
        uuid event_id FK UK
        uuid user_id FK
        text workout_type "gym|run|walk|yoga|sport|home|other"
        text status "completed|partial|skipped"
        text skip_reason "busy|tired|no_time|not_motivated|other"
        text skip_note "nullable"
        int  duration_min "nullable"
        int  perceived_effort "1..5 nullable"
        timestamptz created_at
    }

    workout_exercises {
        uuid id PK
        uuid session_id FK
        text name
        int  sets "nullable"
        int  reps "nullable"
        numeric weight_kg "nullable"
        int  duration_sec "nullable"
        numeric distance_km "nullable"
        int  sort_order
    }

    habits {
        uuid id PK
        uuid user_id FK
        text key "UK with user_id"
        text title
        text cadence "daily|weekly|custom"
        jsonb schedule
        text icon
        bool is_system "workout/meal-log/sleep consistency"
        bool archived
        timestamptz created_at
    }

    habit_logs {
        uuid id PK
        uuid habit_id FK
        uuid event_id FK "nullable"
        uuid user_id FK
        date local_date "UK with habit_id"
        text status "done|partial|skipped"
        text note "nullable"
        timestamptz created_at
    }

    checkins {
        uuid id PK
        uuid event_id FK UK
        uuid user_id FK
        date local_date
        text mood "low|okay|good|great"
        text day_tag "normal|busy|better_than_expected|not_as_planned"
        int  energy_1_5 "nullable"
        text note "nullable"
        timestamptz created_at
    }

    daily_summaries {
        uuid id PK
        uuid user_id FK
        date local_date "UK with user_id"
        int  events_logged
        int  meals_logged
        int  vegetable_servings "nullable, no definition yet"
        int  protein_servings "nullable, no definition yet"
        int  distinct_foods "nullable"
        numeric water_ml "nullable"
        int  sleep_minutes "nullable"
        time first_meal_time "nullable"
        time last_meal_time "nullable"
        time bedtime "nullable"
        numeric plan_adherence_pct "nullable"
        numeric total_kcal "nullable"
        text mood
        jsonb metrics "extensible bag"
        text narrative "nullable, Claude"
        uuid ai_run_id FK "nullable"
        timestamptz computed_at
    }

    weekly_summaries {
        uuid id PK
        uuid user_id FK
        date week_start "UK with user_id, Monday"
        int  days_logged
        numeric avg_plan_adherence
        numeric meal_logging_consistency
        int  workouts_completed
        int  workouts_skipped
        jsonb skip_reason_breakdown
        int  distinct_foods
        numeric avg_sleep_minutes
        jsonb metrics
        jsonb reels "InsightsView story cards"
        text narrative
        uuid ai_run_id FK
        timestamptz computed_at
    }

    patterns {
        uuid id PK
        uuid user_id FK
        text key "UK with user_id + window"
        text kind "correlation|trend|streak|frequency|timing"
        text subject_metric
        text object_metric "nullable"
        text direction "positive|negative|none"
        numeric strength "-1..1"
        numeric p_value "nullable"
        int  sample_size
        int  window_days
        numeric support "0..1"
        text status "candidate|active|stale|dismissed"
        jsonb evidence "series for the chart"
        text narrative "nullable, Claude"
        timestamptz first_detected_at
        timestamptz last_computed_at
    }

    insights {
        uuid id PK
        uuid user_id FK
        text scope "daily|weekly|pattern|suggestion"
        date scope_date "nullable"
        uuid pattern_id FK "nullable"
        text title
        text body
        jsonb structured "observations|deviations|suggestions"
        numeric confidence
        uuid ai_run_id FK
        bool seen
        timestamptz created_at
        timestamptz expires_at "nullable"
    }

    ai_runs {
        uuid id PK
        uuid user_id FK
        enum purpose "ai_purpose: meal_parse|meal_vision|daily|weekly|pattern|chat|plan"
        enum provider "ai_provider: anthropic|google"
        text model
        int  input_tokens
        int  output_tokens
        numeric cost_usd
        int  latency_ms
        enum status "ai_status: ok|schema_error|provider_error|timeout|refused|blocked"
        text error "nullable"
        jsonb request_meta "no PII, no raw prompt"
        timestamptz created_at
    }

    ai_feedback {
        uuid id PK
        uuid insight_id FK
        uuid user_id FK
        text rating "helpful|not_helpful|wrong"
        text comment "nullable"
        timestamptz created_at
    }

    user_food_aliases {
        uuid id PK
        uuid user_id FK
        text alias "what the user says"
        uuid food_id FK
        numeric default_grams "nullable"
        int  use_count
        timestamptz last_used_at
    }

    groups {
        uuid id PK
        text name
        text invite_code UK
        uuid created_by FK
        int  member_limit
        timestamptz created_at
    }

    group_members {
        uuid id PK
        uuid group_id FK
        uuid user_id FK "UK with group_id"
        text role "owner|member"
        text status_quote "nullable"
        timestamptz joined_at
    }

    group_events {
        uuid id PK
        uuid group_id FK
        uuid user_id FK
        uuid event_id FK "nullable"
        text kind "activity|cheer|high_five"
        text summary
        jsonb reactions
        timestamptz created_at
    }
```

---

## 3. Table notes

### 3.1 `users` and Supabase Auth

`users.id` **equals** the Supabase `auth.users` uid. We deliberately do **not** add a
cross-schema foreign key to `auth.users`:

- it keeps migrations portable if auth is ever replaced (Rule 15 / §11 trade-offs);
- Supabase's own guidance is to mirror rather than couple.

Rows are created by **JIT provisioning**: the auth middleware upserts a `users` row on the
first authenticated request. No webhook infrastructure, and no window where a valid token has
no profile.

### 3.2 `daily_events` — the extensible spine

The `type` enum is derived directly from the frontend's existing
`ActivityCategory` (`FRONTEND_AUDIT.md` §3.3), with `'check-in'` normalised to `checkin`:

```
'eat' → 'meal'     (renamed: the noun matches the detail table)
'workout'  'walk'  'water'  'sleep'  'check-in' → 'checkin'  'other' → 'custom'
```

`walk` and `water` intentionally have **no detail table** at MVP — duration and volume live in
`daily_events.duration_min` and a small `metrics` bag. Adding `walks` later requires no change
to existing rows.

### 3.3 `plan_items.adherence` — computed, never punitive

Reconciliation (`daily-plans.service.reconcile()`) runs when an event is created and when the
day closes:

| Value | Condition |
|---|---|
| `on_time` | matching event within ±45 min of `planned_time` |
| `shifted` | matching event outside the window; `shift_minutes` recorded |
| `substituted` | a different event type satisfied the slot (planned gym → logged walk) |
| `not_logged` | day closed with no match |

There is deliberately **no `failed` / `missed` value** (§13). `not_logged` states a fact about
data, not about the person. The Pattern Engine reads these values; the copy layer never
surfaces the raw enum.

### 3.4 `meals` — draft-first

A meal exists as `status='draft'` from the moment vision or parsing produces it, *before* the
user confirms. This is what makes Rule 11 possible: the user is correcting a stored draft, not
racing an ephemeral response. Drafts older than 24 h are swept to `discarded`.

`event_id` is nullable while draft and set on confirm — a draft is not yet something that
"happened", so it must not pollute the timeline or the Pattern Engine.

### 3.5 `meal_items.source` — the provenance chain

```
vision | text | quick   → how the item was identified
usda | off | local      → where its nutrition came from
user                    → the user corrected it (always wins)
```

`meals.confidence` is the **sample-size-weighted minimum** of item confidences, not the mean:
one badly-guessed item should visibly lower the whole meal's confidence rather than being
averaged away. Any item with `source='user'` is treated as `confidence = 1.0`.

### 3.6 `foods` — a cache plus a local dataset

One table serves all three providers, discriminated by `provider` + `external_id`.
USDA and OFF rows are **cached on first use** (`cached_at`), so a repeated Vietnamese meal
resolves without a network call after day one. `provider='local'` rows are our own
Vietnamese food dataset, seeded in Phase 3 — these are authored, never expired.

`food_portions` is what makes "2 chén cơm" resolvable: `label_vi='1 chén'`, `grams=150`.
Household measures are the actual unit of Vietnamese meal logging; grams are the exception.

### 3.7 `patterns` — statistics, stored

Written by the Pattern Engine (`PATTERN_ENGINE.md`), not by an LLM. `narrative` is filled in
later by Claude and may be `null`; a pattern is valid and chartable without prose.

`evidence` holds the exact series the frontend chart at `InsightsView.tsx:137` renders, so the
chart and the sentence can never disagree.

`status='candidate'` until it clears the significance thresholds; only `active` patterns are
narrated or shown.

> **As built (Phase 5.3A)** — migrations `0010_patterns` (table) and `0011_patterns_rls`
> (policy); schema `server/src/database/schema/patterns.ts`; writer `PatternsRepository`
> (`server/src/modules/patterns/`). Supersedes the ERD sketch above where they differ.
>
> | Column | Type | Notes |
> |---|---|---|
> | `id` | uuid PK | |
> | `user_id` | uuid FK → `users` | `ON DELETE CASCADE` |
> | `key` | text | the detector's own key (`correlationKey`, `timingKey`) |
> | `kind` | `pattern_kind` enum | correlation, trend, timing, frequency, streak (D7) |
> | `subject_metric`, `object_metric` | text, object nullable | object required for correlation and timing |
> | `direction` | `pattern_direction` enum | positive, negative, none — **the sign lives here** |
> | `strength` | double precision | **magnitude, 0..1** (D6): \|r\| for a correlation, \|rate difference\| for timing |
> | `p_value` | double precision, nullable | null exactly for frequency/streak (D7) |
> | `sample_size` | integer | ≥ 1 |
> | `coverage` | double precision | 0..1, as defined in `PATTERN_ENGINE.md` §2.2; there is no `support` (D6) |
> | `window_start`, `window_end`, `window_days` | date, date, integer | metadata, not identity; `window_end − window_start + 1 = window_days` |
> | `evidence` | jsonb | `{ points: [{ localDate, subject, object }] }` — the detector's points, as returned |
> | `detector_version` | text | `DETECTOR_REGISTRY[family].version`, e.g. `correlation@1` |
> | `status` | `pattern_status` enum | `active`, `stale`, `dismissed` — no `candidate`, `shown` or `deleted` |
> | `first_detected_at`, `last_detected_at`, `status_changed_at` | timestamptz | see the lifecycle below |
>
> **Identity** is `UNIQUE (user_id, key)` (`uq_patterns_user_key`). A pattern re-detected over
> a later window updates its row; the window is not part of the key.
>
> **Current state, not history.** A row is the latest evidence for a claim the data still
> supports; re-detection overwrites it, and `detector_version` plus the window say what produced
> it. There is no evidence table and no audit history.
>
> **Lifecycle** (`server/src/patterns/lifecycle.ts`; `status_changed_at` is the clock):
> new → `active` (all three timestamps = now); active re-detected → `last_detected_at` and the
> measured fields move, `status_changed_at` does not; active not detected → `stale`; stale
> re-detected → `active`; active or stale dismissed → `dismissed`; dismissed re-detected within
> 60 days → untouched, after 60 days → `active`; stale for 30 days → **row deleted** (there is no
> deleted state). `first_detected_at` never moves. A detection whose window ends before the
> stored one is ignored, so an older run cannot overwrite a newer one.
>
> **Not stored:** `score`, rank and actionability (computed when serving), `caveat` and metric
> labels (deterministic text by kind and locale), `narrative` (arrives with narration).
>
> **Checks:** strength, coverage and p-value in 0..1; sample ≥ 1; window length; p-value null
> iff frequency/streak; object metric for correlation/timing; key starts with `<kind>:`;
> `first_detected_at ≤ last_detected_at`.
>
> **Indexes:** the unique `(user_id, key)` index also serves every per-user read (a user has at
> most one row per approved hypothesis, a handful). `idx_patterns_stale (status_changed_at)
> WHERE status = 'stale'` serves the cross-user retention sweep. No index for ranking: it is
> computed in the application over those few rows.

### 3.8 `ai_runs` — cost and reliability ledger

Every provider call writes a row: tokens, cost, latency, and whether the response passed Zod.
This makes §26 measurable rather than aspirational, and makes `status='schema_error'` rate the
primary health metric for prompt changes.

`request_meta` deliberately excludes raw prompts and any PII. As built it carries
`promptVersion`, `inputChars`, `itemCount`, `imageBytes`, `imageMime` and
`schemaErrorPaths` — sizes, shapes and Zod paths, nothing with content in it.

**One row per provider attempt, not per request.** A call that fails its schema and
succeeds on the retry writes two rows and keeps both; `schema_error` rate is the metric
this table exists to produce, and it cannot be read from a ledger that discards the
attempts that failed.

`purpose`, `provider` and `status` are **real PostgreSQL enums** (`ai_purpose`,
`ai_provider`, `ai_status`), following §3.9 rather than the `text` the ERD above
originally sketched. `model` stays `text`: model ids change often, and an unrecognised
one is not an integrity problem. `status` includes `blocked` from the start for the
safety layer, which lands later — an unused enum value costs a line now and a migration
later. Cost and token columns are nullable because a timeout reports no usage at all,
and a null there is the honest answer where a zero would understate a real bill.

### 3.9 Phase 2 implementation notes

Decisions taken while building the schema that this document did not previously pin down:

**Columns added.** `users.deleted_at` (the `DELETE /api/users/me` soft delete needs it, and
that endpoint is Phase 2); `daily_events.metrics` (named in §3.2 and accepted by
`POST /api/events`, but absent from the ERD column list); `daily_events.updated_at` (the
`PATCH` endpoint needs it).

**Foreign keys deferred.** `daily_plans.generated_by_ai_run` and `daily_summaries.ai_run_id`
exist as columns without their constraint, because `ai_runs` arrives in Phase 4. The FK is
added then — one constraint, no data migration.

**Enums are real PostgreSQL enums**, not text with a comment, so a bad categorical value
fails on write rather than surfacing months later in an aggregate.

**`shift_minutes` is recorded whenever an event is linked**, not only when the item is
`shifted`. §3.3 mentions it under `shifted`, but the delta is a fact about what happened and
"40 minutes late, still inside the window" is worth keeping. It is signed: negative is early.

**Substitution affinity.** §3.3 gives one example — planned gym, logged walk — without a
general rule. The implementation substitutes only within a named affinity group, and at MVP
the only group is movement (`workout` ↔ `walk`). A planned meal is never satisfied by a
workout. Extending it is one entry in `SUBSTITUTION_GROUPS`.

**`adherence_pct`** counts `on_time`, `shifted` and `substituted` alike — each is the user
having done the thing — over *resolved* items only, so a plan does not read as 0% at
breakfast time. `null` when nothing has resolved yet.

**Reconciliation assignment is global best-first**, not greedy in plan order: items at 08:00
and 09:00 with one event at 08:50 give the event to the 09:00 item as `on_time` rather than
to the 08:00 item as `shifted`. Ordering is fully specified — tier, distance, then ids — so
equidistant candidates cannot flip between runs.


### 3.10 Phase 3 schema additions

- **`user_food_aliases`** — the personalisation loop from `NUTRITION_ARCHITECTURE.md` §4
  step 1, finally created. Unique on `(user_id, alias_normalized)`, RLS-scoped like every
  other user-owned table.
- **`foods.search_name` / `search_name_en`** — diacritic-free forms with their own trigram
  indexes. The original `idx_foods_name_trgm` over `canonical_name` is dropped: matching
  against a name with diacritics defeats the purpose.
- **`foods.source_reference`** — provenance for every row. Required for local data.
- **`foods.search_priority`** — curated tiebreak for ambiguous bare terms ("cơm" is
  *cơm trắng*, not *cơm gà*). Applies only when the query matches as complete words.
- **`meal_items.portion_id`** — which `food_portions` row produced `grams_resolved`.
  Provenance for the portion, the way `source` is provenance for the nutrition.
  `ON DELETE SET NULL`, because evicting a portion definition must not rewrite what the
  user confirmed.

The `search_name` backfill in `0004` is written defensively — `ADD COLUMN … NOT NULL` with
no default fails the moment the table is not empty, and a migration that only works on an
empty table is a trap for staging.

**Nutrition snapshots are load-bearing, and now tested.** `meal_items` stores denormalised
values; a test revises a food's `kcal_per_100g` to 999 and asserts the historical meal is
unchanged. Nutrition history is an audit record, not a live join.

### 3.11 Phase 5.1: `daily_summaries` as the Pattern Engine's input

`daily_summaries` is the only table the Pattern Engine reads (`PATTERN_ENGINE.md` §2), so a
default of 0 on a measure is a fabricated observation. Migration `0008` drops the `NOT NULL`
and the `0` default from the four measures that had one; `0009` backfills existing rows.

| Column | Now | Null means |
|---|---|---|
| `water_ml` | sum of `ml` on the day's live water events | no water event carries an amount |
| `distinct_foods` | distinct resolved `food_id` in the day's confirmed meals | no confirmed meal item resolved to a food |
| `vegetable_servings`, `protein_servings` | always null | no document defines a serving or which `foods.category` values count |

`events_logged` and `meals_logged` stay `NOT NULL DEFAULT 0`: they count rows in the log, so
0 is a measurement. `total_kcal` stays null and unwritten; calories belong to
`GET /api/nutrition/daily`.

**`metrics` jsonb now carries derived day facts**, written on every recompute:
`workout_completed`, `workout_planned_time`, `logging_gap_hours` (`server/src/patterns/day-facts.ts`).
A key that is absent means "not computed" and reads as missing.

**Backfill (`0009`).** Hand-written, separate from the generated `0008`, and idempotent: it
recomputes `water_ml` and `distinct_foods` from the source tables with the same rule the
application applies on write, and sets both serving columns to null. Nothing is invented — a day
whose source rows do not say stays null. The `metrics` keys are not backfilled; each day gains
them on its next recompute.

---

## 4. Indexes

```sql
-- hot path: today's timeline
CREATE INDEX idx_events_user_date      ON daily_events (user_id, local_date DESC)
                                       WHERE deleted_at IS NULL;
CREATE INDEX idx_events_user_type_date ON daily_events (user_id, type, local_date DESC)
                                       WHERE deleted_at IS NULL;
CREATE INDEX idx_events_occurred       ON daily_events (user_id, occurred_at DESC);

-- plan reconciliation
CREATE UNIQUE INDEX idx_plans_user_date ON daily_plans (user_id, local_date);
CREATE INDEX idx_plan_items_plan        ON plan_items (plan_id, sort_order);
CREATE UNIQUE INDEX idx_plan_items_link ON plan_items (linked_event_id)
                                        WHERE linked_event_id IS NOT NULL;

-- meals
CREATE INDEX idx_meals_user_created ON meals (user_id, created_at DESC)
                                    WHERE deleted_at IS NULL;
CREATE INDEX idx_meals_draft        ON meals (user_id, status) WHERE status = 'draft';
CREATE INDEX idx_meal_items_meal    ON meal_items (meal_id, sort_order);

-- food lookup
CREATE UNIQUE INDEX idx_foods_provider_ext ON foods (provider, external_id);
CREATE INDEX idx_foods_barcode  ON foods (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_foods_search   ON foods USING GIN (search_vector);
CREATE INDEX idx_foods_name_trgm ON foods USING GIN (canonical_name gin_trgm_ops);

-- aggregates
CREATE UNIQUE INDEX idx_daily_sum   ON daily_summaries (user_id, local_date);
CREATE UNIQUE INDEX idx_weekly_sum  ON weekly_summaries (user_id, week_start);

-- patterns & insights
-- as built (0010): uq_patterns_user_key (user_id, key) and idx_patterns_stale — see §3.7
CREATE UNIQUE INDEX idx_patterns_key ON patterns (user_id, key, window_days);
CREATE INDEX idx_patterns_active     ON patterns (user_id, status, strength DESC)
                                     WHERE status = 'active';
CREATE INDEX idx_insights_user_scope ON insights (user_id, scope, created_at DESC);

-- habits
CREATE UNIQUE INDEX idx_habits_user_key ON habits (user_id, key);
CREATE UNIQUE INDEX idx_habit_log_day   ON habit_logs (habit_id, local_date);

-- ops
CREATE INDEX idx_ai_runs_user_time ON ai_runs (user_id, created_at DESC);
CREATE INDEX idx_ai_runs_purpose   ON ai_runs (purpose, created_at DESC);
```

`gin_trgm_ops` requires `CREATE EXTENSION pg_trgm` — it is what makes fuzzy Vietnamese food
matching ("thit kho" → "thịt kho") work without exact spelling or diacritics.

---

## 5. Constraints worth stating explicitly

```sql
ALTER TABLE meal_items
  ADD CONSTRAINT chk_confidence  CHECK (confidence >= 0 AND confidence <= 1),
  ADD CONSTRAINT chk_quantity    CHECK (quantity > 0),
  ADD CONSTRAINT chk_nonneg_kcal CHECK (kcal IS NULL OR kcal >= 0);

-- as built (0010): strength is a magnitude, chk_pattern_strength CHECK (strength BETWEEN 0 AND 1),
-- and chk_pattern_sample requires sample_size >= 1 — see §3.7
ALTER TABLE patterns
  ADD CONSTRAINT chk_strength CHECK (strength BETWEEN -1 AND 1),
  ADD CONSTRAINT chk_sample   CHECK (sample_size >= 0);

-- a skip reason only makes sense for a skipped session
ALTER TABLE workout_sessions
  ADD CONSTRAINT chk_skip_reason
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL));

-- a confirmed meal must be attached to an event; a draft must not be
ALTER TABLE meals
  ADD CONSTRAINT chk_meal_event
  CHECK ((status = 'confirmed') = (event_id IS NOT NULL));

-- one detail row per event
ALTER TABLE meals            ADD CONSTRAINT uq_meal_event    UNIQUE (event_id);
ALTER TABLE workout_sessions ADD CONSTRAINT uq_workout_event UNIQUE (event_id);
ALTER TABLE checkins         ADD CONSTRAINT uq_checkin_event UNIQUE (event_id);
```

**Cascade policy:** detail tables cascade from `daily_events`. `foods` is `ON DELETE SET NULL`
from `meal_items` — deleting a cached food row must never destroy a user's meal history; the
item keeps its stored nutrition snapshot and its `detected_name`.

That last point is important: `meal_items` stores **denormalised nutrition values**, not just
a `food_id`. If USDA revises a figure, historical meals keep the numbers the user actually saw
and confirmed. Nutrition history is an audit record, not a live join.

---

## 6. Row Level Security

Because Supabase is in use, RLS is enabled on every user-owned table as defence in depth,
even though the API is the only intended writer:

```sql
ALTER TABLE daily_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_events ON daily_events
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
```

The backend connects with the **service role** and bypasses RLS, enforcing ownership in the
repository layer. RLS exists so that a leaked anon key cannot read another user's data —
it is the second lock, not the first.

`foods` is world-readable (public reference data). `groups` uses a membership-based policy.

### Implemented in Phase 2

All fifteen tables have RLS enabled and a policy (`0003_rls_policies`).

**Two locks, deliberately independent.** The first is the repository layer: every query is
scoped to the `userId` taken from the verified JWT. The second is RLS. They are not
redundant — they defend different doors. The repository protects the API; RLS protects the
database from anything that reaches it *without* going through the API, which on Supabase
means a leaked anon key hitting PostgREST, since the platform grants `anon` and
`authenticated` access to new tables in `public` by default.

**`FORCE ROW LEVEL SECURITY` is deliberately not set.** Forcing it would subject the
backend's own connection to the policies, which would mean propagating JWT claims onto
pooled connections with `SET LOCAL` on every request — a cross-request leak hazard, and a
design that makes authorization depend on connection state rather than on the query. The
architecture keeps authorization in the repository layer precisely to avoid that.

**Policy shape.** Each is `FOR ALL` with both `USING` and `WITH CHECK`, which is exactly
equivalent to four separate policies: `USING` gates the rows `SELECT`/`UPDATE`/`DELETE` can
see, `WITH CHECK` gates the rows `INSERT`/`UPDATE` may produce. `WITH CHECK` is what stops a
user reassigning their own row to somebody else. Child tables (`plan_items`, `meal_items`,
`workout_exercises`) carry no `user_id` and scope through an `EXISTS` on their parent, so a
row is never reachable by a route its owner is not on. `foods` and `food_portions` are
readable by all and writable only by the table owner — they have no write policy at all.

**`auth.uid()` portability.** The policies are written against Supabase's `auth.uid()`, which
plain PostgreSQL does not have, so local and CI databases could neither apply nor test them.
Migration `0002_auth_uid_shim` creates the function only when absent — a no-op on Supabase,
never clobbering the platform's own — reading `sub` from `request.jwt.claims`. It returns
`NULL` when no claim is set, and `user_id = NULL` is never true, so **every policy denies by
default** for an unauthenticated connection.

**How it is tested.** `tests/integration/rls.test.ts` does not go through the API, because
the API's connection bypasses these policies. It connects as a non-owner role with
`request.jwt.claims` set on the transaction — exactly how Supabase evaluates a PostgREST
request — and asserts that user A cannot read, update, delete or insert user B's rows in
either direction, that an unauthenticated connection sees nothing at all, and that every
table has RLS enabled with at least one policy.

### `patterns` (Phase 5.3A, `0011_patterns_rls`)

RLS is enabled with **one policy, `own_patterns_read`: `FOR SELECT USING (user_id = auth.uid())`,
and no write policy.** Unlike every other owned table, a user never writes a pattern — it is a
statistical claim the engine makes — so through PostgREST a signed-in user can read their own
patterns and nothing else, and INSERT, UPDATE and DELETE are denied for every row, their own
included (an UPDATE or DELETE matches no row; an INSERT fails the policy). Without that, a leaked
anon key and a user's own JWT could plant a "pattern" that later reaches the weekly story.

This does not protect the backend's access, and is not meant to: the backend connects as the
table owner (and on Supabase as `service_role`, which holds `BYPASSRLS`), `FORCE ROW LEVEL
SECURITY` is not set, so its queries are not filtered by the policy at all. `PatternsRepository`
scopes every per-user query to the `userId` it is given — from the verified token in the API, or
from the engine's own iteration over users — and dismissal answers "not found" alike for a
missing id and another user's. `rls.test.ts` covers the policy; `pattern-persistence.test.ts`
covers the repository scoping.

---

## 7. Migrations

Drizzle Kit generates SQL; the SQL is reviewed and committed — never applied from a
`push` command against a deployed database.

```
server/src/database/
├── schema/          # Drizzle table definitions (source of truth)
├── migrations/      # generated + reviewed .sql, checked in
└── seeds/
    ├── 001_system_habits.ts    # workout/meal-log/sleep consistency
    └── 002_vn_foods.ts         # local Vietnamese food dataset + portions
```

Rules: forward-only; every migration reversible by a written-down manual step; no destructive
column drops without a two-deploy expand/contract.

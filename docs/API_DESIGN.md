# AURA — API Specification

REST · JSON · Fastify 5 · Zod-validated · `Authorization: Bearer <supabase-jwt>`
Base URL: `/api` · Version header: `X-AURA-Version: 1`

---

## 1. Conventions

**Auth.** Every endpoint requires a valid Supabase JWT except `GET /api/health` and
`GET /api/nutrition/search`. The `user_id` is always taken from the verified token —
**never from the request body or a path parameter**. There is no endpoint anywhere in this API
that accepts a `userId` as input; that is what makes horizontal privilege escalation
structurally impossible.

**Dates.** `local_date` is `YYYY-MM-DD` in the user's timezone. Timestamps are ISO-8601 UTC.
A request may pass `?date=` to mean a local calendar day; omitted means "today in the user's tz".

**Errors.** Uniform envelope, machine-readable `code`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "quantity must be greater than 0",
    "details": [{ "path": "items.0.quantity", "issue": "too_small" }],
    "requestId": "01JBQ..."
  }
}
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod rejected the request |
| 401 | `UNAUTHENTICATED` | missing/expired/invalid token |
| 403 | `FORBIDDEN` | authenticated but not the owner |
| 404 | `NOT_FOUND` | absent, or owned by someone else (deliberately indistinguishable) |
| 409 | `CONFLICT` | uniqueness violated (e.g. plan already exists for that date) |
| 413 | `PAYLOAD_TOO_LARGE` | image over 8 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | not jpeg/png/webp |
| 422 | `AI_SCHEMA_ERROR` | model output failed Zod after retry (Rule 10) |
| 429 | `RATE_LIMITED` | includes `Retry-After` |
| 502 | `PROVIDER_ERROR` | upstream AI or nutrition API failed |
| 503 | `PROVIDER_UNAVAILABLE` | all providers exhausted, degraded mode |

**Pagination.** Cursor-based: `?limit=50&cursor=<opaque>` → `{ data, nextCursor }`.
Offset pagination is not offered; history is append-heavy and offsets drift.

**Idempotency.** All `POST` endpoints that create user data accept an optional
`Idempotency-Key` header, stored for 24 h. This matters on mobile where a retry after a
dropped connection must not double-log a meal.

---

## 2. Endpoint map

```
/api/health                  GET
/api/auth                    POST /session · POST /logout · GET /me
/api/users                   GET/PATCH /me · GET/PATCH /me/preferences · DELETE /me
/api/daily-plans             GET · POST · PATCH · DELETE · POST /generate · GET /comparison
/api/daily-events            GET · GET /today · POST · PATCH · DELETE
/api/meals                   POST · POST /parse · POST /analyze-image · POST /:id/confirm
                             PATCH /:id · DELETE /:id · GET /history · GET /frequent
/api/nutrition               GET /search · GET /barcode/:code · POST /calculate · GET /daily
/api/workouts                POST · PATCH /:id · POST /:id/skip · GET /history
/api/habits                  GET · POST · PATCH /:id · DELETE /:id · POST /:id/log · GET /:id/streak
/api/checkins                POST · GET
/api/insights                GET /today · GET /weekly · GET /:id · POST /:id/feedback
/api/patterns                GET · GET /:id · GET /:id/series · POST /:id/dismiss
/api/agent                   POST /chat · POST /analyze-day · POST /analyze-week
                             POST /suggest-meal · GET /chat/history
/api/groups                  POST · POST /join · GET /:id · GET /:id/feed
                             POST /:id/cheer · POST /:id/feed/:eventId/react · DELETE /:id/leave
```

---

## 3. Health

### `GET /api/health`

Auth: **none** · Response `200`

```json
{ "status": "ok", "version": "1.0.0", "uptime": 84213,
  "checks": { "database": "ok", "storage": "ok", "anthropic": "ok", "gemini": "ok" } }
```

Returns `503` if the database check fails. Provider checks are cached 60 s and never block
the response — a degraded AI provider must not mark the API unhealthy.

`checks` lists only dependencies that are actually probed, so it grows with the phases:
`database` from Phase 1, `storage`/`anthropic`/`gemini` from Phase 4. Reporting `"ok"` for a
provider nothing has contacted would be a fabricated result. `status` is `ok`, `degraded`
(a non-critical check failing, still `200`) or `error` (the database check failing, `503`).

---

## 4. Auth

### `POST /api/auth/session`

Exchanges a Supabase access token for a verified server session and JIT-provisions the
`users` row on first call.

Request `{ "accessToken": "eyJ..." }` · Response `200`

```json
{ "user": { "id": "uuid", "email": "...", "displayName": "Thanh",
            "timezone": "Asia/Ho_Chi_Minh", "locale": "vi", "streakDays": 5,
            "isNewUser": false } }
```

Errors: `401 UNAUTHENTICATED` (bad signature / expired).

### `GET /api/auth/me`
Returns the current user + preferences. Used on app boot to decide onboarding vs. home.

### `POST /api/auth/logout`
Revokes the refresh token via Supabase. `204`.

---

## 5. Users

### `GET /api/users/me` → profile + preferences + `streakDays`
Serves `Header.tsx` (audit item 16).

### `PATCH /api/users/me`
```ts
{ displayName?: string(1..60), timezone?: IANATimezone,
  locale?: 'vi'|'en', avatarUrl?: url, dateOfBirth?: date }
```
`dateOfBirth` is validated to be ≥ 13 years ago; under-13 registration is rejected
(`400 UNDERAGE`). See `SECURITY.md` §7.

### `PATCH /api/users/me/preferences`
```ts
{ showCalories?: boolean,
  nutritionDisplay?: 'focus'|'detail'|'hidden',
  dietaryFlags?: string[], dislikedFoods?: string[],
  goalFocus?: 'consistency'|'variety'|'movement',
  aiInsightsEnabled?: boolean,
  quietHours?: { start: 'HH:mm', end: 'HH:mm' } }
```

`showCalories: false` is a real, respected setting (§10): the API then omits `total_kcal`
from every meal response rather than the client hiding it. **Not displaying a number the
server never sent is the only reliable way to honour this.**

### `DELETE /api/users/me`
Requires `{ "confirm": "DELETE" }`. Soft-deletes immediately, hard-deletes after 30 days.
Returns `202`.

---

## 6. Daily Plans (§11)

### `GET /api/daily-plan?date=2026-09-06`

Response `200`

```json
{
  "id": "uuid", "localDate": "2026-09-06", "source": "ai", "status": "active",
  "items": [
    { "id": "uuid", "eventType": "meal", "title": "Breakfast",
      "plannedTime": "08:00", "sortOrder": 0,
      "adherence": "shifted", "shiftMinutes": 40,
      "linkedEventId": "uuid" },
    { "id": "uuid", "eventType": "workout", "title": "Gym session",
      "plannedTime": "17:30", "plannedDurationMin": 60,
      "adherence": "substituted", "linkedEventId": "uuid" }
  ]
}
```

`404` if no plan exists for that date — the client renders the "create a plan" state rather
than an error.

### `POST /api/daily-plan`
```ts
{ localDate: date,
  items: Array<{ eventType: EventType, title: string(1..80),
                 plannedTime: 'HH:mm', plannedDurationMin?: int(1..600),
                 target?: Record<string, unknown> }>  // 1..20
}
```
`201`. `409 CONFLICT` if a plan already exists for that date — use `PATCH`.

### `PATCH /api/daily-plan/:id` — replace items, change status
### `DELETE /api/daily-plan/:id` — `204`

### `POST /api/daily-plan/generate`
```ts
{ localDate: date, basedOnDays?: int(7..30) = 14, notes?: string(0..500) }
```
Claude proposes a plan from recent behaviour. **Returns `status: 'draft'` — never activates
automatically.** The user accepts via `PATCH`. Rate-limited to 3/day.
`202` with the draft plan + `aiRunId`.

### `GET /api/daily-plan/comparison?date=`

Powers the "Plan vs. Actual Spotlight" (`TodayView.tsx:224`, audit item 7).

```json
{
  "localDate": "2026-09-06",
  "adherencePct": 71,
  "items": [
    { "planned": { "title": "Gym session", "time": "17:30" },
      "actual":  { "title": "Evening walk", "time": "18:30", "type": "walk",
                   "durationMin": 40 },
      "adherence": "substituted", "shiftMinutes": 60 }
  ],
  "unplanned": [ { "title": "Afternoon coffee", "time": "15:10", "type": "meal" } ]
}
```

Note `unplanned` is a neutral list, not "extras" or "violations". The comparison endpoint
returns **facts only** — no judgment, no score beyond a percentage the UI may choose not to show.

---

## 7. Daily Events (§12)

### `GET /api/events/today`
### `GET /api/events?from=&to=&type=&limit=&cursor=`

Serves `TodayView` (item 6) and `HistoryView` (item 13). Returns flat events with their
detail payload embedded; **the frontend does Morning/Afternoon/Evening grouping** (audit §3.5).

```json
{ "data": [
    { "id": "uuid", "type": "meal", "occurredAt": "2026-09-06T05:45:00Z",
      "localDate": "2026-09-06", "title": "Lunch", "durationMin": null,
      "inputMethod": "text", "source": "user",
      "detail": { "mealId": "uuid", "mealType": "lunch", "confidence": 0.82,
                  "userConfirmed": true,
                  "items": [ { "displayNameVi": "Cơm trắng", "portionLabel": "2 bowls",
                               "kcal": 260, "source": "local", "confidence": 0.9 } ],
                  "totals": { "kcal": 540, "proteinG": 26, "carbsG": 62, "fiberG": 7 } } }
  ],
  "nextCursor": null }
```

### `POST /api/events`
Generic logger for types without a richer endpoint (`walk`, `water`, `sleep`, `custom`).
```ts
{ type: EventType, occurredAt?: datetime, durationMin?: int, title: string(1..80),
  note?: string(0..500), metrics?: Record<string, number> }
```
`201`. Triggers plan reconciliation and a `daily_summaries` recompute (both synchronous,
both cheap, neither calls AI).

### `PATCH /api/events/:id` · `DELETE /api/events/:id`
Delete is a soft delete. `204`.

---

## 8. Meals (§8, §9) — the core surface

### `POST /api/meals/parse` — "Tell AURA" (audit item 2)

Natural-language Vietnamese or English → structured draft. Replaces the hardcoded
`handleSimulateVoice` at `LogModal.tsx:79`.

Request
```ts
{ text: string(1..1000), mealType?: MealType, occurredAt?: datetime }
```

`"Tôi ăn 2 chén cơm với thịt kho trứng và canh rau."` → `200`

```json
{
  "mealId": "uuid", "status": "draft", "mealType": "dinner",
  "confidence": 0.79, "aiRunId": "uuid",
  "items": [
    { "id": "uuid", "detectedName": "rice", "displayNameVi": "Cơm trắng",
      "displayNameEn": "White rice", "quantity": 2, "unit": "bowl",
      "gramsResolved": 300, "portionLabel": "custom",
      "kcal": 390, "proteinG": 8.1, "carbsG": 86, "fatG": 0.9, "fiberG": 1.2,
      "source": "local", "confidence": 0.88, "userConfirmed": false },
    { "id": "uuid", "detectedName": "braised_pork", "displayNameVi": "Thịt kho",
      "quantity": 1, "unit": "serving", "portionLabel": "medium",
      "kcal": 285, "source": "local", "confidence": 0.71, "userConfirmed": false },
    { "id": "uuid", "detectedName": "egg", "displayNameVi": "Trứng",
      "quantity": 1, "unit": "piece", "kcal": 78,
      "source": "usda", "confidence": 0.93, "userConfirmed": false },
    { "id": "uuid", "detectedName": "vegetable_soup", "displayNameVi": "Canh rau",
      "quantity": 1, "unit": "bowl", "portionLabel": "medium",
      "kcal": 45, "source": "local", "confidence": 0.64, "userConfirmed": false }
  ],
  "totals": { "kcal": 798, "proteinG": 34.2, "carbsG": 92.4, "fatG": 28.1, "fiberG": 5.3 },
  "unresolved": [],
  "notice": "Nutrition figures are estimates based on typical portions."
}
```

The LLM produced only the **left half** of each item — name, quantity, unit, portion.
Every `kcal`/macro figure came from the nutrition layer (Rule 6). If an item cannot be
resolved it appears in `unresolved[]` with `kcal: null` — never invented.

Errors: `422 AI_SCHEMA_ERROR` after one retry; `429` (10/hour); `502 PROVIDER_ERROR`.

### `POST /api/meals/analyze-image` — photo mode (audit item 3)

`multipart/form-data` · fields: `image` (≤8 MB, jpeg/png/webp), `mealType?`, `occurredAt?`

Pipeline is `ARCHITECTURE.md` §4. Response is identical in shape to `/parse`, plus:

```json
{ "imageUrl": "https://…signed…", "imageKey": "u/<uid>/2026/09/<ulid>.webp",
  "items": [ { "source": "vision", "confidence": 0.74,
               "boundingBoxHint": { "x": 0.1, "y": 0.3, "w": 0.4, "h": 0.35 } } ] }
```

`boundingBoxHint` is optional and advisory — it lets the UI point at *which* item on the
plate it means when the user corrects it. Normalised 0..1 coordinates.

Errors: `413`, `415`, `422 AI_SCHEMA_ERROR`, `429` (20/day), `502`.
Timeout budget 25 s; `504` beyond that with the draft still persisted for retry.

### `POST /api/meals` — direct create (Quick Add, audit items 1 & 5)

```ts
{ mealType: MealType, occurredAt?: datetime, rawInput?: string,
  inputMethod: 'quick'|'manual',
  items: Array<{ foodId?: uuid, name?: string,
                 quantity: number > 0, unit: Unit,
                 portionLabel?: 'small'|'medium'|'large'|'custom' }>  // 1..30
}
```

Server resolves nutrition for each item, then creates the meal **already confirmed**
(`status='confirmed'`, `user_confirmed=true`) plus its `daily_events` row — Quick Add is an
explicit user statement, so there is nothing for the user to verify. `201`.

### `POST /api/meals/:id/confirm` — Rule 11

The "✓ Looks right" button (`LogModal.tsx:492`). Accepts optional corrections in the same call
so a user who edits *and* confirms makes one request:

```ts
{ items?: Array<{ id: uuid, quantity?: number, unit?: Unit,
                  portionLabel?: PortionLabel, foodId?: uuid,
                  removed?: boolean }>,
  addItems?: Array<{ name: string, quantity: number, unit: Unit }>,
  mealType?: MealType, note?: string }
```

Every item touched here is stored with `source='user'`, `confidence=1.0`,
`user_confirmed=true`, and the meal gets `user_edited=true`. Corrections also write a
`user_food_aliases` row so the same phrasing resolves better next time — **this is how AURA
learns a household's vocabulary without any model fine-tuning.**

Response `200`: the confirmed meal + the created `eventId`.
`409` if already confirmed.

### `PATCH /api/meals/:id` — edit an already-confirmed meal · `DELETE /api/meals/:id` — soft delete

### `GET /api/meals/history?from=&to=&mealType=&limit=&cursor=`
### `GET /api/meals/frequent?limit=10`
Most-logged foods for this user — powers Quick Add's suggestions from real behaviour rather
than a fixed list, and feeds `frequent_meals` memory.

---

## 9. Nutrition (§6)

### `GET /api/nutrition/search?q=&limit=20&lang=vi`
Auth: optional (public reference data). Searches local VN DB → USDA → OFF, deduplicated,
ranked local-first.

```json
{ "data": [ { "id": "uuid", "nameVi": "Cơm trắng", "nameEn": "White rice, cooked",
              "provider": "local", "kcalPer100g": 130, "dataQuality": "high",
              "portions": [ { "label": "1 chén", "grams": 150, "isDefault": true } ] } ] }
```

### `GET /api/nutrition/barcode/:code`
Open Food Facts lookup for packaged goods, cached into `foods`. `404` if unknown.

### `POST /api/nutrition/calculate` — replaces the hardcoded arithmetic (audit item 4)

```ts
{ items: Array<{ foodId?: uuid, name?: string, quantity: number, unit: Unit,
                 portionLabel?: PortionLabel }> }
```

Returns per-item and total nutrition with `source` and `confidence`. Stateless — this is what
`LogModal`'s portion selector calls on change, replacing `if (foodId === 'rice')` at
`LogModal.tsx:39`. Debounce 300 ms client-side.

### `GET /api/nutrition/daily?date=`
Day totals plus the §10 **behavioural** metrics, which lead the response:

```json
{ "localDate": "2026-09-06",
  "focus": { "vegetableServings": 3, "proteinServings": 2, "distinctFoods": 9,
             "wholeFoodRatio": 0.78, "waterMl": 1500, "mealsLogged": 3,
             "mealConsistency": "steady" },
  "nutrition": { "kcal": 1840, "proteinG": 82, "carbsG": 210, "fatG": 61, "fiberG": 24,
                 "isEstimate": true, "confidence": 0.81 },
  "disclaimer": "Estimates based on typical portions — adjust anything that looks off." }
```

`nutrition` is omitted entirely when `preferences.showCalories = false`.
`focus` is always present. The ordering is deliberate: variety and consistency are the
headline; calories are a secondary, hedged detail (§10).

---

## 10. Workouts (§13)

### `POST /api/workouts`
```ts
{ workoutType: 'gym'|'run'|'walk'|'yoga'|'sport'|'home'|'other',
  occurredAt?: datetime, durationMin?: int(1..600), perceivedEffort?: int(1..5),
  exercises?: Array<{ name: string, sets?: int, reps?: int,
                      weightKg?: number, durationSec?: int, distanceKm?: number }> }
```
`201`, creates event + session.

### `POST /api/workouts/:id/skip`
```ts
{ reason: 'busy'|'tired'|'no_time'|'not_motivated'|'other', note?: string(0..300) }
```

A skipped workout is **recorded, not erased** — it is Pattern Engine input, and the reason
distribution is what makes "workouts scheduled after 18:00 are more often skipped for
`tired`" discoverable. The API vocabulary contains no `failed`, `missed` or `bad` (§13).

### `GET /api/workouts/history?from=&to=&status=`

---

## 11. Habits (§14)

### `GET /api/habits` — user + system habits with current streak
### `POST /api/habits`
```ts
{ key: slug, title: string(1..60), cadence: 'daily'|'weekly'|'custom',
  schedule?: { daysOfWeek?: int[], timesPerWeek?: int }, icon?: string }
```
### `PATCH /api/habits/:id` · `DELETE /api/habits/:id` (archives, never destroys logs)

### `POST /api/habits/:id/log`
```ts
{ localDate?: date, status: 'done'|'partial'|'skipped', note?: string }
```
Upsert on `(habit_id, local_date)`.

### `GET /api/habits/:id/streak`
```json
{ "currentStreak": 5, "longestStreak": 12, "last30Days": ["done","skipped",...],
  "completionRate": 0.73, "trend": "improving" }
```

System habits (`is_system=true`) are logged automatically from events —
`workout_consistency`, `meal_logging_consistency`, `sleep_consistency`, `plan_adherence`.

---

## 12. Check-ins

### `POST /api/checkins`
Serves the mood selector and note (audit items 8 & 9).
```ts
{ localDate?: date, mood: 'low'|'okay'|'good'|'great',
  dayTag?: 'normal'|'busy'|'better_than_expected'|'not_as_planned',
  energy1to5?: int(1..5), note?: string(0..1000) }
```
Upsert per day. `201`/`200`.

### `GET /api/checkins?from=&to=`

---

## 13. Insights (§7)

### `GET /api/insights/today`

**Reads cache — never triggers an AI call** (§26, Rule: no AI on read).

```json
{ "localDate": "2026-09-06",
  "narrative": "You're doing pretty well today. Your energy is staying steady despite schedule adjustments.",
  "structured": {
    "observations": ["3 meals logged, all home-cooked", "Walk replaced the planned gym session"],
    "deviations":   [{ "planned": "Gym 17:30", "actual": "Walk 18:30", "framing": "substituted" }],
    "suggestions":  [{ "text": "A warm canh with dinner would round out the day gently",
                       "kind": "meal", "actionable": true }]
  },
  "confidence": 0.84, "computedAt": "2026-09-06T13:05:00Z", "stale": false }
```

`204 No Content` when the day has fewer than 2 events — AURA says nothing rather than
manufacturing an observation from one data point.

### `GET /api/insights/weekly?weekStart=`
Serves `InsightsView` reels (audit item 11), read from `weekly_summaries`.

```json
{ "weekStart": "2026-08-31",
  "reels": [ { "title": "Weekday Harmony", "tag": "Mon - Wed", "desc": "…",
               "badge": "Peak Flow", "color": "primary" } ],
  "highlights": [...], "metrics": { "daysLogged": 6, "avgPlanAdherence": 0.71,
  "workoutsCompleted": 3, "distinctFoods": 34 },
  "narrative": "…", "computedAt": "…" }
```

The `reels` shape matches `InsightsView.tsx:17` exactly, so the component's props do not change
— only their origin does.

### `POST /api/insights/:id/feedback`
```ts
{ rating: 'helpful'|'not_helpful'|'wrong', comment?: string(0..500) }
```
Writes `ai_feedback`. `wrong` on a pattern-derived insight also flags the pattern for
recomputation — user contradiction is the strongest available signal that a correlation is spurious.

---

## 14. Patterns (§15)

### `GET /api/patterns?status=active&limit=5`

Serves "AURA noticed something" (audit item 10).

```json
{ "data": [
  { "id": "uuid", "kind": "correlation",
    "subjectMetric": "bedtime", "objectMetric": "breakfast_logged",
    "direction": "negative", "strength": -0.62, "sampleSize": 14, "windowDays": 30,
    "support": 0.75, "status": "active",
    "narrative": "Trong dữ liệu 14 ngày gần đây, những ngày bạn ngủ muộn sau 23:45 thường đi kèm với việc bữa sáng được ghi nhận muộn hơn hoặc không được ghi.",
    "narrativeEn": "In your data over the last 14 days, later bedtimes often appeared alongside a later or unlogged breakfast.",
    "caveat": "This is an association in your own logs, not a cause.",
    "firstDetectedAt": "2026-08-24T…" } ] }
```

Every pattern response carries `caveat`, and it is **not optional** — the field is required by
the response schema so a client cannot render a correlation without its hedge (§15, §31).

### `GET /api/patterns/:id/series`
The exact series behind the chart at `InsightsView.tsx:137`:
```json
{ "windowDays": 30, "points": [ { "date": "2026-08-20", "subject": 1425, "object": 1 } ],
  "subjectLabel": "Bedtime (min past midnight)", "objectLabel": "Breakfast logged" }
```

### `POST /api/patterns/:id/dismiss`
Sets `status='dismissed'`; excluded from detection for 60 days. Users must be able to say
"that's not a real thing about me."

---

## 15. Agent (§17)

### `POST /api/agent/chat` — replaces the keyword matcher (audit item 14)

```ts
{ message: string(1..2000), conversationId?: uuid }
```

Streams by default (`text/event-stream`); set `Accept: application/json` for a single response.

```json
{ "conversationId": "uuid", "reply": "…",
  "suggestionPill": "Would you like a 5-minute restorative bedtime breathing prompt?",
  "usedContext": ["daily_summary:2026-09-06", "pattern:sleep-breakfast"],
  "safetyFlag": null, "aiRunId": "uuid" }
```

`usedContext` makes the agent auditable — you can always see which facts shaped a reply.

`safetyFlag` is non-null when the message trips a health-safety rule (`SECURITY.md` §7,
`AI_ARCHITECTURE.md` §6); the reply is then a supportive redirect toward a trusted person or
professional, and **the model is not asked to advise**.

Rate limit: 30/hour.

### `POST /api/agent/analyze-day`
```ts
{ localDate?: date, force?: boolean }
```
`202` + insight. Idempotent per day unless `force`. Rate-limited to 3/day even with `force`.
Normally invoked by the scheduler, not the client.

### `POST /api/agent/analyze-week`
`{ weekStart?: date, force?: boolean }` → `202`. Long-running (20–60 s), 1/week unless forced.

### `POST /api/agent/suggest-meal`
```ts
{ mealType?: MealType, context?: 'quick'|'light'|'comfort'|'balanced' }
```
Suggestions are drawn from `frequent_meals` + preferences + what the day already contains —
grounded in the user's own history, never a generic recipe list.

### `GET /api/agent/chat/history?conversationId=&limit=&cursor=`

---

## 16. Groups (§8 accountability)

### `POST /api/groups` `{ name: string(1..40) }` → group + `inviteCode`
### `POST /api/groups/join` `{ inviteCode: string(6..12) }`
### `GET /api/groups/:id` — members, streaks, status quotes (serves `CrewView`)
### `GET /api/groups/:id/feed?limit=&cursor=` — activity + reactions
### `POST /api/groups/:id/cheer` `{ targetUserId: uuid, kind: 'five'|'tea' }`
### `POST /api/groups/:id/feed/:eventId/react` `{ emoji: string(1..8) }`
### `DELETE /api/groups/:id/leave`

**Privacy rule, enforced server-side:** the group feed exposes only
`{ activity title, type, time-ago, streak }`. Never nutrition figures, weight, mood, photos,
skip reasons, or insights. A member sees *that* you logged dinner, never *what* you ate or
how you felt. This is a schema-level guarantee — `group_events.summary` is a generated string,
and the join that would expose meal detail does not exist in the repository layer.

Group size capped at 12 (`member_limit`) to keep it accountability, not a social network.

---

## 17. Rate limits

| Bucket | Limit | Applies to |
|---|---|---|
| global | 300 / 15 min / user | all authenticated |
| auth | 10 / 15 min / IP | `POST /auth/session` |
| ai-vision | 20 / day / user | `analyze-image` |
| ai-text | 10 / hour / user | `meals/parse` |
| ai-chat | 30 / hour / user | `agent/chat` |
| ai-heavy | 3 / day / user | `analyze-day`, `analyze-week`, `plan/generate` |
| nutrition | 60 / min / user | `search`, `calculate`, `barcode` |
| write | 120 / hour / user | all mutating endpoints |

Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`.
Buckets are per-user (from the JWT), falling back to IP only for unauthenticated routes.

---

## 18. What the frontend needs, mapped

| Audit item | Component | Endpoint |
|---|---|---|
| 1 | `LogModal` save | `POST /api/meals` · `POST /api/meals/:id/confirm` |
| 2 | `LogModal` describe | `POST /api/meals/parse` |
| 3 | `LogModal` photo **(build UI)** | `POST /api/meals/analyze-image` |
| 4 | `LogModal` portions | `POST /api/nutrition/calculate` |
| 5 | Quick add **(build UI)** | `GET /api/meals/frequent` · `POST /api/meals` |
| 6 | `TodayView` timeline | `GET /api/events/today` |
| 7 | Plan vs Actual | `GET /api/daily-plan/comparison` |
| 8, 9 | Mood + note | `POST /api/checkins` |
| 10 | "AURA noticed" | `GET /api/patterns` |
| 11 | Weekly reels | `GET /api/insights/weekly` |
| 12 | Correlation chart | `GET /api/patterns/:id/series` |
| 13 | `HistoryView` | `GET /api/events?from=&to=` |
| 14 | `AICoachView` | `POST /api/agent/chat` |
| 15 | `CrewView` | `/api/groups/*` |
| 16 | Header streak | `GET /api/users/me` |

Every one of the 16 identified integration points has a defined endpoint. No endpoint in this
specification exists without a consumer.

---

## 19. Phase 2 implementation notes

What shipped, and where the implementation pinned down something this document left open.

**Implemented.** `/api/health`, `/api/auth/{session,me,logout}`, `/api/users/me{,/preferences}`,
`/api/daily-plan{,/:id,/comparison}`, `/api/events{,/today,/:id}`, `/api/checkins`.

**Not implemented, by phase.** `/api/daily-plan/generate` needs Claude (Phase 4). `/api/meals/*`
and `/api/nutrition/*` are Phase 3. `/api/workouts/*` and `/api/habits/*` have their tables but
not their endpoints. `/api/insights/*`, `/api/patterns/*` and `/api/agent/*` are Phases 4–5.
`/api/groups/*` is Phase 8.

**`POST /api/events` accepts only `walk`, `water`, `sleep`, `habit` and `custom`.** §7 calls it
the logger "for types without a richer endpoint"; `meal` and `workout` own detail tables this
endpoint cannot populate, and accepting them would create events with no detail row. `checkin`
has its own upsert-per-day endpoint. The rejected types return `400`.

**`DELETE /api/users/me` returns** `{ "status": "scheduled", "hardDeleteAfterDays": 30 }` —
soft-deleted immediately, hard-deleted by a Phase 5 job. A soft-deleted account cannot
authenticate again even though Supabase keeps issuing valid tokens for it.

**`POST /api/checkins` returns `201` on create and `200` on update**, since it is an upsert.

**Pagination cursors** are an opaque base64url encoding of `(occurredAt, id)`. A malformed
cursor is a `400`, not a silently ignored parameter.

**Every request body is `.strict()`.** An unknown key is a `400`, which is what makes
"a client cannot send `userId`" a test rather than a convention: the field does not exist in
any schema, so sending it fails loudly instead of being ignored.

**`GET /api/daily-plan/comparison`** reconciles before answering, so it never returns a stale
adherence value. `adherencePct` counts `on_time`, `shifted` and `substituted` alike over
resolved items only — see `DATABASE_DESIGN.md` §3.9.

---

## 20. Phase 3 additions

**Implemented.** `/api/meals` (`POST`, `POST /parse`, `GET /today`, `GET /:id`, `PATCH /:id`,
`POST /:id/confirm`, `DELETE /:id`), `/api/nutrition` (`GET /search`, `POST /calculate`,
`GET /daily`, `GET /weekly`).

**Still deferred.** `POST /api/meals/analyze-image` and the Gemini pipeline are Phase 4.
`GET /api/nutrition/barcode/:code` has provider support (`OpenFoodFactsProvider.getByBarcode`)
but no route, because nothing consumes it until the scanner UI exists. `GET /api/meals/frequent`
has repository support and no route, for the same reason.

**No meal input schema contains a nutrition field.** Not `kcal`, not `protein`, not `grams` —
a request says *what* and *how much*, and the server does the rest. Combined with `.strict()`,
a client attempting `{ "calories": 900 }` receives a `400`, so the rule is enforced by the
type system rather than by convention.

**`GET /api/nutrition/search` is unauthenticated**, alongside `/api/health`. Food data is
public reference material, not user content.

**`showCalories: false` omits the field** from every meal, daily and weekly payload rather
than nulling it. See `NUTRITION_ARCHITECTURE.md` §10.

**`GET /api/nutrition/weekly`** returns totals and averages over *days actually logged*, not
over seven. Dividing by seven would report a drop that describes the tracking rather than the
eating. It contains no interpretation — Phase 4 reads these facts, it does not get to invent
them.

**Meal lifecycle.** `draft` has no event and appears in no total; `confirmed` has an event
and is on the timeline. `POST /meals/parse` always produces a draft, because parsing is the
least certain step and its output is something the user reviews rather than something that
silently becomes their data. `PATCH /meals/:id` pins every item to confidence 1.0 — the user
outranks every provider — and writes a `user_food_aliases` row so the same phrase resolves
correctly next time.

**Unresolved items** carry `kcal: null` and appear in the response's `unresolved[]`. A meal
total containing an unresolved item is itself `null` rather than the sum of what happened to
resolve.

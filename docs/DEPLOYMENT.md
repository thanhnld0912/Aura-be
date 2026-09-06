# AURA — Deployment

---

## 1. Target topology

```
aura-companion (static SPA)  →  Vercel
server (Fastify container)   →  Railway            ← always-on, not serverless
PostgreSQL 16                →  Supabase (Singapore region)
Object storage               →  Supabase Storage (private bucket)
Auth                         →  Supabase Auth
Scheduled jobs               →  Railway cron service (same image, different entrypoint)
AI                           →  Anthropic + Google
Nutrition                    →  USDA FDC + Open Food Facts
```

Singapore region for Supabase: the user base is Vietnamese, and ~30 ms of database latency
beats ~200 ms from a US region on every single request.

---

## 2. Why the API is not serverless

§25 asks whether serverless suits the workload. For most endpoints it would. For three of
them it does not, and those three are the product's differentiators:

| Workload | Duration | Serverless problem |
|---|---|---|
| `POST /meals/analyze-image` | 3–10 s | Upload + vision + 2 nutrition lookups; near common timeouts, and cold starts land on the user's most latency-sensitive interaction |
| `POST /agent/analyze-week` | 20–60 s | Exceeds most function timeouts outright |
| Nightly pattern + narration batch | minutes | Needs a scheduler, retries, and no request to hang off |

Two further reasons independent of duration:

- **Connection pooling.** Serverless functions each open a Postgres connection. Supabase's
  pooler handles this, but a long-lived container simply avoids the problem.
- **Prompt caching.** Anthropic's cache works on prefix match across requests; a warm,
  long-lived process with a stable system prompt gets consistent cache hits. Cold, short-lived
  invocations are less predictable.

**Recommendation: one always-on container.** At MVP scale a single 512 MB–1 GB instance
handles the load comfortably. Vercel remains right for the frontend — it is a static SPA.

### When to add a queue

Not yet (§32 — do not over-engineer). Add BullMQ + Redis + a worker process when **any** of
these becomes true:

- p95 latency on `analyze-image` exceeds ~8 s under real load
- the Sunday batch for all users exceeds ~10 minutes wall clock
- a single user's weekly analysis exceeds 60 s
- retry logic for failed AI calls becomes non-trivial

Until then the cron service runs the batch sequentially with per-user error isolation. That is
strictly simpler, and the trigger conditions above are written down so the decision is made on
evidence rather than anticipation.

---

## 3. Environment

```bash
# server/.env.example — names only, never values

NODE_ENV=development
PORT=3001
LOG_LEVEL=info

# Database
DATABASE_URL=postgresql://user:pass@host:5432/aura
DATABASE_POOL_MAX=10

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=      # bypasses RLS — server only
SUPABASE_JWT_SECRET=
SUPABASE_STORAGE_BUCKET=meal-photos

# AI — server only, never exposed to the client
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
AI_MODEL_REASONING=claude-opus-5
AI_MODEL_EXTRACTION=claude-haiku-4-5
AI_MODEL_VISION=gemini-2.5-flash

# Nutrition
USDA_API_KEY=
USDA_BASE_URL=https://api.nal.usda.gov/fdc/v1
OPEN_FOOD_FACTS_BASE_URL=https://world.openfoodfacts.org
OPEN_FOOD_FACTS_USER_AGENT=AURA/1.0 (contact@example.com)

# Security
CORS_ORIGIN=http://localhost:3000,https://aura.example.com
RATE_LIMIT_ENABLED=true

# Jobs
CRON_ENABLED=true
CRON_TIMEZONE=Asia/Ho_Chi_Minh
```

```bash
# aura-companion/.env.local.example
VITE_API_BASE_URL=http://localhost:3001/api
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=          # public by design, guarded by RLS
```

Config is parsed **once at boot through a Zod schema** in `server/src/config/env.ts`. A
missing or malformed variable crashes the process at startup with a readable message rather
than producing an `undefined` API key that fails opaquely on the first user request an hour
later.

`OPEN_FOOD_FACTS_USER_AGENT` is not optional — OFF blocks anonymous clients.

---

## 4. Local development

```bash
# once
git clone <repo> && cd AURA

cd aura-companion && npm install    # commits package-lock.json — see FRONTEND_AUDIT R1
cd ../server && npm install
cp .env.example .env                # fill in keys
npm run db:migrate
npm run db:seed                     # system habits + Vietnamese food dataset

# each session
cd server && npm run dev            # :3001
cd aura-companion && npm run dev    # :3000
```

Postgres locally via Docker (`docker compose up db`) or a Supabase free project.
Docker Compose covers Postgres only — the API runs on the host for fast reload.

---

## 5. CI/CD

```
push → GitHub Actions
  ├── frontend:  npm ci → tsc --noEmit → build
  ├── server:    npm ci → tsc --noEmit → vitest → build
  ├── security:  npm audit (fail high/critical) + gitleaks
  └── on main:   Vercel (frontend) · Railway (server + cron)
```

Migrations run as a **release command before the new container takes traffic**, never at
application boot — two instances racing `db:migrate` on startup is a corruption path.

Environments: `local` → `staging` (own Supabase project, real keys, seeded data) →
`production`. Staging exists specifically so AI prompt changes can be evaluated against
realistic data before they reach users.

---

## 6. Scheduled jobs

```
02:00 Asia/Ho_Chi_Minh   recompute daily_summaries (yesterday)
02:15                    run pattern detectors
02:30                    narrate newly-active patterns
03:00                    generate daily insights for users with ≥2 events
Sun 03:00                weekly_summaries + weekly narrative
04:00                    sweep meal drafts >24 h → discarded
Sun 05:00                purge soft-deleted rows past 30 days
```

Same container image, `node dist/jobs/scheduler.js` entrypoint. Per-user error isolation: one
user's failure is logged and skipped, never aborting the batch.

---

## 7. Observability

Health: `GET /api/health` with database, storage and provider checks
(provider checks cached 60 s, never blocking — a degraded AI vendor must not mark the API
unhealthy and trigger a restart loop).

Metrics that actually get watched:

| Metric | Source | Why |
|---|---|---|
| p50/p95/p99 latency by route | request log | `analyze-image` is the one to watch |
| `ai_runs.status='schema_error'` rate | DB | **primary health signal for prompt changes** |
| AI cost per active user per day | `ai_runs` | keeps §26 honest |
| Nutrition `unresolved` rate | `meal_items` | tells you what the VN dataset is missing |
| Pattern narration count/week | `patterns` | a spike means the gates are too loose |
| 5xx rate, DB pool saturation | platform | standard |

The `unresolved` rate is the most product-useful of these: it is a direct, ranked backlog of
which Vietnamese foods to add to `LocalFoodProvider` next, derived from what users actually ate.

Alerts: 5xx > 1% over 5 min · p95 > 5 s · schema-error rate > 5% · daily AI cost > 2× the
trailing 7-day mean · health check failing 2 consecutive minutes.

---

## 8. Scaling path

| Stage | Users | Change |
|---|---|---|
| MVP | < 1k | 1 container, Supabase free/pro, no cache |
| Growth | 1k–10k | 2 containers behind the platform LB, Redis for rate limits + insight cache, read replica |
| Scale | 10k+ | Queue + workers for AI, CDN for signed photo URLs, partition `daily_events` by month |

`daily_events` is the table that grows fastest — roughly 8 rows/user/day, so ~3k/user/year.
Partitioning by month becomes worthwhile somewhere past 10k active users; the indexes in
`DATABASE_DESIGN.md` §4 carry it comfortably until then.

---

## 9. Cost estimate

| Item | MVP (~100 users) | 1,000 users |
|---|---|---|
| Vercel (frontend) | $0 | $20 |
| Railway (API + cron) | ~$10 | ~$40 |
| Supabase (DB + storage + auth) | $0–25 | ~$25 |
| AI (§7 of `AI_ARCHITECTURE.md`) | ~$130 | ~$1,300 |
| USDA / OFF | $0 | $0 |
| **Total** | **≈ $145/mo** | **≈ $1,385/mo** |

**AI is ~90% of the bill at every scale.** Infrastructure is a rounding error. This is why
§26's discipline — no AI on read, cached insights, capped daily analysis, narration only for
newly-active patterns — is an architectural requirement rather than an optimisation to revisit
later. Every lever that matters is in the AI layer.

---

## 10. Backup and recovery

Supabase daily automated backups with point-in-time recovery on the Pro plan. Storage objects
replicated by the provider. Migrations are checked into git, so schema is reproducible from
source.

Restore procedure is documented and **rehearsed once before launch** — an untested backup is
an assumption, not a backup.

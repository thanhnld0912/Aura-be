# AURA — AI Health & Fitness Companion

A companion that observes behaviour over time and reflects it back — not a calorie tracker,
not a gym chatbot.

```
PLAN → LIVE DAY → LOG ACTUAL → COMPARE → ANALYZE → DISCOVER PATTERNS → SUGGEST → ADAPT
```

---

## Two independent projects

AURA consists of two independent projects, each with its own git repository:

| Project | Location | Role |
|---|---|---|
| **AURA-FE** | `E:\Code\AURA-FE` | Frontend web application |
| **AURA-BE** | `E:\Code\AURA-BE` *(this repo)* | Backend / API / business logic |

```
┌──────────────────────┐
│       AURA-FE        │
│ React / existing UI  │
└──────────┬───────────┘
           │ HTTPS REST API
           ▼
┌──────────────────────┐
│       AURA-BE        │
│ API / AI / Nutrition │
│ Business Logic       │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Supabase PostgreSQL  │
└──────────────────────┘
```

### This repository

```
AURA-BE/
├── server/            # backend — Fastify 5 · TypeScript · Drizzle · PostgreSQL
├── shared/            # domain types + Zod schemas
├── docs/              # architecture
└── README.md
```

### The frontend repository

```
AURA-FE/
├── src/               # React 19 · Vite 6 · Tailwind 4 · TypeScript
├── public/
├── package.json
├── tsconfig.json
└── vite.config.ts
```

The frontend is the existing, working application and is kept as-is. It reaches the backend
only over HTTPS, and never touches the database or an AI provider directly.

> **Open item:** `shared/` lives in this repository. Now that the two projects are split, the
> frontend can no longer consume it by relative path — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §10.

---

## Status

**Phase 0 (Audit) complete. Awaiting architecture confirmation before implementation.**

| | |
|---|---|
| Frontend | Complete UI prototype — 13 files, ~3,200 lines. No backend, DB, API, AI, or auth. |
| Backend | Not yet implemented — designed |
| Database | Designed (`docs/DATABASE_DESIGN.md`) |

---

## Documentation

Read in this order:

| Document | Covers |
|---|---|
| [`docs/FRONTEND_AUDIT.md`](docs/FRONTEND_AUDIT.md) | What exists today, what to keep, 16 integration points |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, decisions, trade-offs |
| [`docs/DATABASE_DESIGN.md`](docs/DATABASE_DESIGN.md) | Schema, ERD, indexes, constraints |
| [`docs/API_DESIGN.md`](docs/API_DESIGN.md) | Every endpoint, request, response, error |
| [`docs/AI_ARCHITECTURE.md`](docs/AI_ARCHITECTURE.md) | Claude + Gemini, validation, safety, cost |
| [`docs/NUTRITION_ARCHITECTURE.md`](docs/NUTRITION_ARCHITECTURE.md) | USDA + Open Food Facts + Vietnamese food DB |
| [`docs/PATTERN_ENGINE.md`](docs/PATTERN_ENGINE.md) | How behavioural patterns are computed |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Auth, validation, uploads, health safety |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Hosting, env, jobs, observability, cost |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Phases 0–9 |

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite 6, Tailwind CSS 4, TypeScript 5.8 |
| Backend | Node.js 22, Fastify 5, TypeScript, Zod |
| Database | PostgreSQL 16 (Supabase), Drizzle ORM |
| Auth | Supabase Auth (JWT verified server-side) |
| Storage | Supabase Storage (meal photos) |
| Reasoning AI | Claude (`claude-opus-5`) |
| Vision AI | Gemini (`gemini-2.5-flash`) |
| Nutrition | USDA FoodData Central · Open Food Facts · local Vietnamese dataset |

---

## Principles

1. **Planned and Actual are different data.** A plan is an intention; an event is an
   observation. The difference between them is the product.
2. **Patterns are computed, then narrated.** Postgres does the statistics; Claude writes the
   sentence. Never the other way round.
3. **Nutrition comes from a database.** The model identifies food; it never states calories.
4. **Every AI output is schema-validated.** A model response is input, not truth.
5. **The user outranks the AI.** Every estimate carries a source and a confidence, and every
   one can be corrected.
6. **Correlation is never described as causation.** Enforced by schema, not just by prompt.
7. **AI is additive.** With every model offline, logging, plans, history and nutrition still work.
8. **No judgmental vocabulary.** There is no `failed` or `missed` anywhere in the data model.

---

## Getting started

Nothing to run in this repository yet — the backend is designed, not implemented.
Backend setup lands in Phase 1; see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §4.

The frontend runs from its own repository:

```bash
cd E:\Code\AURA-FE
npm install        # commit the resulting package-lock.json
npm run dev        # http://localhost:3000
```

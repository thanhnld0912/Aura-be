# FRONTEND AUDIT — `aura-companion`

> Audit date: 2026-09-06 · Phase 0 · No code was modified during this audit.
> The frontend was relocated from `e:\Code\aura-companion` to `e:\Code\AURA\aura-companion`
> as a **pure directory move** — all 22 files verified byte-for-byte identical by MD5 manifest.

---

## 1. Facts

| Property | Value |
|---|---|
| Path | `AURA/aura-companion/` |
| Framework | React **19.0.1** + Vite **6.2.3** |
| Language | TypeScript **5.8** (`noEmit`, bundler resolution, `jsx: react-jsx`) |
| Styling | Tailwind CSS **4.1.14** via `@tailwindcss/vite` (CSS-first `@theme`, no `tailwind.config.js`) |
| Package manager | npm — **no lockfile present**, `node_modules` not installed |
| Icons | `lucide-react` + Google **Material Symbols Outlined** (CDN) |
| Animation | `motion` 12.23 (declared; used only via Tailwind `animate-in` utilities) |
| Font | Plus Jakarta Sans (Google Fonts CDN) |
| Origin | Google **AI Studio** scaffold — app `83cebb9c-02bb-4b02-8506-d93e0361ddaf` |
| Source size | 13 files, ~3,217 lines |
| Backend | **None** |
| Database | **None** |
| API layer | **None** — zero `fetch`/`axios`/XHR calls in `src/` |
| AI integration | **None** — `@google/genai` declared but never imported |
| Auth | **None** |
| Router | **None** — tab state via `useState<TabType>` |
| State management | **None** — local `useState` in `App.tsx`, prop-drilled |
| Persistence | **None** — no `localStorage`/`sessionStorage`/IndexedDB. A refresh wipes all state. |
| Tests | **None** |
| Linting | `npm run lint` = `tsc --noEmit` only. No ESLint/Prettier. |

**Verdict:** a high-fidelity, well-crafted **UI prototype**. Not a partially-built application.
Every interactive flow is simulated with `setTimeout`. This is *good news* — there is no
wrong-headed data layer to unpick. The backend gets a clean slate and a finished visual target.

---

## 2. File inventory

```
aura-companion/
├── index.html                       # CDN fonts, M3 body classes
├── metadata.json                    # AI Studio manifest
├── package.json                     # ⚠ name: "react-example"
├── tsconfig.json                    # ⚠ no include/exclude
├── vite.config.ts                   # @ alias → project root
├── .env.example                     # GEMINI_API_KEY, APP_URL (AI Studio injected)
├── public/assets/aistudio/
└── src/
    ├── main.tsx              10 L   # StrictMode + createRoot
    ├── App.tsx              189 L   # tab router, all app state, all handlers
    ├── types.ts              97 L   # ⚠ view-models, not domain models
    ├── index.css             89 L   # ✅ full Material 3 token palette
    ├── data/initialData.ts  283 L   # ASSETS + 4 seed exports
    └── components/
        ├── Header.tsx       227 L
        ├── BottomBar.tsx     67 L
        ├── TodayView.tsx    399 L   # timeline, mood, Plan vs Actual spotlight
        ├── InsightsView.tsx 438 L   # patterns, correlation chart, weekly reels
        ├── HistoryView.tsx  201 L   # ⚠ own inline mock data
        ├── CrewView.tsx     328 L   # social feed, reactions
        ├── AICoachView.tsx  202 L   # ⚠ keyword-matched fake chat
        └── LogModal.tsx     687 L   # ⚠ largest file; the meal-logging core
```

---

## 3. KEEP — do not touch

### 3.1 The design system (`src/index.css`)

A complete **Material 3 token palette** is already declared under Tailwind 4's `@theme`:
47 semantic colour tokens (`--color-primary: #9f4118`, `--color-secondary-container: #adedd0`,
`--color-surface-bright: #fff8f3`, …) plus the `--font-sans` stack.

This *is* the design system. It is not to be replaced, extended by a different system, or
migrated to another framework. Warm terracotta / sage / lavender on cream — deliberately
calm, deliberately not a fitness-app red-and-black. That choice supports §31 (health safety):
the palette itself refuses the "aggressive optimisation" register.

### 3.2 The five tabs

`TabType = 'today' | 'insights' | 'history' | 'crew' | 'ai-coach'`

These map cleanly onto the product spec. **No new top-level views are required for MVP.**
`Meals`, `Workouts` and `Habits` from §2 are not missing — they are *correctly* folded into
`TodayView` (the timeline) and `LogModal` (the composer). Adding separate tabs would fragment
the "one gentle daily rhythm" concept the UI is built around.

### 3.3 `ActivityCategory` — the single most valuable existing contract

```ts
type ActivityCategory = 'eat' | 'workout' | 'walk' | 'water' | 'sleep' | 'check-in' | 'other';
```

This maps **1:1** onto the §12 extensible event model. The backend `daily_events.type`
enum is derived directly from this union rather than invented independently.
`'check-in'` is normalised to `checkin` at the DB boundary (see `DATABASE_DESIGN.md`).

### 3.4 The editorial voice — a hard constraint on AI prompts

The existing copy already encodes the §15 and §31 safety posture:

| Location | Copy | Encodes |
|---|---|---|
| `InsightsView.tsx:96` | "Gentle Correlation" | correlation ≠ causation |
| `InsightsView.tsx:100` | "a ripple gently touched the rest of your day" | associative, not causal |
| `InsightsView.tsx:120` | "Replaced by slow rest — totally valid" | non-judgmental |
| `InsightsView.tsx:131` | "No guilt or strict rules needed" | anti-obsession |
| `initialData.ts:90` | `statusBadge: "Different from plan"` | not "FAILED" |
| `TodayView.tsx:255` | "You changed the plan, but you didn't abandon the day." | adaptive framing |
| `AICoachView.tsx` header | "Zero Guilt · Gentle Coaching" | product promise |

**Implication:** the Claude system prompts in `server/src/agent/llm/prompts/` must be
written to *reproduce this exact register*. The tone is not a backend design choice that is
still open — it is already shipped in the UI, and the model must match it. `AI_ARCHITECTURE.md`
treats these strings as the style reference.

### 3.5 Structures the backend must serve as-is

- `TimelineSection` → grouped by `period` (Morning / Afternoon / Evening) with `timeRange`.
  The backend returns flat events; **grouping stays a frontend concern**.
- `TodayView` "Plan vs. Actual Spotlight" (line 224) — the §11 core loop already has its UI.
- `InsightsView` weekly `reels` — the §7 Weekly Story already has its UI.
- `CrewView` reactions / high-fives — the §8 Groups feature already has its UI.

---

## 4. REFACTOR

### 4.1 `types.ts` holds view-models, not domain models — highest-value refactor

```ts
interface TimelineEvent {
  statusBadge?: string;                                  // presentation
  statusType?: 'warning'|'neutral'|'success'|'urgent';   // presentation
  extraPill?: { icon: string; text: string };            // presentation
  tags?: string[];                                       // presentation
}
```

Every field describes *pixels*. There is no id of a meal, no timestamp as a `Date`, no
nutrition, no confidence, no source. `FoodItem` carries `icon`, `tagColor`, `portionOptions`
— UI concerns — but **no nutrition data at all**.

**Approach — additive, not a rewrite:**

```
shared/types/                 →  domain models (Meal, DailyEvent, Pattern, …)
aura-companion/src/types.ts   →  KEPT as view-models
aura-companion/src/adapters/  →  NEW: domainEvent → TimelineEvent mappers
```

Components keep receiving exactly the props they receive today. Nothing re-renders differently.
The adapter layer absorbs the entire impedance mismatch.

### 4.2 Scattered mock data

`initialData.ts` exports 4 seeds, but `HistoryView.tsx:11` and `InsightsView.tsx:17` each
declare **their own inline mock arrays**. Before wiring, consolidate all mock data into
`src/data/` so there is exactly one place to swap for API calls.

### 4.3 Design tokens declared but unused

`index.css` defines 47 M3 tokens; components hardcode the same hex values
(`bg-[#fff8f3]`, `text-[#1e1b17]`, `bg-[#9f4118]`). Purely cosmetic, **zero functional risk**,
and it does not block backend work. Deferred to post-MVP. Do not bundle it with the
integration work — a token migration touching 8 files during API wiring makes both harder to review.

### 4.4 Prop drilling in `App.tsx`

8 handlers drilled through the tab switch. Acceptable today. Once server state arrives it should
become **TanStack Query** (cache, refetch, optimistic updates for meal logging) — not Redux/Zustand.
Almost all AURA state is server state; a client state library would mostly duplicate the cache.

---

## 5. CONNECT TO BACKEND

| # | Frontend site | Current behaviour | Target endpoint |
|---|---|---|---|
| 1 | `LogModal.tsx:66` `handleConfirmSave` | `setTimeout(600)` → success | `POST /api/meals` |
| 2 | `LogModal.tsx:79` `handleSimulateVoice` | hardcoded bún bò Huế after 1.5 s | `POST /api/meals/parse` |
| 3 | `LogModal.tsx` photo mode | **not implemented** | `POST /api/meals/analyze-image` |
| 4 | `LogModal.tsx:39–47` `handlePortionChange` | hardcoded `if (foodId === 'rice')` ±100 kcal | `POST /api/nutrition/calculate` |
| 5 | `LogModal.tsx:109` `handleQuickInspirationLog` | caller passes literal kcal | `POST /api/meals` (quick-add) |
| 6 | `App.tsx:19` `INITIAL_TIMELINE` | static seed | `GET /api/events/today` |
| 7 | `TodayView.tsx:224` Plan vs Actual | static markup | `GET /api/daily-plan` + comparison |
| 8 | `TodayView.tsx:36` `handleSaveNote` | `setTimeout(1200)` | `POST /api/checkins` |
| 9 | `TodayView` mood selector | local `useState` | `POST /api/checkins` |
| 10 | `InsightsView.tsx:86` "AURA noticed something" | static markup | `GET /api/patterns` |
| 11 | `InsightsView.tsx:17` `reels` | static array | `GET /api/insights/weekly` |
| 12 | `InsightsView.tsx:137` correlation chart | static SVG | `GET /api/patterns/:id/series` |
| 13 | `HistoryView.tsx:11` `historyEntries` | static array | `GET /api/events?from=&to=` |
| 14 | `AICoachView.tsx:59` chat | `if (text.includes('dinner'))` | `POST /api/agent/chat` |
| 15 | `CrewView` / `App.tsx:73–124` | local array mutation | `/api/groups/*` |
| 16 | `Header.tsx` streak | `useState(5)` | `GET /api/users/me` |

**Item 4 deserves emphasis.** `handlePortionChange` contains this:

```ts
if (foodId === 'rice')  calAdjustment = newPortion === 'Small' ? -100 : ...;
if (foodId === 'fish')  calAdjustment = newPortion === 'Small' ? -60  : ...;
return { ...prev, estCalories: Math.max(300, 540 + calAdjustment) };
```

Nutrition arithmetic hardcoded per food id inside a React component. This is exactly what
§6 / Rule 6 forbids. It must move behind `NutritionProvider` on the server. Listed here rather
than under REFACTOR because the fix *is* the backend connection.

---

## 6. ADD

### 6.1 ⚠ `activeMode` is decorative — the biggest hidden gap

`LogModal.tsx:21` declares `useState<'photo'|'describe'|'quick'>('describe')`, and the mode is
referenced at **only lines 217, 236, 258 — all three inside `className` ternaries**.

Switching modes changes button styling and **nothing else**. There is no photo body and no
quick-add body; the "Tell AURA" card renders unconditionally underneath.

Therefore §8 requires *building*, not wiring:

- **Photo mode** — file/camera input, preview, upload progress, detection-result state
- **Quick Add mode** — the Protein / Carb / Vegetable / Portion chip grid

These are the only genuinely new UI surfaces in the whole MVP. The mode bar that selects them
already exists and is styled, so the work is bounded and visually pre-specified.

### 6.2 Confidence & correction affordances (§9)

`LogModal.tsx:492` already renders `✓ Looks right — Add to today's timeline` and
`✏️ Edit details`. The **decision UI exists**; what is missing is the evidence for it —
nothing displays `confidence`, `source`, or `estimated`. Needs a small `ConfidenceBadge`
component plus per-food source attribution (`vision` / `usda` / `off` / `local` / `user`).

### 6.3 Net-new infrastructure

- `src/services/` — API client (see §21). **Confirmed absent**; build fresh, no duplication risk.
- Auth — Supabase session handling, login/signup, token attach, refresh, 401 handling
- `src/adapters/` — domain → view-model mappers (§4.1)
- TanStack Query provider + hooks
- Error boundaries, loading skeletons, offline/failed-request states — the prototype has
  **no error or empty states anywhere**, because nothing can currently fail. Every wired
  surface needs them.
- `.env.local` → `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

---

## 7. REMOVE

**No functionality is removed** (Rule 13).

Cleanup limited to scaffold residue in `package.json`, pending your approval:

| Item | Why | Risk |
|---|---|---|
| `express` ^4.21.2 | Never imported. **A backend framework inside the frontend package is an active hazard** — it invites the frontend→DB coupling Rule 3 forbids. | none |
| `@types/express` | ditto | none |
| `dotenv` ^17.2.3 | Never imported; Vite handles env natively | none |
| `@google/genai` ^2.4.0 | Never imported. **Rule 4/5: the frontend must never call Gemini directly.** Removing it makes that violation impossible rather than merely discouraged. | none |
| `esbuild`, `tsx` | AI Studio build residue; Vite bundles its own esbuild | none |
| `clean` script | `rm -rf dist server.js` — `server.js` does not exist | none |

Also recommended: rename `"name": "react-example"` → `"aura-companion"`, and add
`"include": ["src"]` to `tsconfig.json` so the frontend typecheck never reaches into `server/`.

---

## 8. Risks carried out of Phase 0

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **No lockfile.** `^19.0.1` etc. resolve fresh on every install — React 19 minors, Tailwind 4.x and Vite 6.x can shift under you. | **High** | `npm install` once, commit `package-lock.json` before any integration work. |
| R2 | **No tests, no error states.** Wiring 16 call sites into a prototype that cannot currently fail. | **High** | Adapter layer + TanStack Query error boundaries; wire one vertical slice (meals) end-to-end first. |
| R3 | `LogModal.tsx` is 687 lines and will absorb photo mode, quick add, confidence UI and 4 endpoints. | Medium | Split into `LogModal/` (`PhotoMode`, `QuickAddMode`, `DescribeMode`, `ConfirmPanel`) **before** wiring. Structural split only — no behaviour change. |
| R4 | View-model types leak presentation into the API contract if wired naively (backend tempted to return `statusBadge`). | Medium | Adapter layer is mandatory; the API returns domain data only. |
| R5 | AI Studio coupling (`metadata.json`, `APP_URL`, `DISABLE_HMR` in `vite.config.ts`). | Low | Harmless. Keep until you stop deploying from AI Studio. |
| R6 | Empty husk `e:\Code\aura-companion\` remains (Windows held the cwd handle during the move). | Low | Delete manually after restarting in the new root. |

---

## 9. Summary

| | |
|---|---|
| **KEEP** | design system, 5 tabs, all 8 components, `ActivityCategory`, editorial voice |
| **REFACTOR** | domain types + adapters, consolidate mocks, split `LogModal`, TanStack Query |
| **CONNECT** | 16 call sites |
| **ADD** | photo mode, quick-add mode, confidence UI, API client, auth, error states |
| **REMOVE** | nothing functional; 6 unused scaffold deps pending approval |

The frontend is in unusually good shape for this transition: small, coherent, visually finished,
and — critically — **uncontaminated by a wrong data layer**. The backend is not retrofitting
around bad decisions. It is filling a vacuum that was left in exactly the right shape.

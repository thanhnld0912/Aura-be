# AURA — Security

AURA stores health-adjacent personal data about people who may be young. The posture is
proportionate to that, not to a typical CRUD app.

---

## 1. Secrets — the hard boundary (Rules 4, 5)

| Variable | Lives in | Never in |
|---|---|---|
| `ANTHROPIC_API_KEY` | `server/.env` | frontend, git, client bundle, logs |
| `GEMINI_API_KEY` | `server/.env` | ” |
| `USDA_API_KEY` | `server/.env` | ” |
| `SUPABASE_SERVICE_ROLE_KEY` | `server/.env` | ” — this key bypasses RLS |
| `SUPABASE_JWT_SECRET` | `server/.env` | ” |
| `VITE_SUPABASE_ANON_KEY` | frontend | — public by design, guarded by RLS |
| `VITE_API_BASE_URL` | frontend | — public |

`.env` is gitignored; `.env.example` carries names and empty values only.

**Structural enforcement:** removing `@google/genai` from the frontend's `package.json`
(`FRONTEND_AUDIT.md` §7) means a frontend call to Gemini cannot compile, rather than merely
being discouraged by a rule someone might forget.

A pre-commit secret scan (`gitleaks`) runs in CI. Any key that has ever touched a commit is
treated as compromised and rotated — not un-committed.

---

## 2. Authentication and authorization

Supabase Auth issues the JWT; the backend verifies it on every request and owns all domain data.

```
Client → Supabase Auth → JWT
Client → server  (Authorization: Bearer <jwt>)
server → verify signature (JWKS, cached) → extract sub → users.id
```

Verification checks signature, `exp`, `iss`, and `aud`. Failures return `401 UNAUTHENTICATED`
with no detail about which check failed.

**The authorization rule that does the real work:** `user_id` is taken from the verified token
and **never** from a request body, query string, or path parameter. There is no endpoint in
`API_DESIGN.md` that accepts a `userId` input. Every repository method takes `userId` as its
first argument, sourced from the request context.

```ts
// every repository query, without exception
where(and(eq(meals.userId, ctx.userId), eq(meals.id, params.id)))
```

A resource owned by someone else returns `404`, not `403` — the two are deliberately
indistinguishable so the API cannot be used to enumerate which ids exist.

RLS on every user-owned table is the second lock (`DATABASE_DESIGN.md` §6). The backend uses
the service role and bypasses it; RLS exists so a leaked anon key cannot read another user's
rows directly.

---

## 3. Input validation

Every request body, query and param passes a Zod schema before reaching a handler. Fastify's
`setValidatorCompiler` wires this globally, so an unvalidated route is not possible by
omission — a route without a schema fails to register.

Applied limits: string maxima on every text field, `1..N` bounds on arrays, positive-number
constraints on quantities, enum closure on every categorical field, `1 MB` JSON body cap,
rejection of unknown keys (`.strict()`).

**SQL injection** is structurally prevented: Drizzle parameterises everything, and the one
place raw SQL is used — the Pattern Engine — uses `sql` template literals with bound
parameters, never string concatenation. Metric names in dynamic queries come from a fixed
allowlist constant, never from user input.

---

## 4. File upload (§22)

Meal photos are the largest attack surface in the product.

| Control | Implementation |
|---|---|
| Size | 8 MB hard cap, enforced by Fastify multipart before buffering |
| Count | one file per request |
| Declared type | `image/jpeg`, `image/png`, `image/webp` only |
| **Actual type** | **magic-byte sniff** — the `Content-Type` header is not trusted |
| Re-encode | `sharp` decodes and re-encodes to WebP — this destroys any embedded payload |
| EXIF | stripped, including **GPS coordinates** |
| Dimensions | max 4096×4096; decompression-bomb guard on declared dimensions |
| Filename | discarded entirely; storage key is `u/<uid>/<yyyy>/<mm>/<ulid>.webp` |
| Storage | Supabase Storage, private bucket, **signed URLs with 1 h expiry** |
| Path | derived server-side from the authenticated uid — never client-supplied |

The re-encode step is the important one: a file that survives `sharp` decode/encode is a valid
image, not a polyglot. Nothing is served back from the original bytes.

GPS stripping is not incidental — a meal photo taken at home carries the user's home address
in EXIF, and this is a product used by people who may be minors.

---

## 5. Rate limiting

Per-user buckets from the JWT (IP only for unauthenticated routes), backed by Postgres at MVP
and Redis if traffic warrants. Limits are in `API_DESIGN.md` §17.

Rate limits here serve three purposes at once: abuse prevention, **cost control** (20 vision
calls/day bounds a user's AI spend at roughly $0.30/day), and protection of upstream quotas
(USDA allows 1,000 requests/hour per key across *all* users).

Auth endpoints are limited by IP at 10 per 15 minutes to blunt credential stuffing.

---

## 6. Transport and headers

`helmet` with an API-appropriate configuration: `HSTS` (1 year, preload), `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a restrictive CSP —
`default-src 'none'` is correct for a JSON API that serves no HTML.

CORS is an **explicit allowlist** from `CORS_ORIGIN`, never `*` and never reflected from the
`Origin` header. Credentials enabled, `Authorization` allowed, preflight cached 24 h.

TLS terminates at the platform; HTTP redirects to HTTPS. Cookies, if introduced later, must be
`HttpOnly` + `Secure` + `SameSite=Lax`.

---

## 7. Health-specific safety

This is where AURA's threat model differs from an ordinary API. Full treatment in
`AI_ARCHITECTURE.md` §6; the security-relevant controls:

- **Age gate.** `dateOfBirth` must be ≥13 years ago; under-13 registration is rejected. If
  the product later targets school-age users explicitly, this needs a proper minors-privacy
  review before launch, not after.
- **Output filtering.** AI output passes a blocklist for fasting encouragement, extreme
  restriction, purging, appearance ideals, and medical diagnosis before it can be persisted.
- **Crisis routing.** Inputs flagged for disordered-eating signals, self-harm, or acute
  medical symptoms are **not sent to the model as advice requests**. A templated supportive
  response points to a trusted adult or professional. Recorded with `safetyFlag`.
- **Schema-level tone constraints.** `framing` cannot be `"failed"`; `caveat` cannot be
  omitted. The type system enforces what a prompt can only request.

### Group privacy (§16 of the API spec)

Group members see `{ activity title, type, time-ago, streak }` and nothing else. Never
nutrition figures, weight, mood, photos, skip reasons, or insights. This is enforced in the
repository layer — the join that would expose meal detail to a group query does not exist —
rather than by filtering in a serializer, where a future refactor could reintroduce it.

---

## 8. Prompt injection

Covered in `AI_ARCHITECTURE.md` §9. The architectural summary: the reasoning model has **no
tools**, cannot read the database, cannot call endpoints, and cannot fetch URLs. Its output is
schema-validated, never `eval`'d, never rendered as HTML, never used to build a query. A
successful injection can only produce text that then fails validation.

User content is always a `user` message. Operator instructions use the mid-conversation
`{"role": "system"}` message form rather than string interpolation into the system prompt.

---

## 9. Logging and privacy

**Never logged:** raw prompts, meal photo bytes, `Authorization` headers, API keys,
free-text notes, chat message content.

**Logged:** `requestId` (ULID), `userId`, method, path, status, duration, and for AI calls the
`ai_runs` row — purpose, model, tokens, cost, latency, schema-validation outcome.

Structured JSON logs via `pino` with a redaction list. Errors report a `requestId` to the
client and keep the stack trace server-side; internal error messages are never returned.

Retention: application logs 30 days, `ai_runs` 12 months (cost analysis), user data until
deletion. `DELETE /api/users/me` soft-deletes immediately and hard-deletes after 30 days,
including storage objects.

---

## 10. Dependencies

`npm audit` in CI, failing on high/critical. Dependabot weekly. **Lockfiles committed on both
sides** — `FRONTEND_AUDIT.md` R1 flags the missing frontend lockfile as a high-severity issue
precisely because unpinned transitive dependencies are a supply-chain exposure, not just a
reproducibility annoyance.

---

## 11. Pre-launch checklist

- [ ] `.env` gitignored on both sides; `gitleaks` clean over full history
- [ ] All API keys server-side only; `@google/genai` removed from frontend
- [ ] JWT verification with `iss`/`aud`/`exp` checks
- [ ] `userId` sourced from token on 100% of endpoints — audited, not assumed
- [ ] RLS enabled and policy-tested on every user-owned table
- [ ] Zod schema on every route; unknown-key rejection on
- [ ] Upload: magic bytes, re-encode, EXIF strip, signed URLs verified
- [ ] Rate limits verified per bucket
- [ ] CORS allowlist explicit; no wildcard
- [ ] Helmet + HSTS + CSP configured
- [ ] Safety filters and crisis routing tested against a red-team prompt set
- [ ] Log redaction verified — no PII in log output
- [ ] Lockfiles committed; `npm audit` clean
- [ ] Account deletion tested end-to-end including storage objects

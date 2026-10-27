/**
 * Vercel entrypoint. It starts the same process `npm start` does — `src/index.ts` builds the
 * app and calls `listen()`, which Vercel's Fastify runtime turns into the function handler.
 *
 * Why this file exists: Vercel's Fastify preset takes the first of `app`, `index`, `server`,
 * `src/app`, `src/index`, `src/server` (any JS/TS extension) whose source imports `fastify`.
 * Without this file that is `src/app.ts`, which only exports `buildApp` and never listens.
 * `src/index.ts` does not import `fastify` itself, so it is never chosen.
 *
 * The type-only import below is erased at compile time; it is here solely so the preset
 * recognises this file. `tests/unit/vercel-entrypoint.test.ts` holds the selection rule.
 */
import type {} from 'fastify';
import './src/index.js';

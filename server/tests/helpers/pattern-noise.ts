import { addLocalDays } from '../../src/lib/local-date.js';
import { METRIC_KEYS, type DailyFeatures, type MetricKey } from '../../src/patterns/metrics.js';

/**
 * Seeded noise for the Pattern Engine (PATTERN_ENGINE.md §9, PATTERN_ENGINE_DECISIONS.md D13).
 *
 * Every metric is drawn **independently** of every other and of time, from a fixed-seed PRNG,
 * so the fixture contains no relationship between any two metrics and no trend. Each day is
 * observed with every metric present, so coverage never decides the outcome — the inferential
 * gates do. Values stay inside each metric's real range (mood 1–4, adherence 0–100, …).
 */

/** mulberry32: small, fast, and identical on every platform for a given seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EMPTY = Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<MetricKey, number | null>;

/** `days` consecutive observed days of independent noise, starting at `from`. */
export function noiseDays(seed: number, from: string, days: number): DailyFeatures[] {
  const random = seededRandom(seed);
  const int = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  return Array.from({ length: days }, (_, i) => ({
    localDate: addLocalDays(from, i),
    observed: true,
    values: {
      ...EMPTY,
      mood_score: int(1, 4),
      plan_adherence_pct: int(0, 100),
      logging_gap_hours: Math.round((0.5 + random() * 11.5) * 100) / 100,
      meals_logged: int(0, 4),
      sleep_minutes: int(300, 540),
      water_ml: int(0, 3000),
      distinct_foods: int(1, 12),
      workout_planned_time: int(0, 1) === 1 ? int(1080, 1260) : int(360, 1079),
      workout_completed: int(0, 1),
    },
  }));
}

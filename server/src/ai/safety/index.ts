/**
 * The safety layer (AI_ARCHITECTURE.md §6).
 *
 * ```
 * caller → screenInput → AiService → provider → Zod → safeDisplayText → caller
 * ```
 *
 * Deliberately free of domain types: nothing here imports a meal, a food or a unit, so
 * the same gates serve the vision and agent surfaces when they arrive. What varies by
 * surface is the *policy*, and that lives in one table in `safety-types.ts`.
 */

export {
  ACTIVE_CATEGORIES,
  isActive,
  type SafetyCategory,
  type SafetyDecision,
} from './safety-types.js';
export { screenInput } from './input-safety.js';
export { safeDisplayText, sanitizeDisplayText, screenOutputText } from './output-safety.js';
export { containsCausalClaim, filterCausalClaims, type CausalFilterResult } from './causal-filter.js';

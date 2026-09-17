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
export { containsProhibitedFraming } from './narrative-framing.js';
export { containsHarmfulFraming } from './narrative-framing.js';
export {
  EvidenceCollector,
  hasUnsafeMarkup,
  numbersIn,
  ungroundedNumbers,
  type EvidenceItem,
  type EvidenceKind,
} from './evidence-grounding.js';
export { screenCategories } from './input-safety.js';
export { outputCategories, PERSONAL_DISCLOSURE_CATEGORIES } from './safety-types.js';

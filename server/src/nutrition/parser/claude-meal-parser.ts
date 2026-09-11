import type { AiService } from '../../ai/ai.service.js';
import { AppError } from '../../lib/errors.js';
import type { MealParser, ParseContext, ParsedItem, ParsedMeal } from './meal-parser.js';
import {
  buildMealExtractionUserMessage,
  mealExtractionJsonSchema,
  mealExtractionSchema,
  MEAL_EXTRACTION_PROMPT_VERSION,
  MEAL_EXTRACTION_SYSTEM_PROMPT,
  type MealExtraction,
} from './meal-extraction.js';

/**
 * Reads a meal sentence with Claude, and falls back to the rule-based parser when that
 * does not work.
 *
 * ## Where this sits
 *
 * ```
 * MealsService → MealParser → ClaudeMealParser → AiService → ClaudeProvider → Anthropic
 *                                    └── on failure ──→ RuleBasedMealParser
 * ```
 *
 * It goes through `AiService` and never touches the Anthropic SDK. That is what buys the
 * retry budget, the schema gate and the `ai_runs` row without any of it being restated
 * here — this class supplies a prompt and a schema, and reads the result.
 *
 * ## What it may return
 *
 * A `ParsedMeal`, and nothing more. The interface has no field for a calorie, the Zod
 * schema is `.strict()`, and the mapping below copies five named properties rather than
 * spreading. A model that volunteers `kcal` fails validation instead of leaking a
 * fabricated number into someone's day (NUTRITION_ARCHITECTURE.md §1).
 */

/**
 * The extraction budget (AI_ARCHITECTURE.md §8). Extraction gets 30 seconds; the
 * reasoning path later gets far more. Stated here rather than inherited from
 * `AiService`'s default so that changing the service default cannot silently move it.
 */
const EXTRACTION_TIMEOUT_MS = 30_000;

export interface ClaudeMealParserDeps {
  ai: AiService;
  /** `env.AI_MODEL_EXTRACTION` — the extraction model, never the reasoning one. */
  model: string;
  /** Used whenever Claude cannot produce a usable reading. */
  fallback: MealParser;
  /** Overridden only by tests, so the suite does not wait out a real timeout. */
  timeoutMs?: number;
}

/**
 * The failures that mean "the model did not work", as opposed to "this code is broken".
 *
 * Every one of them is already written to `ai_runs` by `AiService` with its status and a
 * sanitised code, so falling back does not hide anything — a bad API key shows up as a
 * run of `provider_error status 401` rows in the ledger, which is where an operator
 * should learn about it. What it does avoid is making a user's meal unloggable because
 * of an outage or a misconfiguration they cannot do anything about.
 *
 * Anything not on this list — a `TypeError`, a missing context, an invariant violation —
 * propagates. Those are bugs, and a parser that swallowed them would turn every one into
 * a silent quality regression that looks exactly like Claude being unavailable.
 */
const FALLBACK_CODES = new Set(['AI_SCHEMA_ERROR', 'PROVIDER_ERROR', 'PROVIDER_UNAVAILABLE']);

function isFallbackWorthy(error: unknown): boolean {
  return error instanceof AppError && FALLBACK_CODES.has(error.code);
}

export class ClaudeMealParser implements MealParser {
  /**
   * The domain-level identifier, which is what `/meals/parse` reports and what a
   * response is compared against. Deliberately not the vendor model id — that belongs in
   * `ai_runs.model`, where it can change with configuration without changing the API.
   */
  readonly name = 'claude-v1';

  constructor(private readonly deps: ClaudeMealParserDeps) {}

  async parse(text: string, context?: ParseContext): Promise<ParsedMeal> {
    if (!context?.userId) {
      // Not a fallback case. Every model call must be attributable to the authenticated
      // caller, and a missing identity means the caller is wired up wrong.
      throw new Error('ClaudeMealParser requires the authenticated user id to meter its calls');
    }

    let extraction: MealExtraction;
    try {
      const result = await this.deps.ai.run({
        userId: context.userId,
        purpose: 'meal_parse',
        provider: 'anthropic',
        model: this.deps.model,
        schema: mealExtractionSchema,
        system: MEAL_EXTRACTION_SYSTEM_PROMPT,
        user: buildMealExtractionUserMessage(text, context.locale),
        jsonSchema: mealExtractionJsonSchema,
        timeoutMs: this.deps.timeoutMs ?? EXTRACTION_TIMEOUT_MS,
        // Shape and size only. `AiService` fills in `inputChars`; nothing here can carry
        // the meal text, the prompt or the response.
        meta: { promptVersion: MEAL_EXTRACTION_PROMPT_VERSION },
      });
      extraction = result.value;
    } catch (error) {
      if (!isFallbackWorthy(error)) throw error;
      return this.deps.fallback.parse(text, context);
    }

    return {
      items: extraction.items.map(toParsedItem),
      ambiguous: extraction.ambiguous,
      parser: this.name,
    };
  }
}

/**
 * One extracted item, as the domain's own type.
 *
 * Property-by-property rather than a spread. A spread would carry across whatever the
 * schema happened to allow, which makes the boundary depend on the schema staying strict
 * forever; naming the five fields makes it depend on nothing.
 */
function toParsedItem(item: MealExtraction['items'][number]): ParsedItem {
  return {
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    // `null` is how the schema says "the user gave no size"; the domain says that with
    // an absent key.
    ...(item.sizeLabel !== null ? { sizeLabel: item.sizeLabel } : {}),
    confidence: item.confidence,
  };
}

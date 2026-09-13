import type { AiService } from '../../ai/ai.service.js';
import { safeDisplayText, screenInput } from '../../ai/safety/index.js';
import type { ImageMealInput, ImageMealParser } from './image-meal-parser.js';
import type { ParseContext, ParsedItem, ParsedMeal } from './meal-parser.js';
import {
  buildMealVisionUserMessage,
  mealVisionJsonSchema,
  mealVisionSchema,
  MEAL_VISION_PROMPT_VERSION,
  MEAL_VISION_SYSTEM_PROMPT,
  type MealVision,
} from './meal-vision.js';

/**
 * Reads a meal photo with Gemini.
 *
 * ```
 * MealsService → ImageMealParser → GeminiVisionMealParser → AiService → GeminiProvider → Gemini
 * ```
 *
 * Like `ClaudeMealParser`, it supplies a prompt and a schema and reads the result; the
 * retry budget, the timeout, the schema gate and the `ai_runs` rows all belong to
 * `AiService`. It never touches the Gemini SDK.
 *
 * ## No fallback, on purpose
 *
 * `ClaudeMealParser` falls back to the rule-based parser because a sentence can still be
 * read without a model. A photo cannot. The alternatives — handing the user's optional
 * description to a text parser, or returning an empty reading — would present a guess
 * built from a caption as though it came from the photo. So a failure propagates as the
 * `AppError` `AiService` already chose: `422 AI_SCHEMA_ERROR`, `502 PROVIDER_ERROR` or
 * `503 PROVIDER_UNAVAILABLE`.
 */

/**
 * Per attempt. `API_DESIGN.md` budgets this endpoint at 25 seconds; with `AiService`'s
 * one retry the worst case is two attempts plus a backoff. Stated here rather than
 * inherited, so a change to the service default cannot silently move it.
 */
const VISION_TIMEOUT_MS = 25_000;

/**
 * The highest confidence an item can carry when the photo did not show how much of it
 * there was.
 *
 * The model reported a food but `quantity: null`; the domain needs a number, so the item
 * becomes one of its unit — and that number is AURA's assumption, not an observation.
 * `MealsService` feeds this confidence into the item's, which is what keeps an assumed
 * portion from presenting as a seen one on the draft the user reviews.
 */
const UNCOUNTED_CONFIDENCE_CAP = 0.6;

export interface GeminiVisionMealParserDeps {
  ai: AiService;
  /** `env.AI_MODEL_VISION`. */
  model: string;
  /** Overridden only by tests. */
  timeoutMs?: number;
}

export class GeminiVisionMealParser implements ImageMealParser {
  /** The domain identifier reported by the API. The model id belongs in `ai_runs.model`. */
  readonly name = 'gemini-vision-v1';

  constructor(private readonly deps: GeminiVisionMealParserDeps) {}

  async parse(input: ImageMealInput, context: ParseContext): Promise<ParsedMeal> {
    if (!context?.userId) {
      // Every model call must be attributable to the authenticated caller. A missing
      // identity is a wiring bug, not a model failure.
      throw new Error('GeminiVisionMealParser requires the authenticated user id to meter its calls');
    }

    const description = usableDescription(input.description);

    const result = await this.deps.ai.run({
      userId: context.userId,
      purpose: 'meal_vision',
      provider: 'google',
      model: this.deps.model,
      schema: mealVisionSchema,
      system: MEAL_VISION_SYSTEM_PROMPT,
      user: buildMealVisionUserMessage(description),
      jsonSchema: mealVisionJsonSchema,
      image: { mimeType: input.image.mimeType, data: input.image.data },
      timeoutMs: this.deps.timeoutMs ?? VISION_TIMEOUT_MS,
      // Sizes only. `inputChars` is the description the user typed, not the prompt
      // wrapper, and nothing here can carry the image, the text or the response.
      meta: {
        promptVersion: MEAL_VISION_PROMPT_VERSION,
        inputChars: description?.length ?? 0,
        imageBytes: input.image.bytes,
        imageMime: input.image.mimeType,
      },
    });

    return toParsedMeal(result.value, this.name);
  }
}

/**
 * The description, if it is safe to show a model — otherwise nothing.
 *
 * The description is optional context and the photo is the input. A description the
 * safety layer refuses is therefore **dropped**, and the photo is still read: a caption
 * that trips a pattern must not make a meal unloggable, and there is no text-only reading
 * to fall back to anyway. Nothing about the decision is recorded — which rule matched is a
 * classifier's claim about a person (AI_ARCHITECTURE.md §6).
 */
function usableDescription(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return screenInput(trimmed, 'meal_vision').action === 'allow' ? trimmed : undefined;
}

function toParsedMeal(vision: MealVision, parser: string): ParsedMeal {
  return {
    // Both strings are model-authored and travel far: `name` becomes `detectedName`,
    // stored and shown; `ambiguous` is echoed in the response. Sanitised exactly as on the
    // text path — invisible and bidirectional characters removed, instruction-shaped text
    // dropped, every letter and diacritic kept.
    items: vision.items.flatMap((item) => {
      const name = safeDisplayText(item.name, 'meal_vision');
      return name === null ? [] : [toParsedItem(item, name)];
    }),
    ambiguous: vision.ambiguous.flatMap((note) => {
      const safe = safeDisplayText(note, 'meal_vision');
      return safe === null ? [] : [safe];
    }),
    parser,
  };
}

/**
 * One visible item, as the domain's own type.
 *
 * Property by property, never a spread, so the boundary does not depend on the schema
 * staying strict.
 */
function toParsedItem(item: MealVision['items'][number], name: string): ParsedItem {
  return {
    name,
    quantity: item.quantity ?? 1,
    unit: item.unit,
    ...(item.sizeLabel !== null ? { sizeLabel: item.sizeLabel } : {}),
    confidence:
      item.quantity === null
        ? Math.min(item.confidence, UNCOUNTED_CONFIDENCE_CAP)
        : item.confidence,
  };
}

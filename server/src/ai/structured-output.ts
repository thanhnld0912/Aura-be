import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * A Zod schema as the JSON Schema Anthropic structured outputs accept.
 *
 * Written for the weekly story (Task 7) and shared with the agent (Task 8). Length, range,
 * pattern and item-count constraints are rejected by the API, so they are removed from
 * what is *sent* — and still enforced by Zod on what comes back, which is the half that
 * matters. Property names under `properties` are data, not keywords, and all survive.
 */

const STRUCTURED_OUTPUT_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'allOf',
  'description',
]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!STRUCTURED_OUTPUT_KEYWORDS.has(key)) continue;
    if (key === 'properties' && value !== null && typeof value === 'object') {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, strip(schema)]));
      continue;
    }
    result[key] = strip(value);
  }
  return result;
}

export function toStructuredOutputSchema(schema: ZodTypeAny): Record<string, unknown> {
  return strip(zodToJsonSchema(schema, { $refStrategy: 'none' })) as Record<string, unknown>;
}

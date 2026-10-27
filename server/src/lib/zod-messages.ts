import { z } from 'zod';

/**
 * Zod 3's English messages, installed as Zod 4's default.
 *
 * A validation error's `message` reaches people: the frontend shows it as written
 * ("quantity: Number must be greater than 0"). Zod 4 rewords every default message, so
 * upgrading the library alone would change what users read. This restores the Zod 3 wording
 * for every issue this API can produce, ported from Zod 3's `locales/en.js`.
 *
 * Only defaults are affected: a message written on the schema (`.min(1, '…')`,
 * `.refine(…, '…')`) still wins. An issue kind Zod 3 had no wording for falls through to
 * Zod 4's own.
 *
 * Installed on import. `config/env.ts` and `middleware/validation.ts` import it, so every
 * process — the API, the scheduler, the backfill — validates with the same wording.
 */

type RawIssue = Parameters<NonNullable<z.core.$ZodConfig['customError']>>[0];

/** Zod 3's name for a value's type (`helpers/util.js` `getParsedType`). */
function parsedType(value: unknown): string {
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return 'string';
    case 'number':
      return Number.isNaN(value) ? 'nan' : 'number';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    case 'object':
      if (Array.isArray(value)) return 'array';
      if (value === null) return 'null';
      if (value instanceof Map) return 'map';
      if (value instanceof Set) return 'set';
      if (value instanceof Date) return 'date';
      return 'object';
    default:
      return 'unknown';
  }
}

/** Zod 3's `util.joinValues`. */
function joinValues(values: readonly unknown[], separator = ' | '): string {
  return values.map((value) => (typeof value === 'string' ? `'${value}'` : String(value))).join(separator);
}

/** Zod 4 names a few expected types differently from Zod 3. */
const EXPECTED_AS_ZOD3: Readonly<Record<string, string>> = { int: 'integer', record: 'object' };

/** Zod 4 names a few string formats differently from Zod 3. */
const FORMAT_AS_ZOD3: Readonly<Record<string, string>> = { guid: 'uuid' };

/**
 * Whether an enum issue is Zod 3's `invalid_type`. Zod 3 checked that an enum's input was a
 * string before checking its value, so a number, `null`, a boolean, a missing field — any
 * non-string — was a type error; only a string outside the options was `invalid_enum_value`.
 * Zod 4 reports all of them as `invalid_value`, with the input attached.
 */
export function isEnumTypeMismatch(input: unknown): boolean {
  return typeof input !== 'string';
}

function isLiteral(issue: RawIssue): boolean {
  const owner = issue.inst ?? issue.schema;
  return owner !== undefined && 'def' in owner._zod && (owner._zod.def as { type?: string }).type === 'literal';
}

export function zod3Message(issue: RawIssue): string | undefined {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined) return 'Required';
      const received = parsedType(issue.input);
      if (issue.expected === 'int' && received === 'number') return 'Expected integer, received float';
      return `Expected ${EXPECTED_AS_ZOD3[issue.expected] ?? issue.expected}, received ${received}`;
    }
    case 'invalid_value':
      if (isLiteral(issue)) return `Invalid literal value, expected ${JSON.stringify(issue.values[0])}`;
      if (isEnumTypeMismatch(issue.input)) {
        return issue.input === undefined
          ? 'Required'
          : `Expected ${joinValues(issue.values)}, received ${parsedType(issue.input)}`;
      }
      return `Invalid enum value. Expected ${joinValues(issue.values)}, received '${String(issue.input)}'`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues(issue.keys, ', ')}`;
    case 'invalid_union':
      return 'Invalid input';
    case 'invalid_format':
      switch (issue.format) {
        case 'regex':
          return 'Invalid';
        case 'starts_with':
          return `Invalid input: must start with "${(issue as { prefix?: string }).prefix}"`;
        case 'ends_with':
          return `Invalid input: must end with "${(issue as { suffix?: string }).suffix}"`;
        case 'includes':
          return `Invalid input: must include "${(issue as { includes?: string }).includes}"`;
        default:
          return `Invalid ${FORMAT_AS_ZOD3[issue.format] ?? issue.format}`;
      }
    case 'too_small': {
      const { minimum, inclusive, exact } = issue;
      switch (issue.origin) {
        case 'array':
          return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${minimum} element(s)`;
        case 'string':
          return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${minimum} character(s)`;
        case 'number':
        case 'int':
        case 'bigint':
          return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${minimum}`;
        case 'date':
          return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(minimum))}`;
        default:
          return 'Invalid input';
      }
    }
    case 'too_big': {
      const { maximum, inclusive, exact } = issue;
      switch (issue.origin) {
        case 'array':
          return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${maximum} element(s)`;
        case 'string':
          return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${maximum} character(s)`;
        case 'number':
        case 'int':
          return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
        case 'bigint':
          return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
        case 'date':
          return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(maximum))}`;
        default:
          return 'Invalid input';
      }
    }
    case 'custom':
      return 'Invalid input';
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`;
    default:
      return undefined;
  }
}

z.config({ customError: zod3Message });

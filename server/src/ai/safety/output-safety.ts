import type { AiPurpose } from '../types.js';
import { screenInput } from './input-safety.js';
import { ALLOW, type SafetyDecision } from './safety-types.js';

/**
 * The gate behind the model, for the text a model authored.
 *
 * ## Why this exists at all
 *
 * A strict Zod schema guarantees the *shape* of a response. It says nothing about the
 * contents of a string field, and in AURA two model-authored strings travel further than
 * they look: `ParsedItem.name` becomes `detectedName`, which is **stored** on the meal
 * item and **returned** to the client, and `ambiguous[]` is echoed in the response
 * verbatim. Whatever the model puts there gets persisted and rendered.
 *
 * The realistic risk is modest — the person who could influence that text is the same
 * person who sees it — but it is stored, and "modest and permanent" is still worth
 * closing.
 *
 * ## The constraint that shapes the implementation
 *
 * A food name is not a safety problem, and treating it as one would be worse than the
 * risk. `cơm tấm sườn bì chả`, `bún bò Huế` and `🍚 cơm` must come through byte-identical.
 * So this layer removes characters that carry no meaning in a name and can misrepresent
 * one on a screen, and it refuses text that is shaped like an instruction. It does not
 * judge food.
 */

/**
 * Characters a food name has no use for.
 *
 * Written as escapes rather than as literal characters: a source file containing raw
 * control bytes is one `grep` treats as binary and one a diff cannot show.
 *
 * | Range | What |
 * |---|---|
 * | `0000-0008`, `000b`, `000c`, `000e-001f` | C0 controls, minus tab/LF/CR |
 * | `007f-009f` | delete and the C1 controls |
 * | `00ad` | soft hyphen — invisible, splits a word |
 * | `200b-200f` | zero-width space/joiners and LTR/RTL marks |
 * | `202a-202e`, `2066-2069` | bidirectional overrides and isolates |
 * | `feff` | byte-order mark |
 *
 * The bidirectional group is the one that actually matters for stored text: an override
 * can make a rendered string read as something other than what was stored.
 *
 * Tab, newline and carriage return are deliberately absent — whitespace collapsing
 * below turns those into a single space rather than deleting them, so words either side
 * stay separated.
 */
const INVISIBLE_OR_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * A model-authored string, made safe to store and display.
 *
 * Conservative by construction: it deletes characters and collapses whitespace, and
 * never substitutes or reorders anything. Every letter, diacritic and emoji survives.
 * Returns `null` when nothing meaningful is left, so a caller can drop the entry rather
 * than store an empty one.
 */
export function sanitizeDisplayText(text: string): string | null {
  const cleaned = text.replace(INVISIBLE_OR_CONTROL, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Whether a model-authored string is safe to keep.
 *
 * Reuses the input detectors rather than growing a second pattern set: text that would
 * have been refused going in is text worth dropping coming out. It is defence in depth —
 * the input gate normally catches this first — and it covers the case where a model
 * echoes an instruction back into a field that gets stored.
 *
 * Not a prose-safety system. There is no prose-generating surface in AURA yet; when
 * daily analysis and pattern narration arrive they will need their own policy, and
 * `filterCausalClaims` is the piece of it that already exists.
 */
export function screenOutputText(text: string, purpose: AiPurpose): SafetyDecision {
  return screenInput(text, purpose);
}

/**
 * Sanitises a model-authored display string and drops it if it is unusable.
 *
 * The single helper the meal parser needs: returns the cleaned string, or `null` when
 * the entry should not survive.
 */
export function safeDisplayText(text: string, purpose: AiPurpose): string | null {
  const cleaned = sanitizeDisplayText(text);
  if (cleaned === null) return null;
  return screenOutputText(cleaned, purpose).action === 'allow' ? cleaned : null;
}

export { ALLOW };

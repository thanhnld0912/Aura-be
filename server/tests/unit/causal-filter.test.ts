import { describe, expect, it } from 'vitest';
import { containsCausalClaim, filterCausalClaims } from '../../src/ai/safety/causal-filter.js';

/**
 * The correlation rule (AI_ARCHITECTURE.md §6).
 *
 * Two failure modes, and the tests are split between them because they pull in opposite
 * directions. Letting a causal claim through tells someone an untrue thing about their
 * body. Over-matching mangles ordinary prose and makes the filter unusable — and the
 * second failure is the more likely one, so most of these tests are about text that must
 * come through untouched.
 */

describe('causal claims are rewritten as associations', () => {
  const english: ReadonlyArray<[string, string]> = [
    ['Skipping breakfast causes fatigue.', 'Skipping breakfast often occurred alongside fatigue.'],
    ['Late nights caused poor sleep.', 'Late nights often occurred alongside poor sleep.'],
    ['This cause weight gain.', 'This often occurred alongside weight gain.'],
    ['Low protein leads to hunger.', 'Low protein often occurred alongside hunger.'],
    ['Skipping lunch led to snacking.', 'Skipping lunch often occurred alongside snacking.'],
    ['Late meals result in poor sleep.', 'Late meals often occurred alongside poor sleep.'],
    ['That resulted in a deficit.', 'That often occurred alongside a deficit.'],
    ['Your fatigue is caused by low iron.', 'Your fatigue often occurred alongside low iron.'],
    ['Late snacks contribute to this.', 'Late snacks often occurred alongside this.'],
  ];

  for (const [input, expected] of english) {
    it(`rewrites: ${input}`, () => {
      const result = filterCausalClaims(input);
      expect(result.action).toBe('rewritten');
      if (result.action !== 'rewritten') throw new Error('unreachable');
      expect(result.text).toBe(expected);
    });
  }

  const vietnamese: ReadonlyArray<[string, string]> = [
    ['Ăn khuya gây ra tăng cân.', 'Ăn khuya thường đi cùng với tăng cân.'],
    ['Ngủ muộn dẫn đến bỏ bữa sáng.', 'Ngủ muộn thường đi cùng với bỏ bữa sáng.'],
    ['Món này gây tăng cân.', 'Món này thường đi cùng với tăng cân.'],
    ['Ngủ ít khiến bạn bỏ bữa sáng.', 'Ngủ ít thường đi cùng với việc bạn bỏ bữa sáng.'],
    ['Việc đó làm cho bạn mệt.', 'Việc đó thường đi cùng với việc bạn mệt.'],
  ];

  for (const [input, expected] of vietnamese) {
    it(`rewrites Vietnamese: ${input}`, () => {
      const result = filterCausalClaims(input);
      expect(result.action).toBe('rewritten');
      if (result.action !== 'rewritten') throw new Error('unreachable');
      expect(result.text).toBe(expected);
    });
  }

  it('rewrites the documented example from the architecture doc', () => {
    const result = filterCausalClaims('Ngủ ít khiến bạn bỏ bữa sáng.');
    if (result.action !== 'rewritten') throw new Error('expected a rewrite');
    // No longer asserts that one produced the other.
    expect(result.text).not.toContain('khiến');
    expect(result.text).toContain('thường đi cùng với');
  });

  it('rewrites every occurrence and counts them', () => {
    const result = filterCausalClaims('A causes B, and C leads to D.');
    if (result.action !== 'rewritten') throw new Error('expected a rewrite');
    expect(result.rewrites).toBe(2);
    expect(result.text).toBe(
      'A often occurred alongside B, and C often occurred alongside D.',
    );
  });

  it('prefers the longer Vietnamese phrase over its prefix', () => {
    // "gây ra" must not be rewritten as "gây" + a stranded "ra".
    const result = filterCausalClaims('Điều này gây ra mệt mỏi.');
    if (result.action !== 'rewritten') throw new Error('expected a rewrite');
    expect(result.text).toBe('Điều này thường đi cùng với mệt mỏi.');
    expect(result.text).not.toContain(' ra ');
  });
});

describe('claims that cannot be rewritten are rejected, not guessed at', () => {
  const unrewritable = [
    'Sleeping late makes you skip breakfast.',
    'That meal made you tired.',
    'This makes your energy drop.',
    'Low iron is the reason why you feel tired.',
  ];

  for (const input of unrewritable) {
    it(`rejects: ${input}`, () => {
      const result = filterCausalClaims(input);
      expect(result.action).toBe('reject');
      if (result.action !== 'reject') throw new Error('unreachable');
      expect(result.reason).toBe('unrewritable_causal_claim');
    });
  }

  it('rejects rather than half-fixing a sentence with both kinds of claim', () => {
    // Shipping "X often occurred alongside Y, and it makes you tired" would be worse
    // than shipping nothing: it reads as though it had been checked.
    const result = filterCausalClaims('Late meals cause fatigue and make you skip breakfast.');
    expect(result.action).toBe('reject');
  });
});

describe('ordinary prose is left exactly as it was', () => {
  const untouched = [
    // Association language — the wording the filter is trying to produce.
    'These two patterns often occurred together.',
    'Late nights are associated with later breakfasts.',
    'This was observed alongside a later first meal.',
    'Hai điều này có xu hướng đi cùng nhau.',
    'Những ngày đó thường xuất hiện cùng bữa sáng muộn.',
    // "because" contains "cause" and must not match.
    'You logged fewer meals because you were travelling.',
    'Because of the holiday, logging was lighter.',
    'Hôm đó bạn ăn ít vì bận.',
    // Ordinary uses of verbs that look causal out of context.
    'This bowl is made with rice and egg.',
    'A meal made from leftovers still counts.',
    'The search results in the app are cached.',
    'The test results in the report were normal.',
    'Bữa sáng gồm cơm và trứng.',
    // Neutral reporting.
    'You logged 14 meals over the last 7 days.',
    'Protein averaged 62 g per day.',
  ];

  for (const input of untouched) {
    it(`leaves untouched: ${input}`, () => {
      const result = filterCausalClaims(input);
      expect(result.action).toBe('unchanged');
      if (result.action !== 'unchanged') throw new Error('unreachable');
      // Byte-identical, not merely equivalent.
      expect(result.text).toBe(input);
    });
  }

  it('handles a mixed-language sentence', () => {
    const result = filterCausalClaims('Ngủ muộn is associated with bữa sáng muộn.');
    expect(result.action).toBe('unchanged');
  });

  it('rewrites only the causal half of a mixed-language sentence', () => {
    const result = filterCausalClaims('Late nights gây ra mệt mỏi.');
    if (result.action !== 'rewritten') throw new Error('expected a rewrite');
    expect(result.text).toBe('Late nights thường đi cùng với mệt mỏi.');
  });

  it('still catches the verb reading when no determiner precedes it', () => {
    // The guard above must not disarm the rewrite entirely.
    const result = filterCausalClaims('Late meals result in poor sleep.');
    expect(result.action).toBe('rewritten');
  });

  it('is a pure function — the input string is never mutated', () => {
    const input = 'Skipping breakfast causes fatigue.';
    const copy = `${input}`;
    filterCausalClaims(input);
    expect(input).toBe(copy);
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(filterCausalClaims('').action).toBe('unchanged');
    expect(filterCausalClaims('   ').action).toBe('unchanged');
  });
});

describe('containsCausalClaim', () => {
  it('is true for a causal claim in either language and false for association', () => {
    expect(containsCausalClaim('Late nights cause fatigue.')).toBe(true);
    expect(containsCausalClaim('Ăn khuya gây ra tăng cân.')).toBe(true);
    expect(containsCausalClaim('Sleeping late makes you tired.')).toBe(true);
    expect(containsCausalClaim('These often occurred together.')).toBe(false);
    expect(containsCausalClaim('You ate less because you were busy.')).toBe(false);
  });
});

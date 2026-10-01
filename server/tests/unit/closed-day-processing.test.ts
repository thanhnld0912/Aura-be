import { describe, expect, it } from 'vitest';
import { ClosedDayPatternProcessor } from '../../src/modules/patterns/closed-day-pattern-processor.js';
import type { DetectionRunResult } from '../../src/modules/patterns/pattern-detection.service.js';

/**
 * The closed-day order: finalise the day, then detect on it — never the other way round,
 * and never detection on a day that could not be finalised. Finalisation itself runs against
 * PostgreSQL in `tests/integration/closed-day-finalization.test.ts`.
 */

const run = () => ({}) as DetectionRunResult;

describe('closed-day processing order', () => {
  it('finalises the day, and only then detects on it', async () => {
    const calls: string[] = [];
    const processor = new ClosedDayPatternProcessor(
      { finalize: async (userId, day) => void calls.push(`finalize ${userId} ${day}`) },
      {
        runForUser: async (userId, day) => {
          calls.push(`detect ${userId} ${day}`);
          return run();
        },
      },
    );
    await processor.process('u', '2026-09-30');
    expect(calls).toEqual(['finalize u 2026-09-30', 'detect u 2026-09-30']);
  });

  it('does not detect on a day it could not finalise', async () => {
    let detected = false;
    const processor = new ClosedDayPatternProcessor(
      {
        finalize: async () => {
          throw new Error('reconciliation failed');
        },
      },
      {
        runForUser: async () => {
          detected = true;
          return run();
        },
      },
    );
    await expect(processor.process('u', '2026-09-30')).rejects.toThrow('reconciliation failed');
    expect(detected).toBe(false);
  });
});

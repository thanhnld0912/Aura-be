import { describe, expect, it } from 'vitest';
import { DailyTrigger } from '../../src/jobs/daily-trigger.js';
import {
  NightlyPatternDetection,
  closedDayFor,
  type JobLogger,
  type NightlyPatternDetectionDeps,
} from '../../src/jobs/nightly-pattern-detection.js';
import { PATTERN_DETECTION_AT } from '../../src/jobs/pattern-scheduler.js';
import { NotFoundError } from '../../src/lib/errors.js';

/**
 * The nightly job's own decisions: which day each user gets, who is processed, how failures
 * are kept apart, and when the trigger fires. Detection itself is `PatternDetectionService`'s
 * and is stubbed here; the database-backed run is `tests/integration/nightly-pattern-detection.test.ts`.
 */

function recordingLogger() {
  const logs = { info: [] as Array<[object, string]>, error: [] as Array<[object, string]> };
  const logger: JobLogger = {
    info: (context, message) => logs.info.push([context, message]),
    error: (context, message) => logs.error.push([context, message]),
  };
  return { logger, logs };
}

describe('the closed day of each user', () => {
  // 03:00 UTC on 1 October 2026.
  const INSTANT = new Date('2026-10-01T03:00:00Z');

  it('is yesterday in the user own timezone, from one shared instant', () => {
    expect(closedDayFor('Asia/Ho_Chi_Minh', INSTANT)).toBe('2026-09-30'); // 10:00, 1 Oct
    expect(closedDayFor('UTC', INSTANT)).toBe('2026-09-30'); // 03:00, 1 Oct
    expect(closedDayFor('America/New_York', INSTANT)).toBe('2026-09-29'); // 23:00, 30 Sep
    expect(closedDayFor('Pacific/Kiritimati', INSTANT)).toBe('2026-09-30'); // 17:00, 1 Oct (UTC+14)
    expect(closedDayFor('Etc/GMT+12', INSTANT)).toBe('2026-09-29'); // 15:00, 30 Sep (UTC−12)
  });

  it('turns over exactly at the user local midnight', () => {
    // Ho Chi Minh City is UTC+7: local midnight of 1 October is 17:00 UTC on 30 September.
    expect(closedDayFor('Asia/Ho_Chi_Minh', new Date('2026-09-30T16:59:59Z'))).toBe('2026-09-29');
    expect(closedDayFor('Asia/Ho_Chi_Minh', new Date('2026-09-30T17:00:00Z'))).toBe('2026-09-30');
    // New York is UTC−4 in October: local midnight of 1 October is 04:00 UTC.
    expect(closedDayFor('America/New_York', new Date('2026-10-01T03:59:59Z'))).toBe('2026-09-29');
    expect(closedDayFor('America/New_York', new Date('2026-10-01T04:00:00Z'))).toBe('2026-09-30');
  });

  it('is never the user today or a later day', () => {
    for (const timeZone of ['Asia/Ho_Chi_Minh', 'UTC', 'America/New_York', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(INSTANT);
      expect(closedDayFor(timeZone, INSTANT) < today).toBe(true);
    }
  });
});

describe('a nightly run', () => {
  const NOW = new Date('2026-10-01T19:15:00Z'); // 02:15 on 2 October in Ho Chi Minh City
  type User = { id: string; timezone: string };

  function job(users: User[], runForUser: (userId: string, targetDate: string) => Promise<unknown>, pageSize = 500) {
    const calls: Array<[string, string]> = [];
    const pages: Array<string | null> = [];
    const { logger, logs } = recordingLogger();
    const deps: NightlyPatternDetectionDeps = {
      users: {
        listActiveTimezones: async (afterId, limit) => {
          pages.push(afterId);
          const sorted = [...users].sort((a, b) => (a.id < b.id ? -1 : 1));
          const start = afterId === null ? 0 : sorted.findIndex((u) => u.id === afterId) + 1;
          return sorted.slice(start, start + limit);
        },
      },
      processor: {
        process: (async (userId: string, targetDate: string) => {
          calls.push([userId, targetDate]);
          return runForUser(userId, targetDate);
        }) as never,
      },
      logger,
      pageSize,
      clock: (() => {
        let t = 1_000;
        return () => (t += 250);
      })(),
    };
    return { job: new NightlyPatternDetection(deps), calls, pages, logs };
  }

  it('runs every active user for their own closed day', async () => {
    const run = job(
      [
        { id: 'a', timezone: 'Asia/Ho_Chi_Minh' },
        { id: 'b', timezone: 'America/New_York' },
        { id: 'c', timezone: 'UTC' },
      ],
      async () => ({}),
    );
    const result = await run.job.run(NOW);

    expect(run.calls).toEqual([
      ['a', '2026-10-01'], // 02:15, 2 Oct
      ['b', '2026-09-30'], // 15:15, 1 Oct
      ['c', '2026-09-30'], // 19:15, 1 Oct
    ]);
    expect(result).toMatchObject({ targetedUsers: 3, succeededUsers: 3, failedUsers: 0, skippedUsers: 0, startedAt: NOW });
    expect(result.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps going past a user who fails, and records the failure', async () => {
    const run = job(
      ['a', 'b', 'c', 'd'].map((id) => ({ id, timezone: 'UTC' })),
      async (userId) => {
        if (userId === 'b') throw new Error('database timeout');
      },
    );
    const result = await run.job.run(NOW);

    expect(run.calls.map(([id]) => id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result).toMatchObject({ targetedUsers: 4, succeededUsers: 3, failedUsers: 1, skippedUsers: 0 });
    expect(run.logs.error).toEqual([
      [
        { runId: result.runId, userId: 'b', targetDate: '2026-09-30', err: { name: 'Error', message: 'database timeout' } },
        'nightly pattern detection failed for user',
      ],
    ]);
  });

  it('completes when every user fails — the run itself has not failed', async () => {
    const run = job(['a', 'b', 'c'].map((id) => ({ id, timezone: 'UTC' })), async () => {
      throw new Error('detector exploded');
    });
    await expect(run.job.run(NOW)).resolves.toMatchObject({ targetedUsers: 3, succeededUsers: 0, failedUsers: 3 });
    expect(run.logs.error).toHaveLength(3);
  });

  it('counts a user who stopped being active as skipped, not failed', async () => {
    const run = job(['a', 'b'].map((id) => ({ id, timezone: 'UTC' })), async (userId) => {
      if (userId === 'a') throw new NotFoundError('User not found');
    });
    await expect(run.job.run(NOW)).resolves.toMatchObject({ targetedUsers: 2, succeededUsers: 1, failedUsers: 0, skippedUsers: 1 });
    expect(run.logs.error).toEqual([]);
  });

  it('records a user whose stored timezone cannot be read as failed, and moves on', async () => {
    const run = job(
      [
        { id: 'a', timezone: 'Not/AZone' },
        { id: 'b', timezone: 'UTC' },
      ],
      async () => ({}),
    );
    const result = await run.job.run(NOW);
    expect(run.calls).toEqual([['b', '2026-09-30']]);
    expect(result).toMatchObject({ succeededUsers: 1, failedUsers: 1 });
    expect(run.logs.error[0]?.[0]).toMatchObject({ userId: 'a', targetDate: undefined });
  });

  it('reports a night with no active users as zero, not as an error', async () => {
    const run = job([], async () => ({}));
    await expect(run.job.run(NOW)).resolves.toMatchObject({ targetedUsers: 0, succeededUsers: 0, failedUsers: 0, skippedUsers: 0 });
    expect(run.logs.info.map(([, message]) => message)).toEqual([
      'nightly pattern detection started',
      'nightly pattern detection complete',
    ]);
  });

  it('walks the users in bounded pages', async () => {
    const run = job(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, timezone: 'UTC' })), async () => ({}), 2);
    const result = await run.job.run(NOW);
    expect(run.pages).toEqual([null, 'b', 'd']);
    expect(result.targetedUsers).toBe(5);
  });

  it('fails the run — not "zero users" — when users cannot be listed', async () => {
    const { logger, logs } = recordingLogger();
    const failing = new NightlyPatternDetection({
      users: {
        listActiveTimezones: async () => {
          throw new Error('connection refused');
        },
      },
      processor: { process: async () => ({}) as never },
      logger,
    });
    await expect(failing.run(NOW)).rejects.toThrow('connection refused');
    expect(logs.error.map(([, message]) => message)).toEqual(['nightly pattern detection run failed']);
    expect(logs.info.map(([, message]) => message)).toEqual(['nightly pattern detection started']);
  });
});

describe('the daily trigger', () => {
  const ZONE = 'Asia/Ho_Chi_Minh'; // UTC+7, no DST
  /** A UTC instant for a wall time in Ho Chi Minh City. */
  const local = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`);

  function trigger(start: Date, at = PATTERN_DETECTION_AT, timeZone = ZONE) {
    let now = start;
    const fired: Date[] = [];
    let release: (() => void) | undefined;
    let hold = false;
    const { logger, logs } = recordingLogger();
    const t = new DailyTrigger({
      at,
      timeZone,
      logger,
      now: () => now,
      tickMs: 3_600_000,
      task: async (firedAt) => {
        fired.push(firedAt);
        if (hold) await new Promise<void>((resolve) => (release = resolve));
      },
    });
    return {
      t,
      fired,
      logs,
      at: (instant: Date) => (now = instant),
      holdNext: () => (hold = true),
      release: () => release?.(),
    };
  }

  it('fires at 02:15 local, once per local date', async () => {
    const s = trigger(local('2026-10-01', '23:00'));
    s.t.start();
    s.at(local('2026-10-02', '02:14'));
    expect(s.t.tick()).toBeUndefined();
    s.at(local('2026-10-02', '02:15'));
    await s.t.tick();
    s.at(local('2026-10-02', '02:16'));
    expect(s.t.tick()).toBeUndefined();
    s.at(local('2026-10-03', '02:17'));
    await s.t.tick();
    await s.t.stop();

    expect(s.fired).toEqual([local('2026-10-02', '02:15'), local('2026-10-03', '02:17')]);
  });

  it('does not fire for today when started after today time — a daytime deploy runs nothing', async () => {
    const s = trigger(local('2026-10-02', '12:00'));
    s.t.start();
    expect(s.t.tick()).toBeUndefined();
    s.at(local('2026-10-03', '02:15'));
    await s.t.tick();
    await s.t.stop();
    expect(s.fired).toEqual([local('2026-10-03', '02:15')]);
  });

  it('never overlaps itself, and stop() waits for the running task', async () => {
    const s = trigger(local('2026-10-01', '23:00'));
    s.t.start();
    s.holdNext();
    s.at(local('2026-10-02', '02:15'));
    const running = s.t.tick();
    s.at(local('2026-10-03', '02:15'));
    expect(s.t.tick()).toBeUndefined(); // still running: skipped, not queued

    let stopped = false;
    const stopping = s.t.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    s.release();
    await running;
    await stopping;
    expect(stopped).toBe(true);
    expect(s.fired).toHaveLength(1);
  });

  it('logs a failed task and keeps the schedule', async () => {
    const { logger, logs } = recordingLogger();
    let now = local('2026-10-01', '23:00');
    let calls = 0;
    const t = new DailyTrigger({
      at: '02:15',
      timeZone: ZONE,
      logger,
      now: () => now,
      task: async () => {
        calls += 1;
        throw new Error('listing failed');
      },
    });
    t.start();
    now = local('2026-10-02', '02:15');
    await t.tick();
    now = local('2026-10-03', '02:15');
    await t.tick();
    await t.stop();
    expect(calls).toBe(2);
    expect(logs.error).toEqual([
      [{ err: { name: 'Error', message: 'listing failed' } }, 'scheduled task failed'],
      [{ err: { name: 'Error', message: 'listing failed' } }, 'scheduled task failed'],
    ]);
  });

  it('fires once on a DST day, whether the time is skipped or repeated', async () => {
    // New York, 8 March 2026: 02:00 jumps to 03:00, so 02:15 never happens.
    const s = trigger(new Date('2026-03-08T05:00:00Z'), '02:15', 'America/New_York'); // 00:00 EST
    s.t.start();
    s.at(new Date('2026-03-08T06:59:00Z')); // 01:59 EST
    expect(s.t.tick()).toBeUndefined();
    s.at(new Date('2026-03-08T07:00:00Z')); // 03:00 EDT
    await s.t.tick();
    // 1 November 2026: 01:00–02:00 repeats; 02:15 happens once, and fires once.
    s.at(new Date('2026-11-01T07:15:00Z')); // 02:15 EST
    await s.t.tick();
    s.at(new Date('2026-11-01T08:15:00Z')); // 03:15 EST
    expect(s.t.tick()).toBeUndefined();
    await s.t.stop();
    expect(s.fired).toEqual([new Date('2026-03-08T07:00:00Z'), new Date('2026-11-01T07:15:00Z')]);
  });

  it('refuses a malformed time or timezone at construction', () => {
    const base = { task: async () => {}, logger: recordingLogger().logger };
    expect(() => new DailyTrigger({ ...base, at: '2:15', timeZone: ZONE })).toThrow();
    expect(() => new DailyTrigger({ ...base, at: '02:15', timeZone: 'Not/AZone' })).toThrow();
  });

  it('is scheduled at the documented 02:15', () => {
    expect(PATTERN_DETECTION_AT).toBe('02:15');
  });
});

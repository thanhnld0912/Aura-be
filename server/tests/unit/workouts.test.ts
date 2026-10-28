import { describe, expect, it } from 'vitest';
import type { ValidationError } from '../../src/lib/errors.js';
import { validatorCompiler } from '../../src/middleware/validation.js';
import type { DayRefresher } from '../../src/modules/daily-events/daily-events.service.js';
import type {
  CreateWorkoutInput,
  WorkoutsRepository,
} from '../../src/modules/workouts/workouts.repository.js';
import { createWorkoutSchema } from '../../src/modules/workouts/workouts.routes.js';
import { WorkoutsService } from '../../src/modules/workouts/workouts.service.js';

const validate = (body: unknown) =>
  validatorCompiler({ schema: createWorkoutSchema, method: 'POST', url: '/api/workouts', httpPart: 'body' })(body) as
    | { value: unknown }
    | { error: ValidationError };

const issues = (body: unknown) => {
  const result = validate(body);
  return 'error' in result ? result.error.details : [];
};

describe('POST /api/workouts body', () => {
  it('needs only a workout type', () => {
    expect(validate({ workoutType: 'gym' })).toEqual({ value: { workoutType: 'gym' } });
  });

  it('accepts every documented field', () => {
    const body = {
      workoutType: 'other',
      title: 'Cycling',
      occurredAt: '2026-10-27T10:00:00Z',
      durationMin: 30,
      perceivedEffort: 3,
      note: 'Đạp xe 30 phút',
    };
    const result = validate(body) as { value: Record<string, unknown> };
    expect(result.value).toMatchObject({ ...body, occurredAt: new Date('2026-10-27T10:00:00Z') });
  });

  it.each([
    ['a zero duration', { durationMin: 0 }, 'durationMin', 'too_small'],
    ['a duration over ten hours', { durationMin: 601 }, 'durationMin', 'too_big'],
    ['a fractional duration', { durationMin: 30.5 }, 'durationMin', 'invalid_type'],
    ['an effort above 5', { perceivedEffort: 6 }, 'perceivedEffort', 'too_big'],
    ['an effort below 1', { perceivedEffort: 0 }, 'perceivedEffort', 'too_small'],
    ['an empty title', { title: '' }, 'title', 'too_small'],
    ['a long note', { note: 'x'.repeat(501) }, 'note', 'too_big'],
    ['an unknown type', { workoutType: 'cycling' }, 'workoutType', 'invalid_enum_value'],
  ])('rejects %s', (_why, patch, path, issue) => {
    expect(issues({ workoutType: 'gym', ...patch })).toContainEqual({ path, issue });
  });

  it('refuses what it does not store rather than dropping it', () => {
    expect(issues({ workoutType: 'gym', caloriesBurned: 300 })).toContainEqual({
      path: '',
      issue: 'unrecognized_keys',
    });
    expect(issues({ workoutType: 'gym', exercises: [] })).toContainEqual({ path: '', issue: 'unrecognized_keys' });
  });

  it('refuses a body with no type', () => {
    expect(issues({ durationMin: 30 })).toContainEqual({ path: 'workoutType', issue: 'invalid_type' });
  });
});

describe('WorkoutsService.create', () => {
  const setup = () => {
    const written: CreateWorkoutInput[] = [];
    const refreshed: Array<[string, string, string]> = [];
    const repository = {
      async create(input: CreateWorkoutInput) {
        written.push(input);
        return {
          event: { id: 'event-1', localDate: input.localDate, occurredAt: input.occurredAt, title: input.title, note: input.note },
          session: { id: 'session-1' },
        };
      },
    } as unknown as WorkoutsRepository;
    const refresher: DayRefresher = {
      async refresh(userId, localDate, timeZone) {
        refreshed.push([userId, localDate, timeZone]);
      },
    };
    const now = new Date('2026-10-27T17:30:00Z');
    const service = new WorkoutsService(repository, () => refresher, () => now);
    return { service, written, refreshed };
  };

  it('files the workout under the local day it happened, and refreshes that day', async () => {
    const { service, written, refreshed } = setup();
    // 17:30 UTC is 00:30 the next day in Ho Chi Minh City.
    await service.create('user-1', 'Asia/Ho_Chi_Minh', { workoutType: 'gym', durationMin: 45 });

    expect(written[0]).toMatchObject({ localDate: '2026-10-28', durationMin: 45, perceivedEffort: null, note: null });
    expect(refreshed).toEqual([['user-1', '2026-10-28', 'Asia/Ho_Chi_Minh']]);
  });

  it('titles an untitled workout by its type, and keeps a given title', async () => {
    const { service, written } = setup();
    await service.create('user-1', 'UTC', { workoutType: 'home' });
    await service.create('user-1', 'UTC', { workoutType: 'other', title: 'Cycling' });
    expect(written.map((input) => input.title)).toEqual(['Home workout', 'Cycling']);
  });

  it('records nothing it was not told — no invented duration or effort', async () => {
    const { service, written } = setup();
    await service.create('user-1', 'UTC', { workoutType: 'yoga' });
    expect(written[0]).toMatchObject({ durationMin: null, perceivedEffort: null, note: null });
  });
});

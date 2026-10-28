import type { Db } from '../../database/client.js';
import { toLocalDate } from '../../lib/local-date.js';
import type { DayRefresher } from '../daily-events/daily-events.service.js';
import {
  WorkoutsRepository,
  type WorkoutEventRow,
  type WorkoutSessionRow,
} from './workouts.repository.js';

export interface CreateWorkoutCommand {
  workoutType: WorkoutSessionRow['workoutType'];
  title?: string | undefined;
  occurredAt?: Date | undefined;
  durationMin?: number | undefined;
  perceivedEffort?: number | undefined;
  note?: string | undefined;
}

/** The event title when the person gave none — the type, in the words the UI uses. */
export const WORKOUT_TITLE: Record<WorkoutSessionRow['workoutType'], string> = {
  gym: 'Gym',
  run: 'Run',
  walk: 'Walk',
  yoga: 'Yoga',
  sport: 'Sport',
  home: 'Home workout',
  other: 'Workout',
};

export class WorkoutsService {
  constructor(
    private readonly repository: WorkoutsRepository,
    private readonly getDayRefresher: () => DayRefresher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    userId: string,
    timeZone: string,
    command: CreateWorkoutCommand,
  ): Promise<{ session: WorkoutSessionRow; event: WorkoutEventRow }> {
    const created = await this.write(userId, timeZone, command);
    // A workout is an event: it can satisfy a planned workout (or, as a substitute, a
    // planned walk), and the day's summary counts it.
    await this.refreshDay(userId, created.event.localDate, timeZone);
    return created;
  }

  /** This service over another connection — an `Idempotency-Key` write's transaction. */
  within(db: Db | undefined): WorkoutsService {
    return db ? new WorkoutsService(new WorkoutsRepository(db), this.getDayRefresher, this.now) : this;
  }

  /** `create` without the refresh, for a caller that runs it after its own commit. */
  async write(
    userId: string,
    timeZone: string,
    command: CreateWorkoutCommand,
  ): Promise<{ session: WorkoutSessionRow; event: WorkoutEventRow }> {
    const occurredAt = command.occurredAt ?? this.now();

    return this.repository.create({
      userId,
      // Derived, never taken from the client — as for every other event.
      localDate: toLocalDate(occurredAt, timeZone),
      occurredAt,
      workoutType: command.workoutType,
      title: command.title ?? WORKOUT_TITLE[command.workoutType],
      durationMin: command.durationMin ?? null,
      perceivedEffort: command.perceivedEffort ?? null,
      note: command.note ?? null,
    });
  }

  refreshDay(userId: string, localDate: string, timeZone: string): Promise<void> {
    return this.getDayRefresher().refresh(userId, localDate, timeZone);
  }
}

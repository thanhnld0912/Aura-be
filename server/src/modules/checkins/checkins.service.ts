import type { Db } from '../../database/client.js';
import { todayIn } from '../../lib/local-date.js';
import type { DayRefresher } from '../daily-events/daily-events.service.js';
import { CheckinsRepository, type CheckinRow } from './checkins.repository.js';

export interface UpsertCheckinCommand {
  localDate?: string | undefined;
  mood: CheckinRow['mood'];
  dayTag?: CheckinRow['dayTag'] | undefined;
  energy1to5?: number | undefined;
  note?: string | undefined;
}

export class CheckinsService {
  constructor(
    private readonly repository: CheckinsRepository,
    private readonly getDayRefresher: () => DayRefresher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsert(
    userId: string,
    timeZone: string,
    command: UpsertCheckinCommand,
  ): Promise<{ checkin: CheckinRow; created: boolean }> {
    const result = await this.write(userId, timeZone, command);
    // The check-in is an event, so it counts toward the day and can satisfy a plan
    // item; and the summary carries the day's mood.
    await this.refreshDay(userId, result.checkin.localDate, timeZone);
    return result;
  }

  /** This service over another connection — an `Idempotency-Key` write's transaction. */
  within(db: Db | undefined): CheckinsService {
    return db ? new CheckinsService(new CheckinsRepository(db), this.getDayRefresher, this.now) : this;
  }

  /** `upsert` without the refresh, for a caller that runs it after its own commit. */
  write(
    userId: string,
    timeZone: string,
    command: UpsertCheckinCommand,
  ): Promise<{ checkin: CheckinRow; created: boolean }> {
    const now = this.now();
    // Defaults to today in the *user's* timezone, not the server's.
    const localDate = command.localDate ?? todayIn(timeZone, now);

    return this.repository.upsertForDay({
      userId,
      localDate,
      occurredAt: now,
      mood: command.mood,
      dayTag: command.dayTag ?? null,
      energy1to5: command.energy1to5 ?? null,
      note: command.note ?? null,
    });
  }

  refreshDay(userId: string, localDate: string, timeZone: string): Promise<void> {
    return this.getDayRefresher().refresh(userId, localDate, timeZone);
  }

  list(userId: string, from: string, to: string): Promise<CheckinRow[]> {
    return this.repository.listRange(userId, from, to);
  }
}

import { todayIn } from '../../lib/local-date.js';
import type { DayRefresher } from '../daily-events/daily-events.service.js';
import type { CheckinRow, CheckinsRepository } from './checkins.repository.js';

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
    const now = this.now();
    // Defaults to today in the *user's* timezone, not the server's.
    const localDate = command.localDate ?? todayIn(timeZone, now);

    const result = await this.repository.upsertForDay({
      userId,
      localDate,
      occurredAt: now,
      mood: command.mood,
      dayTag: command.dayTag ?? null,
      energy1to5: command.energy1to5 ?? null,
      note: command.note ?? null,
    });

    // The check-in is an event, so it counts toward the day and can satisfy a plan
    // item; and the summary carries the day's mood.
    await this.getDayRefresher().refresh(userId, localDate, timeZone);
    return result;
  }

  list(userId: string, from: string, to: string): Promise<CheckinRow[]> {
    return this.repository.listRange(userId, from, to);
  }
}

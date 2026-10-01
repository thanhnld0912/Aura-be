import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { LOCAL_DATE_PATTERN, addLocalDays, todayIn } from '../../lib/local-date.js';
import type { UsersRepository } from '../users/users.repository.js';
import type { DayService } from './day.service.js';

/**
 * Finalises one closed local day (PATTERN_ENGINE_DECISIONS.md D15): the authoritative
 * recompute a day gets once it is over, so what the Pattern Engine reads is the day's final
 * state rather than whatever was last written while it was still open.
 *
 * It is `DayService.refresh` — the same reconciliation and summary recompute every write
 * already runs — called for a day the user's calendar has moved past. That is what finalises
 * it: `DailyPlansService.reconcileDay` treats a closed day's unmatched items as `not_logged`
 * instead of `pending`, and the summary then recomputes **every** measure from the source
 * tables, `plan_adherence_pct` included, by the existing rules. Nothing here defines
 * adherence or any other figure.
 *
 * Idempotent: the reconciliation writes the same outcomes on unchanged data and the summary
 * is an upsert on `(user_id, local_date)`. Each write commits before `finalize` returns, so a
 * detection run started afterwards reads the finalised summary.
 */
export class ClosedDayService {
  constructor(
    private readonly users: Pick<UsersRepository, 'findActiveById'>,
    private readonly days: Pick<DayService, 'refresh'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async finalize(userId: string, localDate: string): Promise<void> {
    const user = await this.users.findActiveById(userId);
    if (!user) throw new NotFoundError('User not found');
    assertClosedDay(localDate, todayIn(user.timezone, this.now()));
    await this.days.refresh(userId, localDate, user.timezone);
  }
}

/**
 * The closed-day rule shared by finalisation and pattern detection: a real `YYYY-MM-DD`
 * calendar date strictly before the user's local today. Anything else is refused, never
 * shifted to another day.
 */
export function assertClosedDay(localDate: string, today: string): void {
  if (!LOCAL_DATE_PATTERN.test(localDate) || addLocalDays(localDate, 0) !== localDate) {
    throw new ValidationError('targetDate must be a calendar date', [{ path: 'targetDate', issue: 'invalid_date' }]);
  }
  if (localDate >= today) {
    throw new ValidationError("targetDate must be a closed day, before the user's today", [
      { path: 'targetDate', issue: 'day_not_closed' },
    ]);
  }
}

/**
 * "UTC in, local day out" (DATABASE_DESIGN.md §1.6).
 *
 * Every timestamp is stored as `timestamptz`, but "did they eat breakfast on Tuesday"
 * is a question about the *user's* calendar, not UTC's. A user in Asia/Ho_Chi_Minh
 * logging a meal at 00:30 local is 17:30 UTC on the **previous** day — truncating the
 * UTC instant would file it under the wrong day and quietly corrupt every downstream
 * aggregate, streak and pattern.
 *
 * These helpers are the single place that conversion happens. They take the timezone
 * explicitly rather than reading a global, because the server runs in UTC and each user
 * has their own zone.
 */

/** `YYYY-MM-DD`. */
export type LocalDate = string;
/** `HH:mm`, 24-hour. */
export type LocalTime = string;

export const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Formatter construction is the expensive part; the set of timezones is tiny. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function partsOf(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const found: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') found[part.type] = part.value;
  }
  return found as unknown as LocalParts;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day the instant falls on, in the given timezone. */
export function toLocalDate(instant: Date, timeZone: string): LocalDate {
  const { year, month, day } = partsOf(instant, timeZone);
  return `${year}-${month}-${day}`;
}

/** The wall-clock time the instant shows, in the given timezone. */
export function toLocalTime(instant: Date, timeZone: string): LocalTime {
  const { hour, minute } = partsOf(instant, timeZone);
  return `${hour}:${minute}`;
}

/** Minutes since local midnight — the unit reconciliation compares in. */
export function minutesSinceLocalMidnight(instant: Date, timeZone: string): number {
  const { hour, minute } = partsOf(instant, timeZone);
  return Number(hour) * 60 + Number(minute);
}

/** `'17:30'` or `'17:30:00'` → 1050. Postgres returns `time` with seconds. */
export function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** 1050 → `'17:30'`. */
export function minutesToTime(minutes: number): LocalTime {
  const normalised = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalised / 60);
  return `${String(hours).padStart(2, '0')}:${String(normalised % 60).padStart(2, '0')}`;
}

/** Today's calendar date for a user, from an injectable clock so tests are not flaky. */
export function todayIn(timeZone: string, now: Date = new Date()): LocalDate {
  return toLocalDate(now, timeZone);
}

/** Calendar comparison. Both arguments are `YYYY-MM-DD`, so lexicographic ordering is date ordering. */
export function isBefore(a: LocalDate, b: LocalDate): boolean {
  return a < b;
}

/** `addLocalDays('2026-09-07', -1)` → `'2026-09-06'`. Pure calendar arithmetic, no timezone involved. */
export function addLocalDays(localDate: LocalDate, days: number): LocalDate {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
}

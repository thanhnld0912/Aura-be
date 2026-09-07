import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  minutesSinceLocalMidnight,
  minutesToTime,
  parseTimeToMinutes,
  toLocalDate,
  toLocalTime,
  todayIn,
  isValidTimeZone,
} from '../../src/lib/local-date.js';

const VN = 'Asia/Ho_Chi_Minh'; // UTC+7, no DST
const NY = 'America/New_York'; // UTC-5/-4, has DST

describe('toLocalDate — the day boundary (DATABASE_DESIGN.md §1.6)', () => {
  it('files a Vietnamese post-midnight event under the new local day, not the UTC one', () => {
    // 2026-09-06T17:30:00Z is 2026-09-07 00:30 in Ho Chi Minh City.
    const instant = new Date('2026-09-06T17:30:00Z');
    expect(toLocalDate(instant, VN)).toBe('2026-09-07');
    expect(toLocalTime(instant, VN)).toBe('00:30');
    // Truncating the UTC instant would have filed it a day early.
    expect(instant.toISOString().slice(0, 10)).toBe('2026-09-06');
  });

  it('handles 23:59, 00:00 and 00:01 local either side of midnight', () => {
    expect(toLocalDate(new Date('2026-09-06T16:59:00Z'), VN)).toBe('2026-09-06'); // 23:59
    expect(toLocalDate(new Date('2026-09-06T17:00:00Z'), VN)).toBe('2026-09-07'); // 00:00
    expect(toLocalDate(new Date('2026-09-06T17:01:00Z'), VN)).toBe('2026-09-07'); // 00:01
  });

  it('keeps a late-evening Vietnamese event on the same local day', () => {
    // 23:59 local on the 7th is 16:59Z on the 7th — same date either way, but the
    // time must still read as 23:59 rather than 16:59.
    const instant = new Date('2026-09-07T16:59:00Z');
    expect(toLocalDate(instant, VN)).toBe('2026-09-07');
    expect(toLocalTime(instant, VN)).toBe('23:59');
  });

  it('files a UTC-morning event under the previous local day for a negative offset', () => {
    // 2026-09-07T02:00Z is 2026-09-06 22:00 in New York.
    expect(toLocalDate(new Date('2026-09-07T02:00:00Z'), NY)).toBe('2026-09-06');
    expect(toLocalDate(new Date('2026-09-07T02:00:00Z'), 'UTC')).toBe('2026-09-07');
  });

  it('respects daylight saving transitions', () => {
    // 01:30Z on 2026-01-15 is 20:30 on the 14th (EST, UTC-5).
    expect(toLocalDate(new Date('2026-01-15T01:30:00Z'), NY)).toBe('2026-01-14');
    // 01:30Z on 2026-07-15 is 21:30 on the 14th (EDT, UTC-4).
    expect(toLocalTime(new Date('2026-07-15T01:30:00Z'), NY)).toBe('21:30');
  });

  it('formats midnight as 00:00 rather than 24:00', () => {
    expect(toLocalTime(new Date('2026-09-06T17:00:00Z'), VN)).toBe('00:00');
  });
});

describe('minutesSinceLocalMidnight', () => {
  it('measures from the local midnight, not the UTC one', () => {
    expect(minutesSinceLocalMidnight(new Date('2026-09-06T17:30:00Z'), VN)).toBe(30);
    expect(minutesSinceLocalMidnight(new Date('2026-09-06T17:30:00Z'), 'UTC')).toBe(17 * 60 + 30);
  });

  it('covers both ends of the day', () => {
    expect(minutesSinceLocalMidnight(new Date('2026-09-06T17:00:00Z'), VN)).toBe(0);
    expect(minutesSinceLocalMidnight(new Date('2026-09-07T16:59:00Z'), VN)).toBe(23 * 60 + 59);
  });
});

describe('time helpers', () => {
  it('parses both HH:mm and the HH:mm:ss Postgres returns', () => {
    expect(parseTimeToMinutes('17:30')).toBe(1050);
    expect(parseTimeToMinutes('17:30:00')).toBe(1050);
    expect(parseTimeToMinutes('00:00')).toBe(0);
  });

  it('round-trips', () => {
    expect(minutesToTime(1050)).toBe('17:30');
    expect(minutesToTime(0)).toBe('00:00');
    expect(minutesToTime(1439)).toBe('23:59');
  });
});

describe('calendar arithmetic', () => {
  it('adds and subtracts days across month and year boundaries', () => {
    expect(addLocalDays('2026-09-07', -1)).toBe('2026-09-06');
    expect(addLocalDays('2026-09-01', -1)).toBe('2026-08-31');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });

  it('todayIn takes an injectable clock', () => {
    expect(todayIn(VN, new Date('2026-09-06T17:30:00Z'))).toBe('2026-09-07');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects nonsense', () => {
    expect(isValidTimeZone(VN)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

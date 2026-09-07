import { ConflictError, NotFoundError, UnderageError } from '../../lib/errors.js';
import { isValidTimeZone } from '../../lib/local-date.js';
import { ValidationError } from '../../lib/errors.js';
import type {
  ProvisionInput,
  ProvisionedUser,
  UserPreferencesRow,
  UserRow,
  UserWithPreferences,
  UsersRepository,
} from './users.repository.js';

/** The minimum age AURA accepts (SECURITY.md §7). */
export const MINIMUM_AGE_YEARS = 13;

// `exactOptionalPropertyTypes` is on, and a PATCH body legitimately carries explicit
// `undefined` for fields the client did not send — hence `?: T | undefined` rather
// than `?: T`. The distinction that matters is preserved elsewhere: `quietHours: null`
// clears the setting, while an absent `quietHours` leaves it alone.
export interface ProfilePatch {
  displayName?: string | undefined;
  timezone?: string | undefined;
  locale?: 'vi' | 'en' | undefined;
  avatarUrl?: string | undefined;
  dateOfBirth?: string | undefined;
}

export interface PreferencesPatch {
  unitSystem?: UserPreferencesRow['unitSystem'] | undefined;
  showCalories?: boolean | undefined;
  nutritionDisplay?: UserPreferencesRow['nutritionDisplay'] | undefined;
  dietaryFlags?: string[] | undefined;
  dislikedFoods?: string[] | undefined;
  goalFocus?: UserPreferencesRow['goalFocus'] | undefined;
  aiInsightsEnabled?: boolean | undefined;
  quietHours?: { start: string; end: string } | null | undefined;
}

/**
 * Business logic for the user profile. The only layer allowed to orchestrate
 * (ARCHITECTURE.md §5) — routes call it, and it calls the repository.
 */
export class UsersService {
  constructor(private readonly repository: UsersRepository) {}

  async provision(input: ProvisionInput): Promise<ProvisionedUser> {
    try {
      return await this.repository.provision(input);
    } catch (error) {
      // The email unique constraint is the one that can realistically fire here: a
      // different Supabase account already holds this address in AURA.
      if (isUniqueViolation(error)) {
        throw new ConflictError('That email address is already linked to another account');
      }
      throw error;
    }
  }

  findActive(userId: string): Promise<UserRow | undefined> {
    return this.repository.findActiveById(userId);
  }

  /** Including soft-deleted rows — see `AuthService.assertNotClosed`. */
  findAny(userId: string): Promise<UserRow | undefined> {
    return this.repository.findAnyById(userId);
  }

  findWithPreferences(userId: string): Promise<UserWithPreferences | undefined> {
    return this.repository.findWithPreferences(userId);
  }

  async getProfile(userId: string): Promise<UserWithPreferences> {
    const found = await this.repository.findWithPreferences(userId);
    if (!found) throw new NotFoundError();
    return found;
  }

  async updateProfile(userId: string, patch: ProfilePatch): Promise<UserWithPreferences> {
    if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) {
      throw new ValidationError('timezone: must be a valid IANA timezone', [
        { path: 'timezone', issue: 'invalid_timezone' },
      ]);
    }

    if (patch.dateOfBirth !== undefined) assertOldEnough(patch.dateOfBirth);

    const updated = await this.repository.updateProfile(userId, {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
      ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
      ...(patch.dateOfBirth !== undefined ? { dateOfBirth: patch.dateOfBirth } : {}),
    });
    if (!updated) throw new NotFoundError();

    return this.getProfile(userId);
  }

  async updatePreferences(userId: string, patch: PreferencesPatch): Promise<UserWithPreferences> {
    const { quietHours, ...rest } = patch;

    const updated = await this.repository.updatePreferences(userId, {
      ...rest,
      ...(quietHours !== undefined
        ? quietHours === null
          ? { quietHoursStart: null, quietHoursEnd: null }
          : { quietHoursStart: quietHours.start, quietHoursEnd: quietHours.end }
        : {}),
    });
    if (!updated) throw new NotFoundError();

    return this.getProfile(userId);
  }

  async deleteAccount(userId: string): Promise<void> {
    const deleted = await this.repository.softDelete(userId);
    if (!deleted) throw new NotFoundError();
  }
}

/**
 * The age gate (SECURITY.md §7). Compared on the calendar rather than in milliseconds,
 * so leap years and month lengths cannot produce an off-by-a-day rejection.
 */
export function assertOldEnough(dateOfBirth: string, now: Date = new Date()): void {
  const [year, month, day] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const thirteenth = new Date(Date.UTC(year + MINIMUM_AGE_YEARS, month - 1, day));
  if (thirteenth.getTime() > now.getTime()) {
    throw new UnderageError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

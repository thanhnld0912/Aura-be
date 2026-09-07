import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import { SYSTEM_HABITS } from '../../database/seeds/system-habits.js';
import { habits, userPreferences, users } from '../../database/schema/index.js';

/**
 * The only layer that touches the database for user data (ARCHITECTURE.md §5).
 *
 * Every method takes `userId` as its first argument and every query filters on it —
 * without exception, and never from request input (SECURITY.md §2). There is no method
 * here that can read a row without being told whose row it is.
 */

export type UserRow = typeof users.$inferSelect;
export type UserPreferencesRow = typeof userPreferences.$inferSelect;

export interface UserWithPreferences {
  user: UserRow;
  preferences: UserPreferencesRow;
}

export interface ProvisionedUser extends UserWithPreferences {
  /** True when this call created the row, so the client can route to onboarding. */
  isNewUser: boolean;
}

/**
 * A partial update whose absent fields may be spelled as an explicit `undefined`.
 * `Partial<T>` alone will not do under `exactOptionalPropertyTypes`, and PATCH bodies
 * are built by spreading, which produces exactly that shape.
 */
type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export interface ProvisionInput {
  /** The Supabase uid. Becomes `users.id` verbatim. */
  id: string;
  email: string;
}

export class UsersRepository {
  constructor(private readonly db: Db) {}

  /**
   * JIT provisioning (DATABASE_DESIGN.md §3.1) — safe under concurrency.
   *
   * The first authenticated request from a new user may arrive several times at once
   * (a mobile client retrying, two tabs opening). A read-then-insert would race and
   * one of them would fail on the primary key, so this is a single upsert per table:
   * the database decides who wins, and every caller gets the same row back.
   *
   * System habits are seeded in the same transaction. A user who exists but has no
   * habits would otherwise be a state the streak logic has to defend against forever.
   */
  async provision(input: ProvisionInput): Promise<ProvisionedUser> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ id: input.id, email: input.email })
        .onConflictDoUpdate({
          target: users.id,
          // Email can change in Supabase; the rest is AURA's to own, so the upsert
          // deliberately does not reset displayName, timezone or the streak.
          set: { email: input.email, updatedAt: new Date() },
        })
        // `xmax = 0` is the standard way to tell an upsert's insert from its update:
        // a freshly inserted row has no updating transaction id. It is read inside the
        // same statement, so it stays correct under concurrency where a follow-up
        // SELECT would not.
        .returning({ ...getTableColumns(users), inserted: sql<boolean>`xmax = 0` });

      const [preferences] = await tx
        .insert(userPreferences)
        .values({ userId: input.id })
        .onConflictDoNothing({ target: userPreferences.userId })
        .returning();

      await tx
        .insert(habits)
        .values(
          SYSTEM_HABITS.map((habit) => ({
            userId: input.id,
            key: habit.key,
            title: habit.title,
            cadence: habit.cadence,
            icon: habit.icon,
            isSystem: true,
          })),
        )
        .onConflictDoNothing({ target: [habits.userId, habits.key] });

      if (!user) throw new Error('provisioning did not return a user row');

      // `onConflictDoNothing` returns nothing when the row already existed, which is
      // the common path on every request after the first.
      const resolvedPreferences =
        preferences ??
        (await tx.query.userPreferences.findFirst({
          where: eq(userPreferences.userId, input.id),
        }));

      if (!resolvedPreferences) throw new Error('provisioning did not produce preferences');

      const { inserted, ...userRow } = user;
      return { user: userRow, preferences: resolvedPreferences, isNewUser: inserted };
    });
  }

  /** Active users only — a soft-deleted account must not authenticate. */
  async findActiveById(userId: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({
      where: and(eq(users.id, userId), isNull(users.deletedAt)),
    });
  }

  /**
   * Including soft-deleted rows. Used only to tell "never existed" from "closed": the
   * two must not be conflated, or provisioning would silently resurrect a deleted
   * account on the owner's next request.
   */
  async findAnyById(userId: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.id, userId) });
  }

  async findWithPreferences(userId: string): Promise<UserWithPreferences | undefined> {
    const user = await this.findActiveById(userId);
    if (!user) return undefined;

    const preferences = await this.db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, userId),
    });
    if (!preferences) return undefined;

    return { user, preferences };
  }

  async updateProfile(
    userId: string,
    patch: Patch<Pick<UserRow, 'displayName' | 'timezone' | 'locale' | 'avatarUrl' | 'dateOfBirth'>>,
  ): Promise<UserRow | undefined> {
    const [updated] = await this.db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();
    return updated;
  }

  async updatePreferences(
    userId: string,
    patch: Patch<Omit<UserPreferencesRow, 'userId' | 'updatedAt'>>,
  ): Promise<UserPreferencesRow | undefined> {
    const [updated] = await this.db
      .update(userPreferences)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(userPreferences.userId, userId))
      .returning();
    return updated;
  }

  /**
   * Soft delete. The row and everything cascading from it survive for 30 days so an
   * account deletion is recoverable; a Phase 5 job does the hard delete, including the
   * storage objects (SECURITY.md §9).
   */
  async softDelete(userId: string): Promise<boolean> {
    const [deleted] = await this.db
      .update(users)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning({ id: users.id });
    return deleted !== undefined;
  }
}

import { UnauthenticatedError } from '../../lib/errors.js';
import type { ProvisionedUser, UserWithPreferences } from '../users/users.repository.js';
import type { UsersService } from '../users/users.service.js';
import type { JwtVerifier } from './jwt.js';

/**
 * Turns a Supabase access token into an AURA identity.
 *
 * The whole authorization model rests on one property of this file: the returned
 * `userId` comes from the token's verified `sub` and from nowhere else. No request
 * body, query string or path parameter contributes to it (SECURITY.md §2), which is
 * what makes horizontal privilege escalation structurally impossible rather than
 * merely guarded against.
 */

export interface AuthenticatedUser {
  id: string;
  email: string;
  timezone: string;
}

export class AuthService {
  constructor(
    private readonly verifyToken: JwtVerifier,
    private readonly users: UsersService,
  ) {}

  /**
   * The per-request path. Verifies the token, then resolves the AURA user, creating
   * one on first contact.
   *
   * Steady state is a single indexed read: provisioning only runs when the row is
   * absent, so an established user costs one primary-key lookup rather than a write
   * on every request.
   */
  async authenticate(token: string): Promise<AuthenticatedUser> {
    const verified = await this.verifyToken(token);

    const existing = await this.users.findActive(verified.userId);
    if (existing) {
      return { id: existing.id, email: existing.email, timezone: existing.timezone };
    }

    const provisioned = await this.provision(verified.userId, verified.email);
    return {
      id: provisioned.user.id,
      email: provisioned.user.email,
      timezone: provisioned.user.timezone,
    };
  }

  /**
   * A closed account must not come back to life.
   *
   * Supabase does not know AURA soft-deleted the user, so it keeps issuing valid
   * tokens for the 30 days before the hard delete. Without this check, the very next
   * request would find no *active* row, fall through to provisioning, and the upsert
   * would quietly reinstate the account — deletion would last until the user opened
   * the app again.
   */
  private async assertNotClosed(userId: string): Promise<void> {
    const anyRow = await this.users.findAny(userId);
    if (anyRow) throw new UnauthenticatedError();
  }

  /** `POST /api/auth/session` — verifies and provisions, reporting whether it is a first visit. */
  async createSession(token: string): Promise<ProvisionedUser> {
    const verified = await this.verifyToken(token);
    return this.provision(verified.userId, verified.email);
  }

  async currentUser(userId: string): Promise<UserWithPreferences> {
    const found = await this.users.findWithPreferences(userId);
    // The token verified, but the account is gone — soft-deleted between requests.
    if (!found) throw new UnauthenticatedError();
    return found;
  }

  private async provision(userId: string, email: string | null): Promise<ProvisionedUser> {
    /**
     * AURA supports Supabase's email and OAuth sign-in, both of which always carry an
     * email claim (SECURITY.md §2). A verified token without one is a phone-only
     * account, which the product does not support at MVP — rejected as unauthenticated
     * rather than provisioned into a half-formed row the rest of the system would then
     * have to defend against.
     */
    if (!email) throw new UnauthenticatedError();

    await this.assertNotClosed(userId);
    return this.users.provision({ id: userId, email });
  }
}

import { ProviderError } from '../../lib/errors.js';

/**
 * The only outbound call the auth module makes to Supabase.
 *
 * AURA verifies access tokens locally and holds no session state of its own, so there
 * is nothing server-side for logout to forget. What logout *does* achieve is revoking
 * the refresh token at Supabase, so the client cannot mint a new access token after
 * signing out — without that call, "logged out" would last only until the current
 * token expired.
 */
export interface SupabaseAuthClient {
  /** Revokes the refresh token backing this access token. */
  revokeSession(accessToken: string): Promise<void>;
}

export interface SupabaseAuthClientConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Injected in tests; the real call has no business running in a unit test. */
  fetchImpl?: typeof fetch;
}

export function createSupabaseAuthClient(config: SupabaseAuthClientConfig): SupabaseAuthClient {
  const doFetch = config.fetchImpl ?? fetch;
  const endpoint = new URL('/auth/v1/logout', config.supabaseUrl).toString();

  return {
    async revokeSession(accessToken: string): Promise<void> {
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            // Supabase requires both: the project key to reach the endpoint, and the
            // user's own token to identify which session to revoke.
            apikey: config.serviceRoleKey,
            authorization: `Bearer ${accessToken}`,
          },
          signal: AbortSignal.timeout(5_000),
        });
      } catch (error) {
        throw new ProviderError('supabase', 'Could not reach the authentication service', error);
      }

      // 401 means the token was already invalid, which is the outcome logout wanted.
      if (!response.ok && response.status !== 401) {
        throw new ProviderError('supabase', 'The authentication service rejected the sign-out');
      }
    },
  };
}

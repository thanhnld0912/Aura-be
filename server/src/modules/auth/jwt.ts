import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';
import { UnauthenticatedError } from '../../lib/errors.js';

/**
 * Supabase Auth issues the JWT; this verifies it (SECURITY.md §2).
 *
 * Checks signature, `exp`, `iss` and `aud`. Every failure returns the same
 * `401 UNAUTHENTICATED` with no hint about *which* check failed — telling a caller
 * "expired" rather than "bad signature" hands them a probing oracle.
 *
 * Both Supabase key regimes are supported because both are live in the wild: older
 * projects sign HS256 with the project's JWT secret, newer ones use asymmetric keys
 * published as JWKS. The algorithm in the token header selects the key, and only the
 * configured regimes are accepted — a token asking for an algorithm we hold no key for
 * is rejected rather than falling through.
 */

/** Supabase signs access tokens with this audience. */
export const SUPABASE_AUDIENCE = 'authenticated';

const HMAC_ALGORITHMS = new Set(['HS256', 'HS384', 'HS512']);
const ASYMMETRIC_ALGORITHMS = new Set(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512']);

/**
 * The claims AURA actually uses. `sub` is the Supabase uid and becomes `users.id`;
 * everything else is incidental. Parsed rather than cast — a token is input, and the
 * one field the whole authorization model rests on gets a uuid check.
 */
const claimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email().optional(),
  role: z.string().optional(),
});

export interface VerifiedToken {
  /** The Supabase uid. The only source of user identity in the system. */
  userId: string;
  email: string | null;
}

export interface JwtVerifierConfig {
  /** Expected `iss`, e.g. `https://<project>.supabase.co/auth/v1`. */
  issuer: string;
  audience?: string;
  /** HS256 shared secret — `SUPABASE_JWT_SECRET`. */
  secret?: string | undefined;
  /** Where to fetch the asymmetric key set. Cached and rotated by `jose`. */
  jwksUri?: string | undefined;
  /** Pre-resolved key set. Used by tests to exercise the asymmetric path offline. */
  jwks?: JSONWebKeySet | undefined;
}

export type JwtVerifier = (token: string) => Promise<VerifiedToken>;

export function createJwtVerifier(config: JwtVerifierConfig): JwtVerifier {
  const audience = config.audience ?? SUPABASE_AUDIENCE;
  const secretKey = config.secret ? new TextEncoder().encode(config.secret) : undefined;

  let remoteJwks: JWTVerifyGetKey | undefined;
  if (config.jwks) {
    remoteJwks = createLocalJWKSet(config.jwks);
  } else if (config.jwksUri) {
    // `jose` caches the key set and re-fetches on unknown `kid`, so this is one request
    // per key rotation rather than one per token.
    remoteJwks = createRemoteJWKSet(new URL(config.jwksUri));
  }

  if (!secretKey && !remoteJwks) {
    throw new Error(
      'JWT verification needs a key: set SUPABASE_JWT_SECRET, or SUPABASE_URL for JWKS.',
    );
  }

  return async function verify(token: string): Promise<VerifiedToken> {
    try {
      const { alg } = decodeProtectedHeader(token);
      if (!alg) throw new Error('missing alg');

      let payload;
      if (HMAC_ALGORITHMS.has(alg)) {
        if (!secretKey) throw new Error('no symmetric key configured');
        ({ payload } = await jwtVerify(token, secretKey, {
          issuer: config.issuer,
          audience,
          algorithms: [alg],
        }));
      } else if (ASYMMETRIC_ALGORITHMS.has(alg)) {
        if (!remoteJwks) throw new Error('no key set configured');
        ({ payload } = await jwtVerify(token, remoteJwks, {
          issuer: config.issuer,
          audience,
          algorithms: [...ASYMMETRIC_ALGORITHMS],
        }));
      } else {
        // Explicitly including `none`, which must never be honoured.
        throw new Error(`unsupported alg ${alg}`);
      }

      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) throw new Error('unexpected claims');

      return { userId: claims.data.sub, email: claims.data.email ?? null };
    } catch {
      // Deliberately uniform: the caller learns only that the token was not accepted.
      throw new UnauthenticatedError();
    }
  };
}

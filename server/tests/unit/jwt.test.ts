import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { UnauthenticatedError } from '../../src/lib/errors.js';
import { createJwtVerifier } from '../../src/modules/auth/jwt.js';

const ISSUER = 'https://project.supabase.co/auth/v1';
// Not a secret — a fixed test signing key. See tests/helpers/app.ts.
const SECRET = 'a-test-jwt-secret-that-is-long-enough-for-hs256'; // gitleaks:allow
const USER_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const key = new TextEncoder().encode(SECRET);

interface TokenOptions {
  sub?: string;
  email?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  issuedAt?: number;
}

async function hs256Token(options: TokenOptions = {}): Promise<string> {
  return new SignJWT({ email: options.email ?? 'thanh@example.com', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(options.sub ?? USER_ID)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? 'authenticated')
    .setIssuedAt(options.issuedAt)
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(key);
}

const verifier = createJwtVerifier({ issuer: ISSUER, secret: SECRET });

describe('JWT verification — the accepted path', () => {
  it('accepts a well-formed Supabase token and returns the uid', async () => {
    await expect(verifier(await hs256Token())).resolves.toEqual({
      userId: USER_ID,
      email: 'thanh@example.com',
    });
  });

  it('tolerates a token with no email claim', async () => {
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(key);

    await expect(verifier(token)).resolves.toEqual({ userId: USER_ID, email: null });
  });
});

describe('JWT verification — rejection (SECURITY.md §2)', () => {
  const rejects = async (token: string) => {
    await expect(verifier(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  };

  it('rejects an expired token', async () => {
    const expired = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
    await rejects(expired);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-different-secret-entirely-not-the-real-one'));
    await rejects(forged);
  });

  it('rejects a token from a different issuer', async () => {
    await rejects(await hs256Token({ issuer: 'https://attacker.example/auth/v1' }));
  });

  it('rejects a token for a different audience', async () => {
    await rejects(await hs256Token({ audience: 'anon' }));
  });

  it('rejects a token whose sub is not a uuid', async () => {
    await rejects(await hs256Token({ sub: 'not-a-uuid' }));
  });

  it('rejects the alg:none forgery', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: USER_ID,
        iss: ISSUER,
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    await rejects(`${header}.${payload}.`);
  });

  it('rejects garbage and empty input', async () => {
    await rejects('not-a-token');
    await rejects('');
    await rejects('a.b.c');
  });

  it('gives the same message whichever check failed, so it cannot be used as an oracle', async () => {
    const messages = await Promise.all(
      [
        hs256Token({ issuer: 'https://attacker.example/auth/v1' }),
        hs256Token({ audience: 'anon' }),
        hs256Token({ sub: 'not-a-uuid' }),
      ].map(async (tokenPromise) => {
        try {
          await verifier(await tokenPromise);
          return 'accepted';
        } catch (error) {
          return (error as Error).message;
        }
      }),
    );
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('Authentication required');
  });
});

describe('JWT verification — asymmetric keys', () => {
  let jwks: JSONWebKeySet;
  let esToken: string;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    jwks = { keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'test-key' }] };
    esToken = await new SignJWT({ email: 'thanh@example.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(USER_ID)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(privateKey);
  });

  it('verifies an ES256 token against a key set', async () => {
    const asymmetric = createJwtVerifier({ issuer: ISSUER, jwks });
    await expect(asymmetric(esToken)).resolves.toMatchObject({ userId: USER_ID });
  });

  it('rejects an asymmetric token when only a shared secret is configured', async () => {
    await expect(verifier(esToken)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects an HS256 token when only a key set is configured', async () => {
    const asymmetric = createJwtVerifier({ issuer: ISSUER, jwks });
    await expect(asymmetric(await hs256Token())).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('why a token was refused — for the log, never the caller', () => {
  const reasonFor = async (token: string): Promise<string | undefined> => {
    try {
      await verifier(token);
      throw new Error('expected the token to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthenticatedError);
      return (error as UnauthenticatedError).reason;
    }
  };

  it('distinguishes the checks, so an unexplained 401 can be explained', async () => {
    expect(await reasonFor(await hs256Token({ expiresIn: '-1h' }))).toContain('ERR_JWT_EXPIRED');
    expect(await reasonFor(await hs256Token({ issuer: 'https://evil.test/auth/v1' }))).toContain(
      'iss',
    );
    expect(await reasonFor(await hs256Token({ audience: 'anon' }))).toContain('aud');
    expect(await reasonFor('not.a.jwt')).toBeTruthy();
  });

  it('names the misconfiguration when no key can verify the algorithm', async () => {
    const jwksOnly = createJwtVerifier({ issuer: ISSUER, jwks: { keys: [] } });
    await expect(jwksOnly(await hs256Token())).rejects.toMatchObject({
      reason: 'no symmetric key configured',
    });
  });

  /**
   * The reason reaches the log. A token in a log is a credential in a log
   * (SECURITY.md §9), so no part of the token may survive into this string.
   */
  it('never quotes the token itself', async () => {
    const token = await hs256Token({ expiresIn: '-1h' });
    const reason = (await reasonFor(token)) ?? '';
    expect(reason.length).toBeLessThanOrEqual(80);
    for (const segment of token.split('.')) {
      expect(reason).not.toContain(segment);
    }
  });
});

describe('JWT verifier construction', () => {
  it('refuses to build with no key at all, rather than accepting everything', () => {
    expect(() => createJwtVerifier({ issuer: ISSUER })).toThrow(/needs a key/);
  });
});

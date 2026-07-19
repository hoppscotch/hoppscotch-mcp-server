import { describe, it, expect, afterEach } from 'vitest';
import { getValidToken, jwtSubject } from './auth.js';

// getValidToken takes an EXPLICIT token (config.accessToken). It does NOT read
// HOPPSCOTCH_ACCESS_TOKEN itself — that env var is read only at the CLI boundary
// (loadConfig), which threads it in as the 4th argument. That the env var isn't
// read here is what keeps an ambient host token from crossing into an embedder;
// the dedicated leak-guard lives in auth.leak-guard.test.ts. The browser
// device-login flow is exercised by the fake-frontend harness in
// auth.login-flow.test.ts.
describe('getValidToken — explicit token contract', () => {
  const originalEnv = process.env.HOPPSCOTCH_ACCESS_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.HOPPSCOTCH_ACCESS_TOKEN;
    } else {
      process.env.HOPPSCOTCH_ACCESS_TOKEN = originalEnv;
    }
  });

  it('returns the explicit token verbatim (no env var set)', async () => {
    delete process.env.HOPPSCOTCH_ACCESS_TOKEN;
    const token = await getValidToken(
      'https://hoppscotch.io',
      'https://api.hoppscotch.io',
      'cloud',
      'jwt-from-config'
    );
    expect(token).toBe('jwt-from-config');
  });

  it('returns synchronously for an explicit token (no browser login)', async () => {
    delete process.env.HOPPSCOTCH_ACCESS_TOKEN;
    const start = Date.now();
    await getValidToken('https://hoppscotch.io', 'https://api.hoppscotch.io', 'cloud', 'jwt-from-config');
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('returns the explicit token even when a different env var is set (env not consulted here)', async () => {
    // Guards against an env-first ordering bug: the explicit token is
    // authoritative and the ambient env var must not override it.
    process.env.HOPPSCOTCH_ACCESS_TOKEN = 'jwt-from-env-ignored';
    const token = await getValidToken(
      'https://hoppscotch.io',
      'https://api.hoppscotch.io',
      'cloud',
      'jwt-from-config'
    );
    expect(token).toBe('jwt-from-config');
  });

  it('repeated calls with the same explicit token return the same value', async () => {
    delete process.env.HOPPSCOTCH_ACCESS_TOKEN;
    const a = await getValidToken('https://hoppscotch.io', 'https://api.hoppscotch.io', 'cloud', 'persistent-jwt');
    const b = await getValidToken('https://hoppscotch.io', 'https://api.hoppscotch.io', 'cloud', 'persistent-jwt');
    expect(a).toBe(b);
    expect(a).toBe('persistent-jwt');
  });
});

/**
 * Test the export surface: getValidToken exists and is async. Catches
 * accidental rename/removal during refactors.
 */
describe('auth module shape', () => {
  it('exports an async getValidToken function', () => {
    expect(typeof getValidToken).toBe('function');
    expect(getValidToken.constructor.name).toBe('AsyncFunction');
  });
});

describe('jwtSubject — account identity extraction', () => {
  const jwt = (payload: object) => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
  };

  it('extracts sub from a Firebase / JWT id token', () => {
    expect(jwtSubject(jwt({ sub: 'firebase-uid-1', exp: 9999999999 }))).toBe('firebase-uid-1');
  });

  it('falls back to user_id then email when sub is absent', () => {
    expect(jwtSubject(jwt({ user_id: 'uid-2' }))).toBe('uid-2');
    expect(jwtSubject(jwt({ email: 'a@b.com' }))).toBe('a@b.com');
  });

  it('returns null for a PAT / non-JWT or a token with no identity claim', () => {
    expect(jwtSubject('pat-abc123')).toBeNull();
    expect(jwtSubject(jwt({ exp: 123 }))).toBeNull();
    expect(jwtSubject('not-a-jwt')).toBeNull();
  });
});

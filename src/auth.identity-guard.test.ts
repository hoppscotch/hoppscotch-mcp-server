import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep the flow off the real filesystem AND make the on-disk token controllable
// per test, so the account-switch guard in getValidToken's disk-read path can be
// exercised end-to-end (round-1/2 flagged that it had helper-only coverage).
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('ENOENT (mocked)');
  }),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { readFileSync, writeFileSync } from 'fs';
import {
  getValidToken,
  clearStoredAuth,
  reauthenticate,
  __dropMemCacheForTests,
  __resetSessionIdentityForTests,
} from './auth.js';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtFor = (sub: string, expSec = 9_999_999_999) =>
  `${b64({ alg: 'none' })}.${b64({ sub, exp: expSec })}.sig`;
const FUTURE = Date.now() + 60 * 60 * 1000;

const CLOUD = ['https://hoppscotch.io', 'https://api.hoppscotch.io', 'cloud'] as const;
const cloudStore = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    accessToken: jwtFor('account-A'),
    refreshToken: null,
    expiresAt: FUTURE,
    apiUrl: 'https://api.hoppscotch.io',
    apiType: 'cloud',
    ...over,
  });

beforeEach(() => {
  delete process.env.HOPPSCOTCH_ACCESS_TOKEN;
  clearStoredAuth(); // clears the in-process cache + wipes the (mocked) disk
  __resetSessionIdentityForTests(); // unpin between cases (prod re-pins only via a completed sign-in)
  vi.mocked(readFileSync).mockReset();
});

describe('identity-switch guard (getValidToken disk-read refusal)', () => {
  it('serves the pinned account, then REFUSES a silent switch to a different account', async () => {
    vi.mocked(readFileSync).mockReturnValue(cloudStore({ accessToken: jwtFor('account-A') }));
    await expect(getValidToken(...CLOUD)).resolves.toBe(jwtFor('account-A')); // pins A

    __dropMemCacheForTests(); // force a disk re-read; identity stays pinned to A
    vi.mocked(readFileSync).mockReturnValue(cloudStore({ accessToken: jwtFor('account-B') }));
    await expect(getValidToken(...CLOUD)).rejects.toThrow(/Signed-in account changed/);
  });

  it('keeps serving the SAME account across a cache drop (no false positive)', async () => {
    vi.mocked(readFileSync).mockReturnValue(cloudStore({ accessToken: jwtFor('account-A') }));
    await getValidToken(...CLOUD);
    __dropMemCacheForTests();
    await expect(getValidToken(...CLOUD)).resolves.toBe(jwtFor('account-A'));
  });

  it('refuses an unidentifiable (null-subject) token once the session is pinned (fail closed)', async () => {
    vi.mocked(readFileSync).mockReturnValue(cloudStore({ accessToken: jwtFor('account-A') }));
    await getValidToken(...CLOUD); // pin A
    __dropMemCacheForTests();
    // An opaque token (no `sub`) cannot prove it belongs to A, so refuse rather than serve.
    vi.mocked(readFileSync).mockReturnValue(cloudStore({ accessToken: 'opaque-no-sub-token' }));
    await expect(getValidToken(...CLOUD)).rejects.toThrow(/Signed-in account changed/);
  });

  it('serves an unidentifiable token when the session is NOT yet pinned (first use)', async () => {
    vi.mocked(readFileSync).mockReturnValue(cloudStore({ accessToken: 'opaque-first-token' }));
    await expect(getValidToken(...CLOUD)).resolves.toBe('opaque-first-token');
  });

  it('refuses when a token refresh yields a DIFFERENT account (SH refresh path)', async () => {
    const SH = ['https://sh.example.com', 'https://sh.example.com/backend', 'selfhost'] as const;
    const shStore = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        accessToken: jwtFor('account-A'),
        refreshToken: 'rt',
        expiresAt: FUTURE,
        apiUrl: 'https://sh.example.com/backend',
        apiType: 'selfhost',
        ...over,
      });

    vi.mocked(readFileSync).mockReturnValue(shStore());
    await getValidToken(...SH); // pin A
    __dropMemCacheForTests();

    // A's stored token now expired; the refresh endpoint returns account B's token.
    vi.mocked(readFileSync).mockReturnValue(shStore({ expiresAt: Date.now() - 1000 }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: jwtFor('account-B') }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(getValidToken(...SH)).rejects.toThrow(/Signed-in account changed/);

    // The rejected refresh must NOT have persisted account B to disk: an unpinned
    // later start would otherwise silently adopt it. (Round-4 fix: the SH refresh
    // now persists only AFTER the identity check, mirroring the Cloud path.)
    const bToken = jwtFor('account-B');
    const persistedB = vi
      .mocked(writeFileSync)
      .mock.calls.some(([, data]) => typeof data === 'string' && data.includes(bToken));
    expect(persistedB).toBe(false);
    vi.unstubAllGlobals();
  });

  it('refuses a FRESH-START refresh yielding a different account (unpinned), and does not persist it', async () => {
    const SH = ['https://sh.example.com', 'https://sh.example.com/backend', 'selfhost'] as const;
    // Expired A token on disk, nothing served yet ⇒ sessionSubject is null (unpinned).
    // The stored token still PROVES account-A; a refresh returning account-B must be
    // refused via the stored-subject arm (round-5 fix), not silently adopted.
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        accessToken: jwtFor('account-A'),
        refreshToken: 'rt',
        expiresAt: Date.now() - 1000,
        apiUrl: 'https://sh.example.com/backend',
        apiType: 'selfhost',
      })
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: jwtFor('account-B') }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(getValidToken(...SH)).rejects.toThrow(/Signed-in account changed/);
    const persistedB = vi
      .mocked(writeFileSync)
      .mock.calls.some(
        ([, data]) => typeof data === 'string' && data.includes(jwtFor('account-B'))
      );
    expect(persistedB).toBe(false);
    vi.unstubAllGlobals();
  });

  it('allows a fresh-start refresh that returns the SAME account (no over-refusal)', async () => {
    const SH = ['https://sh.example.com', 'https://sh.example.com/backend', 'selfhost'] as const;
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        accessToken: jwtFor('account-A'),
        refreshToken: 'rt',
        expiresAt: Date.now() - 1000,
        apiUrl: 'https://sh.example.com/backend',
        apiType: 'selfhost',
      })
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: jwtFor('account-A') }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(getValidToken(...SH)).resolves.toBe(jwtFor('account-A'));
    vi.unstubAllGlobals();
  });
});

describe('reauthenticate strict disk-clear', () => {
  it('fails loudly when the stored session survives the clear (old token would be re-served)', async () => {
    // Simulate a store that cannot actually be cleared: reads keep returning the
    // same-apiUrl session no matter what was written.
    vi.mocked(readFileSync).mockReturnValue(cloudStore());
    await expect(reauthenticate(...CLOUD)).rejects.toThrow(/could not clear the stored session/);
  });

  it('fails when a session for a different API survives the single shared auth-file clear', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      cloudStore({ apiUrl: 'https://other-hoppscotch.example/backend' })
    );

    await expect(reauthenticate(...CLOUD)).rejects.toThrow(/could not clear the stored session/);
  });

  it('fails before returning a configured static token when any stored session survives', async () => {
    vi.mocked(readFileSync).mockReturnValue(cloudStore());

    await expect(reauthenticate(...CLOUD, 'configured-static-token')).rejects.toThrow(
      /could not clear the stored session/
    );
  });
});

describe('reauthenticate strict disk-clear — edge cases', () => {
  it('treats a missing store (first run, ENOENT) as already clear and proceeds', async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT (mocked)'), { code: 'ENOENT' });
    });
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT (mocked)'), { code: 'ENOENT' });
    });
    // Static token short-circuits the login flow, so only the clear path is exercised.
    await expect(reauthenticate(...CLOUD, jwtFor('account-A'))).resolves.toBe(jwtFor('account-A'));
    vi.mocked(writeFileSync).mockReset();
  });

  it('fails loudly when the store is unwritable AND unreadable (clear unverifiable)', async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('EACCES (mocked)'), { code: 'EACCES' });
    });
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error('EACCES (mocked)'), { code: 'EACCES' });
    });
    await expect(reauthenticate(...CLOUD)).rejects.toThrow(/could not clear the stored session/);
    vi.mocked(writeFileSync).mockReset();
  });

  it('keeps the identity pinned through reauth: a different-account token landing on disk after a verified clear is refused', async () => {
    // Pin account A via a normal disk read.
    vi.mocked(readFileSync).mockReturnValue(cloudStore({ accessToken: jwtFor('account-A') }));
    await expect(getValidToken(...CLOUD)).resolves.toBe(jwtFor('account-A'));

    // reauth: readback sees a clean store, but by the time the generic disk
    // read runs, another process has written account B. The still-pinned
    // identity guard must refuse it instead of silently adopting B.
    vi.mocked(readFileSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT (mocked)'), { code: 'ENOENT' });
      })
      .mockReturnValue(cloudStore({ accessToken: jwtFor('account-B') }));
    await expect(reauthenticate(...CLOUD)).rejects.toThrow(/Signed-in account changed/);
  });
});

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fake-frontend harness for the browser device-login flow.
//
// Both deployed Hoppscotch frontends deliver tokens to the redirect_uri by
// naive string concatenation:
//   Cloud  (hoppscotch.io):           axios.get(`${redirect_uri}?access_token=${token}`)
//   SH     (self-hosted web app):     axios.get(`${redirect_uri}?access_token=…&refresh_token=…`)
//
// These tests replicate that EXACT behavior against the real callback
// server, so any callback-URL shape that a literal-`?` append would mangle
// (e.g. a nonce in the query string, the regression behind "Login timed
// out after 5 minutes") fails here.
// ---------------------------------------------------------------------------

const { openCalls } = vi.hoisted(() => ({ openCalls: [] as string[] }));

// Capture the login URL instead of launching a browser.
vi.mock('open', () => ({
  default: (url: string) => {
    openCalls.push(url);
    return Promise.resolve();
  },
}));

// Keep the flow off the real filesystem: no reads of a previous session's
// token, no writes to the user's real ~/.config/hoppscotch-mcp/auth.json.
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('ENOENT (mocked)');
  }),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { writeFileSync } from 'fs';
import { getValidToken, reauthenticate } from './auth.js';

const originalEnv = process.env.HOPPSCOTCH_ACCESS_TOKEN;
const originalFirebaseKey = process.env.HOPPSCOTCH_FIREBASE_API_KEY;
const originalForceBrowser = process.env.HOPPSCOTCH_FORCE_BROWSER_LOGIN;

beforeEach(() => {
  // The env token would short-circuit before the login flow ever runs.
  delete process.env.HOPPSCOTCH_ACCESS_TOKEN;
  // The Cloud key is baked in at build time, so a source/test run has none and
  // the exchange would fail before the behaviour under test. fetch is stubbed
  // per-test, so the value is never sent anywhere.
  process.env.HOPPSCOTCH_FIREBASE_API_KEY = 'test-firebase-key';
  // runLoginFlow refuses to open a browser when it detects a headless host, and
  // every CI runner sets CI=true, so without this override these tests would
  // pass on a developer machine and fail in CI. `open` is mocked above, so no
  // browser is ever launched; this only keeps the guard from short-circuiting
  // the flow under test. The guard itself is covered separately below.
  process.env.HOPPSCOTCH_FORCE_BROWSER_LOGIN = 'true';
  openCalls.length = 0;
});

afterAll(() => {
  if (originalEnv === undefined) {
    delete process.env.HOPPSCOTCH_ACCESS_TOKEN;
  } else {
    process.env.HOPPSCOTCH_ACCESS_TOKEN = originalEnv;
  }
  if (originalFirebaseKey === undefined) {
    delete process.env.HOPPSCOTCH_FIREBASE_API_KEY;
  } else {
    process.env.HOPPSCOTCH_FIREBASE_API_KEY = originalFirebaseKey;
  }
  if (originalForceBrowser === undefined) {
    delete process.env.HOPPSCOTCH_FORCE_BROWSER_LOGIN;
  } else {
    process.env.HOPPSCOTCH_FORCE_BROWSER_LOGIN = originalForceBrowser;
  }
});

describe('headless guard', () => {
  const originalCI = process.env.CI;

  afterAll(() => {
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
  });

  // Pins CI explicitly rather than reading the ambient value, so this asserts the
  // same thing on a developer machine (CI unset) and on a runner (CI=true).
  it('refuses to open a browser on a headless host without the override', async () => {
    process.env.CI = 'true';
    delete process.env.HOPPSCOTCH_FORCE_BROWSER_LOGIN;

    await expect(getValidToken()).rejects.toThrow(/headless\/CI\/SSH environment detected/);
    // No browser was launched, and no callback server was left listening.
    expect(openCalls).toHaveLength(0);
  });

  // The override path is not re-asserted here: every other test in this file
  // already exercises it, since beforeEach sets HOPPSCOTCH_FORCE_BROWSER_LOGIN.
});

/** Poll until the login URL is emitted (open() fires after both loopback binds settle). */
async function waitForLoginUrl(timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (openCalls.length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error('login URL was never emitted');
    await new Promise((r) => setTimeout(r, 10));
  }
  return openCalls[openCalls.length - 1];
}

function redirectUriFrom(loginUrl: string): string {
  const redirect = new URL(loginUrl).searchParams.get('redirect_uri');
  expect(redirect).toBeTruthy();
  return redirect!;
}

// All tests use apiType 'selfhost' so the flow resolves with the raw callback
// token instead of attempting the (network-bound) Firebase custom-token
// exchange. The code under test, callback URL shape and handler parsing,
// runs before the apiType branch, so coverage is identical for Cloud.
// Each test uses a distinct apiUrl so the module-level memCache never
// satisfies a later test with an earlier token.
describe('device-login callback — survives deployed frontends', () => {
  it('delivers tokens through SH-style `?access_token=…&refresh_token=…` concatenation', async () => {
    const tokenPromise = getValidToken(
      'https://sh1.example.com',
      'https://sh1.example.com/backend',
      'selfhost'
    );
    const redirectUri = redirectUriFrom(await waitForLoginUrl());

    // Replicate the self-hosted web app's device-login page verbatim.
    const res = await fetch(
      `${redirectUri}?access_token=${encodeURIComponent('sh-jwt')}&refresh_token=${encodeURIComponent('sh-refresh')}`
    );
    expect(res.status).toBe(200);
    await expect(tokenPromise).resolves.toBe('sh-jwt');
  });

  it('delivers tokens through Cloud-style `?access_token=…` concatenation', async () => {
    const tokenPromise = getValidToken(
      'https://sh2.example.com',
      'https://sh2.example.com/backend',
      'selfhost'
    );
    const redirectUri = redirectUriFrom(await waitForLoginUrl());

    // Replicate the Cloud (hoppscotch.io) device-login page verbatim (single param).
    const res = await fetch(`${redirectUri}?access_token=cloud-style-token`);
    expect(res.status).toBe(200);
    await expect(tokenPromise).resolves.toBe('cloud-style-token');
  });

  it('rejects a forged nonce with 400 and keeps waiting for the real callback', async () => {
    const tokenPromise = getValidToken(
      'https://sh3.example.com',
      'https://sh3.example.com/backend',
      'selfhost'
    );
    const redirectUri = redirectUriFrom(await waitForLoginUrl());
    const origin = new URL(redirectUri).origin;

    // Same length as a real 32-byte base64url nonce, wrong value.
    const forged = `${origin}/callback/${'A'.repeat(43)}?access_token=evil`;
    const res = await fetch(forged);
    expect(res.status).toBe(400);

    // The flow must NOT have settled: the legitimate callback still wins.
    const ok = await fetch(`${redirectUri}?access_token=legit`);
    expect(ok.status).toBe(200);
    await expect(tokenPromise).resolves.toBe('legit');
  });

  it('refuses a callback bearing a foreign Origin header with 403', async () => {
    const tokenPromise = getValidToken(
      'https://sh4.example.com',
      'https://sh4.example.com/backend',
      'selfhost'
    );
    const redirectUri = redirectUriFrom(await waitForLoginUrl());

    const res = await fetch(`${redirectUri}?access_token=evil`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);

    // Settle the flow so no 5-minute timer outlives the test.
    const ok = await fetch(`${redirectUri}?access_token=legit-after-403`);
    expect(ok.status).toBe(200);
    await expect(tokenPromise).resolves.toBe('legit-after-403');
  });

  it('prompt timeout surfaces the login URL but keeps the callback server alive for a late sign-in', async () => {
    process.env.HOPPSCOTCH_AUTH_TIMEOUT_MS = '50';
    try {
      const p1 = getValidToken(
        'https://sh5.example.com',
        'https://sh5.example.com/backend',
        'selfhost'
      );
      const redirectUri = redirectUriFrom(await waitForLoginUrl());

      // The call gives up after the short prompt timeout and the rejection
      // carries the login URL + retry guidance (not an opaque hang).
      await expect(p1).rejects.toThrow(/device-login/);
      await expect(p1).rejects.toThrow(/run the tool again/i);

      // The callback server is STILL alive after the prompt timeout, so a late
      // sign-in still completes (old behavior closed the server on timeout →
      // this would 410/refuse).
      const res = await fetch(`${redirectUri}?access_token=late-token`);
      expect(res.status).toBe(200);
    } finally {
      delete process.env.HOPPSCOTCH_AUTH_TIMEOUT_MS;
    }
  });

  it('reauthenticate starts a fresh login flow and resolves on callback', async () => {
    const p = reauthenticate(
      'https://sh6.example.com',
      'https://sh6.example.com/backend',
      'selfhost'
    );
    const redirectUri = redirectUriFrom(await waitForLoginUrl());
    const res = await fetch(`${redirectUri}?access_token=reauth-token`);
    expect(res.status).toBe(200);
    await expect(p).resolves.toBe('reauth-token');
  });

  it('reauthenticate aborts an in-flight login: old callback dies, fresh flow starts', async () => {
    // F1 is in flight and a caller is blocked awaiting it.
    const p1 = getValidToken(
      'https://sh7.example.com',
      'https://sh7.example.com/backend',
      'selfhost'
    );
    const oldRedirect = redirectUriFrom(await waitForLoginUrl());
    // Attach the rejection assertion now so the abort rejection is always handled.
    const p1Rejected = expect(p1).rejects.toThrow(/aborted/i);

    // Reset the open() capture so the next waitForLoginUrl picks up F2's URL, not F1's.
    openCalls.length = 0;

    // Re-auth aborts F1 and immediately opens a fresh flow F2.
    const p2 = reauthenticate(
      'https://sh7.example.com',
      'https://sh7.example.com/backend',
      'selfhost'
    );
    const newRedirect = redirectUriFrom(await waitForLoginUrl());

    // The blocked F1 caller is rejected (explicit re-auth abandons the old flow).
    await p1Rejected;

    // F1's old callback can no longer complete a login: its listeners were torn
    // down by the abort (socket closed → fetch throws; or, if the ephemeral port
    // was reused by F2, the stale nonce yields a non-200). Either way: not a 200.
    const stale = await fetch(`${oldRedirect}?access_token=stale-should-be-ignored`).catch(
      () => null
    );
    expect(stale === null || stale.status !== 200).toBe(true);

    // F2 completes normally with the fresh token.
    const res = await fetch(`${newRedirect}?access_token=fresh-after-reauth`);
    expect(res.status).toBe(200);
    await expect(p2).resolves.toBe('fresh-after-reauth');
  });

  it('reauthenticate DURING the Cloud token exchange does not persist the stale token', async () => {
    // The Cloud path runs an async Firebase exchange AFTER the callback has
    // already flipped `settled`, so an abort that lands mid-exchange can't go
    // through settleOnce. Gate the exchange so we can interpose a reauth between
    // "callback received" and "exchange resolved", then assert the now-stale
    // token is never written/cached.
    let releaseExchange: (value?: unknown) => void = () => {};
    const exchangeGate = new Promise((r) => {
      releaseExchange = r;
    });
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      const u = String(url);
      // Pass real callback-server traffic through; gate only the Firebase exchange.
      if (u.startsWith('http://localhost')) return realFetch(url, init);
      const body = JSON.parse(String(init?.body ?? '{}')) as { token?: string };
      return exchangeGate.then(() => ({
        ok: true,
        json: async () => ({ idToken: `idtoken-for-${body.token}`, refreshToken: 'fb-refresh' }),
      })) as unknown as Promise<Response>;
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const p1 = getValidToken('https://hoppscotch.io', 'https://api.hoppscotch.io', 'cloud');
      const f1redirect = redirectUriFrom(await waitForLoginUrl());
      const p1Rejected = expect(p1).rejects.toThrow(/aborted/i);

      // Deliver F1's callback → settleOnce fires → the Cloud exchange starts and
      // blocks on the gate.
      const cb = await fetch(`${f1redirect}?access_token=f1-custom`);
      expect(cb.status).toBe(200);

      // Re-auth mid-exchange: aborts F1, opens a fresh F2.
      openCalls.length = 0;
      const p2 = reauthenticate('https://hoppscotch.io', 'https://api.hoppscotch.io', 'cloud');
      const f2redirect = redirectUriFrom(await waitForLoginUrl());

      // Now let the stale F1 exchange resolve. The signal.aborted gate must turn
      // it into a rejection with NO storeAuth/setMemCache.
      releaseExchange();
      await p1Rejected;

      const calls = (writeFileSync as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const persistedStale = calls.some(
        (c) => typeof c[1] === 'string' && c[1].includes('idtoken-for-f1-custom')
      );
      expect(persistedStale).toBe(false);

      // Settle F2 so its callback server + TTL timer don't outlive the test.
      const f2res = await fetch(`${f2redirect}?access_token=f2-custom`);
      expect(f2res.status).toBe(200);
      await expect(p2).resolves.toBe('idtoken-for-f2-custom');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock the browser launcher so the device-login flow never opens a real browser
// (kept fully local and hermetic: no network, no window). File-scoped mock.
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

import { getValidToken } from './auth.js';

describe('getValidToken — ambient-env leak guard', () => {
  const originalEnv = process.env.HOPPSCOTCH_ACCESS_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.HOPPSCOTCH_ACCESS_TOKEN;
    } else {
      process.env.HOPPSCOTCH_ACCESS_TOKEN = originalEnv;
    }
  });

  it('does NOT return the ambient HOPPSCOTCH_ACCESS_TOKEN when no explicit token is passed', async () => {
    // The exact bug this guards against: `accessToken ?? process.env.X`
    // let a host process's ambient token cross into an embedder that omitted a
    // token (and get sent to the embedder's chosen API URL). With the fix, an
    // omitted token routes to device-login and NEVER returns the env value.
    //
    // Novel apiUrl => no disk-cache match (independent of the developer's real
    // ~/.config token); `open` is mocked => no browser. With the fix, the
    // omitted-token call either stays pending (TIMED_OUT, on a machine with a
    // browser) or rejects fast (ERRORED, headless/CI); both are safe, neither
    // returns a token. If the bug is reintroduced, step 1 of getValidToken
    // resolves IMMEDIATELY with the ambient token (before the headless check),
    // so the race settles `RESOLVED:jwt-AMBIENT...` in EVERY environment and the
    // assertion below fails. (The callback server/timer are unref'd, so a pending
    // flow does not keep the test process alive.)
    process.env.HOPPSCOTCH_ACCESS_TOKEN = 'jwt-AMBIENT-must-not-cross';

    const winner = await Promise.race([
      getValidToken('https://leak-guard.invalid', 'https://leak-guard.invalid/backend', 'selfhost')
        .then((t) => `RESOLVED:${t}`)
        .catch(() => 'ERRORED'),
      new Promise<string>((resolve) => setTimeout(() => resolve('TIMED_OUT'), 500)),
    ]);

    // Assert the SECURITY PROPERTY (never returns the ambient token), not the
    // mechanism (TIMED_OUT). TIMED_OUT and ERRORED both prove no leak; only a
    // reintroduced env fallback yields `RESOLVED:jwt-AMBIENT...`. This keeps the
    // guard valid in CI, where CI=true forces the headless-reject path (ERRORED);
    // asserting toBe('TIMED_OUT') there would false-fail with the fix intact.
    expect(winner).not.toMatch(/^RESOLVED:/);
    expect(winner).not.toContain('jwt-AMBIENT-must-not-cross');
  });
});

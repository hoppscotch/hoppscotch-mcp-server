import { describe, it, expect, vi } from 'vitest';
import { ToolHandlers } from './handlers.js';

/** Build handlers with a stub client; reauth touches nothing else. */
function makeHandlers(client: {
  hasStaticAccessToken: () => boolean;
  reauthenticate: () => Promise<string>;
}) {
  return new ToolHandlers({} as never, {} as never, {} as never, {} as never, client as never);
}

type ReauthResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('reauth handler', () => {
  it('always performs the cleanup/re-auth call and reports the static token as kept', async () => {
    const reauthenticate = vi.fn(async () => 'static-token');
    const handlers = makeHandlers({ hasStaticAccessToken: () => true, reauthenticate });

    const res = (await handlers.reauth({})) as ReauthResult;

    expect(reauthenticate).toHaveBeenCalledTimes(1); // cleanup must run in this branch too
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('HOPPSCOTCH_ACCESS_TOKEN');
    expect(res.content[0].text).not.toContain('fresh Hoppscotch session');
  });

  it('reports a fresh session on success without a static token', async () => {
    const reauthenticate = vi.fn(async () => 'tok');
    const handlers = makeHandlers({ hasStaticAccessToken: () => false, reauthenticate });

    const res = (await handlers.reauth({})) as ReauthResult;

    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('fresh Hoppscotch session');
  });

  it('preserves caller-safe pending-login guidance as normal content, not as an error', async () => {
    const msg =
      'Hoppscotch login is not finished yet. Open this URL in a browser and sign in:\n' +
      '  https://example.test/login\n' +
      'The login stays active for ~5 minutes. Finish signing in, then retry the original ' +
      'Hoppscotch operation (or invoke another regular Hoppscotch tool); it will pick up the ' +
      'token automatically. Do not call `reauth` again while this login is active because ' +
      'that would abandon it and start over.';
    const handlers = makeHandlers({
      hasStaticAccessToken: () => false,
      reauthenticate: async () => {
        throw new Error(msg);
      },
    });

    const res = (await handlers.reauth({})) as ReauthResult;

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(msg);
    expect(res.content[0].text).toContain('original Hoppscotch operation');
    expect(res.content[0].text).not.toMatch(/run the tool again/i);
  });

  it('returns hard failures as tool errors, never as successes', async () => {
    const handlers = makeHandlers({
      hasStaticAccessToken: () => false,
      reauthenticate: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:443');
      },
    });

    const res = (await handlers.reauth({})) as ReauthResult;

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Re-authentication failed');
    expect(res.content[0].text).not.toContain('successfully');
  });
});

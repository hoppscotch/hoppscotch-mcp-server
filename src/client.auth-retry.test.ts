import { describe, it, expect, vi, beforeEach } from 'vitest';

// Coverage for the auth/fail recovery branch of HoppscotchClient.graphql().
//
// This path was previously reachable only through the live-API integration test,
// which is skipped unless HOPPSCOTCH_INTEGRATION=1 — so on CI it had no coverage
// at all, despite being the behaviour the release notes describe ("mutations are
// not retried on network errors; an expired-token failure still re-issues the
// request once, after re-authenticating"). Everything here is hermetic: the auth
// module and the GraphQL transport are both mocked, so it runs anywhere.
const { requestSpy, clearStoredAuthSpy } = vi.hoisted(() => ({
  requestSpy: vi.fn(),
  clearStoredAuthSpy: vi.fn(),
}));

vi.mock('./auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth.js')>();
  return {
    ...actual,
    getValidToken: vi.fn(async () => 'jwt-mock'),
    reauthenticate: vi.fn(async () => 'jwt-mock'),
    clearStoredAuth: clearStoredAuthSpy,
  };
});

vi.mock('graphql-request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('graphql-request')>();
  class MockGraphQLClient {
    request(...args: unknown[]) {
      return requestSpy(...args);
    }
  }
  return { ...actual, GraphQLClient: MockGraphQLClient };
});

import { HoppscotchClient } from './client.js';
import { ApiType } from './config.js';

const base = {
  serverUrl: 'https://sh.example.com',
  apiUrl: 'https://sh.example.com/backend',
  apiType: ApiType.SELFHOST,
  timeout: 30000,
} as const;

const MUTATION = 'mutation CreateTeam($n: String!) { createTeam(name: $n) { id } }';

beforeEach(() => {
  requestSpy.mockReset();
  clearStoredAuthSpy.mockReset();
});

describe('HoppscotchClient.graphql — auth/fail recovery', () => {
  it('clears stored auth and re-issues a mutation EXACTLY once', async () => {
    requestSpy
      .mockRejectedValueOnce(new Error('auth/fail'))
      .mockResolvedValueOnce({ createTeam: { id: 't1' } });

    const client = new HoppscotchClient({ ...base });
    await expect(client.graphql(MUTATION, { n: 'x' })).resolves.toEqual({
      createTeam: { id: 't1' },
    });

    // Exactly two attempts: the original, plus the single post-reauth re-issue.
    // A third would mean the backoff path also fired on a mutation.
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(clearStoredAuthSpy).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a second auth/fail — the re-issue is not itself retried', async () => {
    requestSpy.mockRejectedValue(new Error('auth/fail'));

    const client = new HoppscotchClient({ ...base });
    await expect(client.graphql(MUTATION, { n: 'x' })).rejects.toThrow(/auth\/fail/);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a PAT with a specific error instead of re-issuing', async () => {
    requestSpy.mockRejectedValue(new Error('auth/fail'));

    const client = new HoppscotchClient({ ...base, accessToken: 'pat-abc123' });
    await expect(client.graphql(MUTATION, { n: 'x' })).rejects.toMatchObject({
      code: 'AUTH_PAT_INVALID',
    });

    // No re-issue and no cache clear: retrying a PAT would fail identically, and
    // clearing would discard a working device-login session.
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(clearStoredAuthSpy).not.toHaveBeenCalled();
  });

  it('propagates a non-auth mutation error without re-issuing', async () => {
    requestSpy.mockRejectedValue(new Error('team/member_not_found'));

    const client = new HoppscotchClient({ ...base });
    await expect(client.graphql(MUTATION, { n: 'x' })).rejects.toThrow();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(clearStoredAuthSpy).not.toHaveBeenCalled();
  });
});

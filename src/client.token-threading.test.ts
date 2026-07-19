import { describe, it, expect, vi } from 'vitest';

// Wiring guard for the credential-leak fix. Removing getValidToken's
// `?? process.env.HOPPSCOTCH_ACCESS_TOKEN` fallback made the
// config.accessToken -> getValidToken/reauthenticate 4th-argument threading the
// ONLY env-token path. A refactor that drops or renames that argument would
// still compile and pass every other unit test, yet silently send
// token-configured users through the device-login flow. These tests mock the
// auth module and assert HoppscotchClient forwards config.accessToken in the
// exact (serverUrl, apiUrl, apiType, accessToken) shape on both the request
// path (resolveToken) and the explicit reauth path.
vi.mock('./auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth.js')>();
  return {
    ...actual,
    getValidToken: vi.fn(async () => 'jwt-mock'),
    reauthenticate: vi.fn(async () => 'jwt-mock'),
  };
});

// Keep the request path off the network: the GraphQLClient is a no-op that
// resolves an empty result, so graphql() reaches resolveToken() (the thing
// under test) without an HTTP call.
vi.mock('graphql-request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('graphql-request')>();
  // A constructable no-op client — `new GraphQLClient(...)` needs a class/function,
  // not an arrow (arrows can't be constructors). request() resolves empty so the
  // graphql() path reaches resolveToken() without an HTTP call.
  class MockGraphQLClient {
    async request() {
      return {};
    }
  }
  return { ...actual, GraphQLClient: MockGraphQLClient };
});

import * as auth from './auth.js';
import { HoppscotchClient } from './client.js';
import { ApiType } from './config.js';

describe('HoppscotchClient — config.accessToken threading', () => {
  const base = {
    serverUrl: 'https://sh.example.com',
    apiUrl: 'https://sh.example.com/backend',
    apiType: ApiType.SELFHOST,
    timeout: 30000,
  } as const;

  it('forwards config.accessToken to getValidToken on the request path', async () => {
    const client = new HoppscotchClient({ ...base, accessToken: 'cfg-token' });
    await client.graphql('query { __typename }');
    expect(auth.getValidToken).toHaveBeenCalledWith(
      base.serverUrl,
      base.apiUrl,
      base.apiType,
      'cfg-token'
    );
  });

  it('forwards config.accessToken to reauthenticate', async () => {
    const client = new HoppscotchClient({ ...base, accessToken: 'cfg-token' });
    await client.reauthenticate();
    expect(auth.reauthenticate).toHaveBeenCalledWith(
      base.serverUrl,
      base.apiUrl,
      base.apiType,
      'cfg-token'
    );
  });
});

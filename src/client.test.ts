import { describe, it, expect, beforeEach } from 'vitest';
import { ClientError } from 'graphql-request';
import { HoppscotchClient, translateBackendError, sanitizeGraphQLError } from './client';
import type { Config } from './config';
import { HoppscotchError } from './types';

// A realistic secret value that would ride inside an environment-mutation's
// GraphQL variables. If sanitizeGraphQLError ever regresses to echoing
// ClientError.message, this sentinel leaks into the returned message and the
// tests below fail — that is the whole point of them.
const SECRET = 'sk-SENTINEL-do-not-leak-9Z';

/** Build a graphql-request ClientError shaped exactly as a real failed
 *  updateUserEnvironment call would produce, with the secret in `variables`. */
function clientErrorWith(opts: {
  status: number;
  errors?: Array<{ message: string }>;
}): ClientError {
  return new ClientError(
    { status: opts.status, headers: {} as never, ...(opts.errors ? { errors: opts.errors } : {}) } as never,
    {
      query: 'mutation UpdateUserEnvironment($id: ID!, $variables: String!) { ... }',
      variables: {
        id: 'env-1',
        variables: JSON.stringify([{ key: 'API_KEY', value: SECRET, secret: true }]),
      },
    }
  );
}

describe('HoppscotchClient', () => {
  let config: Config;

  beforeEach(() => {
    config = {
      serverUrl: 'https://hoppscotch.io',
      apiUrl: 'https://api.hoppscotch.io',
      accessToken: 'test-token-123',
      apiType: 'cloud' as const,
      timeout: 30000,
      maxResults: 25,
      graphqlEndpoint: '/graphql',
      restEndpoint: '/v1',
      verifySsl: true,
    };
  });

  describe('initialization', () => {
    it('should create client with valid config', () => {
      const client = new HoppscotchClient(config);
      expect(client).toBeDefined();
      expect(client.getConfig()).toEqual(config);
    });

    it('should store configuration', () => {
      const client = new HoppscotchClient(config);
      const storedConfig = client.getConfig();

      expect(storedConfig.serverUrl).toBe('https://hoppscotch.io');
      expect(storedConfig.apiUrl).toBe('https://api.hoppscotch.io');
      expect(storedConfig.accessToken).toBe('test-token-123');
      expect(storedConfig.timeout).toBe(30000);
    });
  });

  describe('error handling', () => {
    it('should create HoppscotchError with message', () => {
      const error = new HoppscotchError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('HoppscotchError');
    });

    it('should create HoppscotchError with code', () => {
      const error = new HoppscotchError('Test error', 'TEST_CODE');
      expect(error.code).toBe('TEST_CODE');
    });

    it('should create HoppscotchError with status code', () => {
      const error = new HoppscotchError('Test error', 'TEST_CODE', 404);
      expect(error.statusCode).toBe(404);
    });
  });

  describe('translateBackendError', () => {
    it('translates a known slash-code to a sentence and preserves the EXACT backend code', () => {
      // The full backend token carries a `bug/` prefix that e2e matchers depend on.
      const out = translateBackendError('bug/team/no_require_team_role');
      expect(out).toMatch(/unavailable on this backend/i);
      expect(out).toContain('(bug/team/no_require_team_role)');
    });

    it('translates a code embedded in a longer backend message', () => {
      const out = translateBackendError('Error: team_invite/member_has_invite');
      expect(out).toMatch(/already has a pending invitation/i);
      expect(out).toContain('(team_invite/member_has_invite)');
    });

    it('passes unknown messages through unchanged', () => {
      expect(translateBackendError('some/unmapped_error')).toBe('some/unmapped_error');
      expect(translateBackendError('a plain message')).toBe('a plain message');
    });
  });

  describe('sanitizeGraphQLError — credential-leak guard', () => {
    it('does NOT echo secret variables from a ClientError with no errors array (HTTP-status only)', () => {
      // A non-2xx with a non-GraphQL body (proxy/LB HTML 500). graphql-request's
      // ClientError.message serializes the request incl. variables → the secret.
      const out = sanitizeGraphQLError(clientErrorWith({ status: 500 }));
      expect(out).toBeInstanceOf(HoppscotchError);
      expect(out.code).toBe('GRAPHQL_REQUEST_ERROR');
      expect(out.message).not.toContain(SECRET); // the revert-guard
      expect(out.message).toContain('HTTP 500');
    });

    it('surfaces backend error messages but never the variables when errors[] is present', () => {
      const out = sanitizeGraphQLError(
        clientErrorWith({ status: 400, errors: [{ message: 'bug/team/no_require_team_role' }] })
      );
      expect(out.code).toBe('GRAPHQL_ERROR');
      expect(out.message).not.toContain(SECRET);
      expect(out.message).toContain('bug/team/no_require_team_role'); // translateBackendError preserves the code
    });

    it('preserves auth/fail in the message (so token-refresh detection still fires) without leaking the secret', () => {
      const out = sanitizeGraphQLError(
        clientErrorWith({ status: 200, errors: [{ message: 'auth/fail' }] })
      );
      expect(out.message).toContain('auth/fail');
      expect(out.message).not.toContain(SECRET);
    });

    it('blocks any request-bearing error structurally, even if not an instanceof ClientError', () => {
      // Defense in depth: a duck-typed error carrying `.request` (thus a
      // variable-laden message) must also be blocked.
      const e = new Error(`boom ${SECRET} in serialized request`) as Error & {
        request?: unknown;
        response?: { status?: number };
      };
      e.request = { query: 'q', variables: { secret: SECRET } };
      e.response = { status: 502 };
      const out = sanitizeGraphQLError(e);
      expect(out.message).not.toContain(SECRET);
      expect(out.message).toContain('HTTP 502');
    });

    it('passes through a genuine network error message (no request serialization to leak)', () => {
      const out = sanitizeGraphQLError(new Error('fetch failed: ECONNREFUSED'));
      expect(out.code).toBe('GRAPHQL_REQUEST_ERROR');
      expect(out.message).toContain('fetch failed: ECONNREFUSED');
    });

    it('handles non-Error throwables', () => {
      expect(sanitizeGraphQLError('weird').message).toBe('Unknown GraphQL error');
    });
  });

  // Integration tests — only run when HOPPSCOTCH_INTEGRATION=1 is explicitly set
  // (avoids failures from expired tokens in .env during regular unit test runs)
  describe.skipIf(!process.env.HOPPSCOTCH_INTEGRATION)('GraphQL integration', () => {
    it('should execute GraphQL query against real API', async () => {
      const realConfig: Config = {
        serverUrl: process.env.HOPPSCOTCH_SERVER_URL || 'https://hoppscotch.io',
        apiUrl: 'https://api.hoppscotch.io',
        accessToken: process.env.HOPPSCOTCH_ACCESS_TOKEN!,
        apiType: 'cloud' as const,
        timeout: 30000,
      };

      const client = new HoppscotchClient(realConfig);

      // Use a query that exists on both Cloud and SH backends
      const query = `
        query {
          myTeams {
            id
            name
          }
        }
      `;

      const result = await client.graphql(query);
      expect(result).toBeDefined();
    });
  });
});

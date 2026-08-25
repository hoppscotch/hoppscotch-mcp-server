import { GraphQLClient, ClientError } from 'graphql-request';
import type { Config } from './config.js';
import { getGraphqlUrl } from './config.js';
import { HoppscotchError } from './types.js';
import { retryWithBackoff } from './utils/retry.js';
import { getValidToken, clearStoredAuth, reauthenticate } from './auth.js';

/**
 * Known Hoppscotch backend error codes (slash-namespaced) → human-readable
 * explanations. The backend surfaces terse codes like `team/no_require_team_role`;
 * translating them gives the model an actionable sentence. The original code is
 * always preserved in parentheses, so anything matching on the raw code keeps
 * working. Unknown codes pass through unchanged.
 */
const BACKEND_ERROR_MESSAGES: Record<string, string> = {
  'auth/fail': 'Authentication failed or the session expired. Run the `reauth` tool (or retry to trigger sign-in) and try again.',
  // Full backend token is `bug/team/no_require_team_role`, so key on the exact
  // code so the prefix is preserved in the output (matchers depend on it).
  'bug/team/no_require_team_role': 'This operation is unavailable on this backend (the required team-role guard is not configured server-side). Known Cloud limitation for search_team_requests.',
  'team_invite/member_has_invite': 'That user already has a pending invitation to this team.',
  'email/failed': 'The invitation could not be sent — the email is not a registered Hoppscotch account (Cloud requires invitees to already have an account).',
};

/**
 * Translate a backend error message: if it equals or contains a known slash-code,
 * return "<human sentence> (<code>)"; otherwise return it unchanged.
 */
export function translateBackendError(message: string): string {
  for (const [code, human] of Object.entries(BACKEND_ERROR_MESSAGES)) {
    if (message === code || message.includes(code)) {
      return `${human} (${code})`;
    }
  }
  return message;
}

/**
 * Convert a thrown GraphQL/network error into a HoppscotchError whose message is
 * SAFE to surface to the MCP client.
 *
 * SECURITY: graphql-request's `ClientError.message` serializes the ENTIRE request,
 * query AND `variables`, into its string. Environment mutations carry
 * secret-marked values in those variables, so echoing `ClientError.message` (or
 * any object with a `.request`) would leak them to the model/transcript. We
 * surface only the backend error messages (which are already destined for the
 * client) and the HTTP status, and NEVER interpolate a request-bearing message.
 * Genuine non-request failures (network/DNS/timeout) carry no request
 * serialization, so their `.message` is safe to pass through.
 */
export function sanitizeGraphQLError(error: unknown): HoppscotchError {
  if (error instanceof Error) {
    const e = error as {
      response?: { status?: number; errors?: Array<{ message: string }> };
      request?: unknown;
    };

    // A GraphQL response carrying a typed `errors` array: surface only the
    // backend error messages (safe, already meant for the caller).
    if (e.response?.errors && e.response.errors.length > 0) {
      const messages = e.response.errors.map((x) => translateBackendError(x.message)).join(', ');
      return new HoppscotchError(`GraphQL error: ${messages}`, 'GRAPHQL_ERROR');
    }

    // Request-bearing error (graphql-request ClientError, by class OR by the
    // structural `.request` guard): its `.message` embeds query+variables and
    // must never be echoed. Report the HTTP status only.
    if (error instanceof ClientError || 'request' in e) {
      const status = e.response?.status;
      return new HoppscotchError(
        `GraphQL request failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}`,
        'GRAPHQL_REQUEST_ERROR'
      );
    }

    // Plain network/DNS/timeout error: message carries no request serialization.
    return new HoppscotchError(`GraphQL request failed: ${error.message}`, 'GRAPHQL_REQUEST_ERROR');
  }

  return new HoppscotchError('Unknown GraphQL error', 'UNKNOWN_ERROR');
}

/**
 * Client for interacting with Hoppscotch API (GraphQL + REST)
 */
export class HoppscotchClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Resolve a valid Bearer token.
   *
   * If an access token was configured (config.accessToken, which the CLI populates
   * from HOPPSCOTCH_ACCESS_TOKEN via loadConfig; an embedder sets it directly),
   * it is used as-is. Otherwise the device-login browser flow is triggered and
   * the resulting token is cached on disk for subsequent calls.
   */
  private async resolveToken(): Promise<string> {
    return getValidToken(
      this.config.serverUrl,
      this.config.apiUrl,
      this.config.apiType,
      this.config.accessToken
    );
  }

  /**
   * Build HTTP headers with a freshly resolved token.
   */
  private async getHeaders(): Promise<Record<string, string>> {
    const token = await this.resolveToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Execute a single GraphQL request (no retry).
   */
  private async graphqlOnce<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const headers = await this.getHeaders();
    const graphqlClient = new GraphQLClient(getGraphqlUrl(this.config), { headers });
    try {
      return await graphqlClient.request<T>(query, variables);
    } catch (error) {
      throw sanitizeGraphQLError(error);
    }
  }

  /**
   * Execute GraphQL query or mutation.
   *
   * Queries are retried with exponential backoff on transient network errors.
   * Mutations run exactly once: a lost response after a server-side commit must
   * not be replayed (duplicate teams/requests/invites). Detection is reliable
   * because every mutation in this codebase is a named `mutation <Name>(...)`
   * document; anonymous mutations are never sent.
   *
   * auth/fail (expired or revoked token) is not retried by the backoff path; it
   * is surfaced as a clear error. It is thrown before the resolver runs (no
   * commit), so the single auth/fail re-attempt below is safe even for mutations.
   * The next call to getValidToken() will see no valid stored token and trigger
   * the login flow automatically.
   */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const isMutation = /^\s*(?:#[^\n]*\n\s*)*mutation\b/.test(query);
    const runOnce = () => this.graphqlOnce<T>(query, variables);
    try {
      return await (isMutation ? runOnce() : retryWithBackoff(runOnce));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.message.includes('auth/fail')) {
        // If a PAT was configured, surface a clear explanation instead of
        // silently retrying (PATs don't work with GQL, only JWTs do). The token
        // comes from config only; the CLI populates it from the env var via
        // loadConfig, so we never read the env directly here.
        const staticToken = this.config.accessToken;
        if (staticToken?.startsWith('pat-')) {
          throw new HoppscotchError(
            'Authentication failed. The configured access token looks like a Personal Access Token (pat-...), ' +
            'which only works with Hoppscotch REST API endpoints, not GraphQL queries. ' +
            'Use device-login instead (unset the token), or copy the JWT from ~/.config/hoppscotch-mcp/auth.json.',
            'AUTH_PAT_INVALID'
          );
        }
        // Token expired, so clear caches so the next getValidToken() call
        // triggers re-login (one browser window, shared across all callers).
        clearStoredAuth();
        // Re-authenticate and retry the request once.
        return this.graphqlOnce<T>(query, variables);
      }
      throw err;
    }
  }

  /**
   * Force a fresh device-login, bypassing the in-memory and on-disk token
   * caches and abandoning any in-flight login flow. Backs the `reauth` tool.
   */
  async reauthenticate(): Promise<string> {
    return reauthenticate(
      this.config.serverUrl,
      this.config.apiUrl,
      this.config.apiType,
      this.config.accessToken
    );
  }

  /**
   * Get current configuration
   */
  getConfig(): Config {
    return this.config;
  }
}

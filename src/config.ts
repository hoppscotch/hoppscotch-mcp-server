import { z } from 'zod';

// NOTE: `.env` loading is intentionally NOT done here, because importing this module
// must stay side-effect-free (no `.env` read), so the process's `.env` boundary
// lives solely in the CLI entry (src/index.ts), which calls `dotenv.config()`
// before `loadConfig()`.

/** Cloud frontend origin, used as the default server URL and for the login page */
const CLOUD_SERVER_URL = 'https://hoppscotch.io';
/** Cloud backend API origin */
const CLOUD_API_URL = 'https://api.hoppscotch.io';
/** Default page size for list tools when the caller passes no explicit limit. */
export const DEFAULT_MAX_RESULTS = 25;

/**
 * API deployment types, inferred from the server URL and not configured explicitly.
 */
export enum ApiType {
  CLOUD = 'cloud',
  SELFHOST = 'selfhost',
}

/**
 * Derive the API base URL from the server URL.
 *
 * Cloud:      serverUrl = https://hoppscotch.io (or www.) → apiUrl = https://api.hoppscotch.io
 * Self-hosted: serverUrl = https://your-sh.example.com   → apiUrl = https://your-sh.example.com/backend
 *
 * Self-hosted Hoppscotch uses nginx to route `/backend` to the NestJS backend service.
 * Deployments where frontend and backend live on different domains can set
 * HOPPSCOTCH_API_URL to bypass this derivation entirely.
 */
export function deriveApiUrl(serverUrl: string, explicitApiUrl?: string): string {
  if (explicitApiUrl) return explicitApiUrl;
  if (isCloudUrl(serverUrl)) return CLOUD_API_URL;
  // Build via the URL API (not string concatenation) so a query string or
  // fragment can never corrupt the derived path. serverUrl is validated by
  // assertValidServerUrl before this runs, so new URL() will not throw here.
  const url = new URL(serverUrl);
  url.pathname = url.pathname.replace(/\/+$/, '') + '/backend';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Infer whether a server URL refers to Hoppscotch Cloud.
 */
export function isCloudUrl(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    return url.hostname === 'hoppscotch.io' || url.hostname === 'www.hoppscotch.io';
  } catch {
    return false;
  }
}

/**
 * Infer the API type from the server URL.
 */
export function inferApiType(serverUrl: string): ApiType {
  return isCloudUrl(serverUrl) ? ApiType.CLOUD : ApiType.SELFHOST;
}

/**
 * Validate a user-supplied server URL. Rejects non-http(s) schemes, embedded
 * credentials, query strings, and fragments, each of which could corrupt the
 * derived apiUrl/graphqlUrl or smuggle data into the login/backend targets. A
 * path IS allowed (self-hosted instances may be served under a base path).
 * Throws a bare "<what is wrong>" message; loadConfig wraps it for display.
 */
export function assertValidServerUrl(serverUrl: string): void {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error(`must be a valid URL (got "${serverUrl}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`must use http or https (got "${url.protocol}")`);
  }
  if (url.username || url.password) {
    throw new Error('must not contain embedded credentials');
  }
  if (url.search) {
    throw new Error('must not contain a query string');
  }
  if (url.hash) {
    throw new Error('must not contain a fragment');
  }
}

/**
 * Configuration schema validation.
 *
 * HOPPSCOTCH_SERVER_URL: the Hoppscotch frontend URL.
 *   Cloud (default): https://hoppscotch.io
 *   Self-hosted:     https://your-sh.example.com  (the nginx-served frontend)
 *
 * HOPPSCOTCH_API_URL: optional explicit backend API URL. When set, overrides the
 *   default derivation (serverUrl + /backend). Use this when frontend and backend
 *   are served on different domains (e.g. separate Cloud Run services).
 *
 * HOPPSCOTCH_ACCESS_TOKEN: optional JWT to skip browser login. A `pat-…` PAT
 * does NOT work here (PATs are REST-only; the GraphQL API requires a JWT).
 */
const configSchema = z.object({
  serverUrl: z.string().url('HOPPSCOTCH_SERVER_URL must be a valid URL').default(CLOUD_SERVER_URL),

  // Derived from serverUrl, not exposed as env vars
  apiUrl: z.string(),
  apiType: z.nativeEnum(ApiType),

  // Optional; if omitted the server will open a browser window for login
  accessToken: z.string().min(1).optional(),

  // Optional with defaults
  defaultTeamId: z.string().optional(),
  timeout: z.number().positive().default(30000),

  // Tool surface to expose: minimal | core (default) | standard | full. Optional
  // so embedders can select it via Config; the CLI populates it from
  // HOPPSCOTCH_TOOL_PROFILE. An unset/unknown value resolves to `core`.
  toolProfile: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Load and validate configuration from environment variables.
 */
export function loadConfig(): Config {
  const serverUrl = process.env.HOPPSCOTCH_SERVER_URL ?? CLOUD_SERVER_URL;

  // Validate serverUrl BEFORE deriving apiUrl/apiType from it: derivation must
  // never run on an unvalidated URL. Wrapped so it surfaces through the same
  // "Configuration validation failed" channel as the schema errors below.
  try {
    assertValidServerUrl(serverUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration validation failed:\n  - serverUrl: ${message}`);
  }

  const explicitApiUrl = process.env.HOPPSCOTCH_API_URL?.trim() || undefined;
  if (explicitApiUrl) {
    try {
      assertValidServerUrl(explicitApiUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Configuration validation failed:\n  - HOPPSCOTCH_API_URL: ${message}`);
    }
  }

  const rawConfig = {
    serverUrl,
    apiUrl: deriveApiUrl(serverUrl, explicitApiUrl),
    apiType: inferApiType(serverUrl),
    accessToken: process.env.HOPPSCOTCH_ACCESS_TOKEN,
    defaultTeamId: process.env.HOPPSCOTCH_DEFAULT_TEAM_ID,
    timeout: process.env.HOPPSCOTCH_TIMEOUT
      ? parseInt(process.env.HOPPSCOTCH_TIMEOUT, 10)
      : undefined,
    toolProfile: process.env.HOPPSCOTCH_TOOL_PROFILE,
  };

  try {
    return configSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`).join('\n');
      throw new Error(`Configuration validation failed:\n${errors}`);
    }
    throw error;
  }
}

/**
 * Get full GraphQL endpoint URL
 */
export function getGraphqlUrl(config: Config): string {
  return `${config.apiUrl}/graphql`;
}

/**
 * Environment variables that must be set by the OPERATOR (in the real process
 * environment), never introduced by a working-directory `.env` file. A hostile
 * repo `.env` setting these could disable the SSRF guard, widen the exposed tool
 * surface, or allowlist a secret-exfiltration origin. index.ts snapshots their
 * ambient values before dotenv runs, then calls sanitizeTrustSensitiveEnv to
 * strip any that dotenv introduced.
 */
export const TRUST_SENSITIVE_ENV_KEYS = [
  'HOPPSCOTCH_ALLOW_PRIVATE_HOSTS',
  'HOPPSCOTCH_TOOL_PROFILE',
  'HOPPSCOTCH_SECRET_ALLOWED_ORIGINS',
  // The auth TARGET and the auth CREDENTIAL. A working-dir .env must never be
  // able to repoint the backend (and thus where the Bearer token is sent) or
  // inject an access token. Stripping these fails safe: serverUrl falls back to
  // the Cloud default, and an absent token triggers device-login.
  'HOPPSCOTCH_SERVER_URL',
  'HOPPSCOTCH_API_URL',
  'HOPPSCOTCH_ACCESS_TOKEN',
  // A hostile .env defaulting the team could redirect omitted-team writes into an
  // attacker's workspace; an enormous response cap re-enables memory exhaustion;
  // an enormous timeout turns a request into a long process-tying hang.
  'HOPPSCOTCH_DEFAULT_TEAM_ID',
  'HOPPSCOTCH_MAX_RESPONSE_BYTES',
  'HOPPSCOTCH_TIMEOUT',
  // Auth-behaviour knobs read directly in auth.ts. A .env must not be able to
  // stall the login prompt (AUTH_TIMEOUT_MS) or force a browser login / callback
  // server up in a headless context that the safety check would otherwise refuse
  // (FORCE_BROWSER_LOGIN).
  'HOPPSCOTCH_AUTH_TIMEOUT_MS',
  'HOPPSCOTCH_FORCE_BROWSER_LOGIN',
  // The Cloud Firebase Web API key. A working-directory .env must not be able to
  // repoint the Firebase token exchange at an attacker-controlled project.
  // Stripping it fails safe: the build-time baked key is used instead.
  'HOPPSCOTCH_FIREBASE_API_KEY',
] as const;

/**
 * Delete any trust-sensitive var that was ABSENT from the ambient (pre-dotenv)
 * environment but is present now, i.e. introduced by a `.env` file. Returns the
 * keys that were stripped. `ambient` is a snapshot of the trust-sensitive keys
 * from process.env captured BEFORE dotenv.config() ran. dotenv does not override
 * an already-set real-env var, so an operator-set value is preserved; only a
 * dotfile-introduced value is removed.
 */
export function sanitizeTrustSensitiveEnv(
  ambient: Partial<Record<string, string | undefined>>,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const stripped: string[] = [];
  for (const key of TRUST_SENSITIVE_ENV_KEYS) {
    if (ambient[key] === undefined && env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

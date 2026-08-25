import http from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { chmodSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import open from 'open';
import type { ApiType } from './config.js';

const AUTH_DIR = join(homedir(), '.config', 'hoppscotch-mcp');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');

/** Token lifetime buffer: treat a token as expired 60s before its real expiry. */
const EXPIRY_BUFFER_MS = 60_000;
/**
 * How long a single tool call BLOCKS waiting for the user to finish browser
 * login before it returns a "login still pending" result (with the URL). Kept
 * short so an agent isn't stuck on one opaque call; the callback server outlives
 * it (CALLBACK_TTL_MS) so a slower login still completes and caches the token
 * for the next call. Override with HOPPSCOTCH_AUTH_TIMEOUT_MS (milliseconds).
 */
const DEFAULT_LOGIN_PROMPT_TIMEOUT_MS = 60_000;
/**
 * How long the local callback server stays alive to capture a (possibly late)
 * login, independent of the per-call prompt timeout. A login that finishes after
 * the prompt timeout still stores + caches the token, so the caller's next
 * attempt succeeds from cache.
 */
const CALLBACK_TTL_MS = 5 * 60 * 1000;

function loginPromptTimeoutMs(): number {
  const raw = Number(process.env.HOPPSCOTCH_AUTH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOGIN_PROMPT_TIMEOUT_MS;
}
/** Fallback TTL when the JWT has no exp claim (self-hosted long-lived tokens) */
const FALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Build-time-injected Firebase Web API key (see tsup.config.ts `define`). The
 * value is read from the RELEASE machine's HOPPSCOTCH_FIREBASE_API_KEY and baked
 * into the published bundle, so end users need no configuration. It is absent in
 * a plain source checkout and under vitest (which does not apply tsup defines),
 * hence the `typeof` guard at the use site.
 */
declare const __FIREBASE_WEB_API_KEY__: string | undefined;

/**
 * Firebase Web API key for hoppscotch.io (Cloud), used to exchange Firebase
 * custom tokens → ID tokens and to refresh ID tokens. Cloud-only: self-hosted
 * instances never reach these paths.
 *
 * Resolution order:
 *   1. HOPPSCOTCH_FIREBASE_API_KEY from the environment (operator override).
 *   2. The value baked in at build time.
 * Deliberately NOT hardcoded in source. Firebase web keys are public client
 * identifiers rather than secrets, but keeping the literal out of the repo means
 * the published value is controlled by whoever cuts the release, and rotating it
 * does not require a source change.
 */
function firebaseWebApiKey(): string {
  const fromEnv = process.env.HOPPSCOTCH_FIREBASE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const baked = typeof __FIREBASE_WEB_API_KEY__ === 'string' ? __FIREBASE_WEB_API_KEY__.trim() : '';
  if (baked) return baked;
  throw new Error(
    'Cloud sign-in is unavailable: no Firebase Web API key is configured. This build was ' +
      'produced without one baked in. Set HOPPSCOTCH_FIREBASE_API_KEY in the environment, or ' +
      'use a self-hosted instance via HOPPSCOTCH_SERVER_URL (which does not use Firebase).'
  );
}

/**
 * Extract the expiry timestamp from a JWT's `exp` claim (ms).
 * Falls back to FALLBACK_TOKEN_TTL_MS from now if the token is not a
 * standard JWT or has no exp claim (e.g. a PAT).
 */
function jwtExpiresAt(token: string): number {
  try {
    const payload = token.split('.')[1];
    if (!payload) return Date.now() + FALLBACK_TOKEN_TTL_MS;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    if (decoded.exp) return decoded.exp * 1000; // exp is in seconds
  } catch {
    // Ignore: non-JWT (e.g. PAT), use fallback
  }
  return Date.now() + FALLBACK_TOKEN_TTL_MS;
}

/**
 * Extract a stable account identity from a JWT (the `sub` claim, falling back to
 * `user_id` then `email`). Returns null for a non-JWT / opaque token (e.g. a PAT)
 * or a token with no identity claim. Callers treat null as "identity unknown"
 * and never hard-fail on it.
 */
export function jwtSubject(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string;
      user_id?: string;
      email?: string;
    };
    return decoded.sub ?? decoded.user_id ?? decoded.email ?? null;
  } catch {
    return null;
  }
}

/** Thrown when an on-disk / refreshed token's account differs from the pinned session identity. */
function identitySwitchError(): Error {
  return new Error(
    'Signed-in account changed: the token stored at ~/.config/hoppscotch-mcp/auth.json ' +
      'belongs to a different account than this session authenticated as. ' +
      'Run the `reauth` tool to switch accounts.'
  );
}

interface StoredAuth {
  accessToken: string;
  refreshToken: string | null;
  /** Unix timestamp (ms) when the access token expires */
  expiresAt: number;
  /** The API base URL this token was issued for (used to cache-bust on URL change) */
  apiUrl: string;
  apiType: ApiType;
  /**
   * Firebase refresh token (Cloud only).
   * Used to exchange for new Firebase ID tokens without a full browser login.
   * Different from refreshToken which is the Hoppscotch backend refresh token (SH only).
   */
  firebaseRefreshToken?: string;
  /**
   * Stable account identity (JWT sub/user_id/email) this token belongs to. Used
   * to refuse a silent mid-session account switch when another process overwrites
   * auth.json for the same apiUrl. Absent on legacy files and PATs, where a missing
   * subject is re-derived from the token on read and never hard-fails.
   */
  subject?: string | null;
}

// ---------------------------------------------------------------------------
// In-process token cache
//
// Prevents multiple concurrent tool calls from each spawning a browser login
// window. Once a login is in flight, all callers await the same Promise.
// The cache is also consulted before hitting the disk so sequential calls
// within the same process don't re-read auth.json on every request.
// ---------------------------------------------------------------------------

interface InMemoryCache {
  token: string;
  expiresAt: number;
  apiUrl: string;
  subject: string | null;
}

let memCache: InMemoryCache | null = null;

/**
 * The account identity this process first authenticated as, pinned on the first
 * token accepted. A later disk token (written by another process that logged in
 * as a different account on the same apiUrl) carrying a DIFFERENT known subject
 * is refused rather than silently served. The caller must `reauth` to switch.
 * null until pinned; only a both-known-and-different subject is a conflict, so
 * PAT/opaque tokens and legacy files never hard-fail.
 */
let sessionSubject: string | null = null;

/** Pin the active identity on first acquisition (no-op once pinned or if unknown). */
function pinSessionIdentity(subject: string | null): void {
  if (sessionSubject === null && subject !== null) {
    sessionSubject = subject;
  }
}

/**
 * A hard identity conflict. Once the session is pinned to a known identity, ANY
 * candidate that isn't exactly that identity, including an unidentifiable
 * (null-subject) token, is a conflict. Fails CLOSED: an opaque token cannot prove
 * it belongs to the pinned account, so it is refused rather than silently served.
 * (An unpinned session, sessionSubject === null, still accepts anything: the
 * first token is what pins the identity.)
 */
function identityConflicts(subject: string | null): boolean {
  return sessionSubject !== null && subject !== sessionSubject;
}

/**
 * A refreshed token must not change the effective account. It conflicts if it
 * disagrees with the pinned session identity, or, on an as-yet-unpinned fresh
 * start where `identityConflicts` alone is vacuous, with the identity the
 * stored token itself proved. This closes the case where a fresh process reads
 * an expired account-A token from disk and its refresh returns account B: without
 * the stored-subject arm, nothing is pinned yet, so B would be persisted and
 * adopted. Fails CLOSED: if the stored token proved A but the refresh yields an
 * unidentifiable (null-subject) token, that cannot prove it is still A, so refuse.
 */
function refreshIdentityConflicts(refreshedSubject: string | null, storedSubject: string | null): boolean {
  return (
    identityConflicts(refreshedSubject) ||
    (storedSubject !== null && refreshedSubject !== storedSubject)
  );
}

/**
 * A shared, in-flight browser-login flow. While one is active, all callers reuse
 * it (so only one browser window opens and the callback server binds once).
 * - `promise` resolves with the token on callback success; it rejects only on a
 *   hard error or when the callback server's TTL expires, NOT when an
 *   individual caller's prompt timeout fires.
 * - `urlSink.url` holds the login URL once the callback server has bound, so a
 *   caller whose prompt timeout fires can surface it.
 * Cleared (via .finally at the start site) once the flow settles, so a later
 * cache-miss can start a fresh login.
 */
interface PendingLogin {
  promise: Promise<string>;
  urlSink: { url: string | null };
  /**
   * Tear down the underlying flow now (close the callback listeners + cancel the
   * TTL timer, rejecting the flow). Used by `reauthenticate()` to abandon an
   * in-flight login and start fresh, so the old callback server doesn't linger
   * until its TTL and a late sign-in on the stale browser tab can't store a token
   * after the user explicitly re-authenticated.
   */
  abort: () => void;
}
let pendingLogin: PendingLogin | null = null;
let patWarningShown = false;

/**
 * Sinks for human-readable auth progress ("open this URL to sign in"). The MCP
 * server registers one per request that carries a progressToken. A Set rather
 * than a single global: concurrent tool calls each register their own reporter,
 * so a single global would let a second request overwrite the first's sink AND
 * let the first request's cleanup clear the second's. Each registrant removes
 * ONLY its own reporter (identity-checked) via the returned disposer, and
 * progress is broadcast to every current sink, which is right for one user driving
 * several agent surfaces. Best-effort and fully guarded: progress reporting must
 * never break or block the login itself.
 */
type AuthProgressReporter = (message: string) => void;
const authProgressReporters = new Set<AuthProgressReporter>();
export function addAuthProgressReporter(fn: AuthProgressReporter): () => void {
  authProgressReporters.add(fn);
  return () => {
    authProgressReporters.delete(fn);
  };
}
function reportAuthProgress(message: string): void {
  for (const fn of authProgressReporters) {
    try {
      fn(message);
    } catch {
      /* never let progress reporting break login */
    }
  }
}

function memCacheValid(apiUrl: string): boolean {
  return (
    memCache !== null &&
    memCache.apiUrl === apiUrl &&
    !identityConflicts(memCache.subject) &&
    Date.now() < memCache.expiresAt - EXPIRY_BUFFER_MS
  );
}

function setMemCache(token: string, expiresAt: number, apiUrl: string, subject: string | null): void {
  memCache = { token, expiresAt, apiUrl, subject };
  pinSessionIdentity(subject);
}

/**
 * Test-only: drop the in-process token cache WITHOUT unpinning the session
 * identity, so a test can force the disk re-read path (where the account-switch
 * guard lives) while the pinned identity is preserved. Not part of the public API.
 */
export function __dropMemCacheForTests(): void {
  memCache = null;
}

/** Test-only: unpin the session identity (production unpins only via reauthenticate). */
export function __resetSessionIdentityForTests(): void {
  sessionSubject = null;
}

/**
 * Return a valid access token.
 *
 * Priority:
 *  1. Explicit `accessToken` argument (from config.accessToken): used as-is, no
 *     refresh. The CLI populates this from HOPPSCOTCH_ACCESS_TOKEN via loadConfig;
 *     this function never reads the env var itself (so an ambient host token can't
 *     cross into an embedder that omitted a token).
 *  2. In-process memory cache: avoids disk reads and duplicate login flows.
 *  3. Stored token from a previous browser login: refreshed if close to expiry (both
 *     backends; the refresh mechanism differs, see the Cloud/Self-Hosted notes below).
 *  4. Browser-based device-login flow: opens the Hoppscotch frontend login page.
 *     If a login is already in progress, all callers await the same Promise.
 *
 * @param serverUrl  The Hoppscotch frontend URL (e.g. https://hoppscotch.io or https://your-sh.example.com).
 *                   The `/device-login` page is served here, not on the API backend.
 * @param apiUrl     The Hoppscotch backend API URL (e.g. https://api.hoppscotch.io).
 *                   Used for token refresh (SH only) and as the cache key.
 * @param apiType    Whether this is a cloud or self-hosted instance.
 *
 * Cloud note: Firebase ID tokens expire after ~1 hour. Token refresh uses the Firebase
 * securetoken API with the stored Firebase refresh token (no re-login needed).
 *
 * Self-Hosted note: JWTs are valid for 1 day; `/auth/refresh` accepts the refresh token
 * as a Bearer credential and returns a new token pair.
 */
export async function getValidToken(
  serverUrl: string,
  apiUrl: string,
  apiType: ApiType,
  accessToken?: string
): Promise<string> {
  // 1. Static token, supplied explicitly by the caller (config.accessToken).
  // This function does NOT read HOPPSCOTCH_ACCESS_TOKEN itself: the env var is
  // read ONLY at the CLI boundary (loadConfig), which threads it in here as
  // `accessToken`. Reading the env here as a fallback would let a host process's
  // ambient token cross into an embedder that deliberately omitted a token
  // (expecting device-login), sending that token to the embedder's chosen API
  // URL. Caller's responsibility to keep an explicit token valid.
  const staticToken = accessToken;
  if (staticToken) {
    const token = staticToken;
    if (token.startsWith('pat-') && !patWarningShown) {
      patWarningShown = true;
      process.stderr.write(
        '[MCP] Warning: the configured access token looks like a Personal Access Token (pat-...).\n' +
        '[MCP] PATs only work with Hoppscotch REST API endpoints, not GraphQL queries.\n' +
        '[MCP] This will likely cause auth/fail errors. Use device-login instead,\n' +
        '[MCP] or copy the JWT from ~/.config/hoppscotch-mcp/auth.json.\n'
      );
    }
    return token;
  }

  // 2. In-process memory cache: fast path for sequential calls.
  if (memCacheValid(apiUrl)) {
    return memCache!.token;
  }

  // 3. Disk-persisted token from a previous session.
  const stored = readStoredAuth();
  if (stored && stored.apiUrl === apiUrl) {
    // Refuse a silent account switch: if this session is already pinned to one
    // identity and the on-disk token belongs to a DIFFERENT known account (e.g.
    // another process logged in on the same apiUrl and overwrote auth.json), do
    // not serve it. The user must explicitly `reauth` to switch accounts.
    // Identity is derived from the TOKEN's own `sub` claim, never the co-located
    // `subject` field, which lives in the same attacker-writable file and
    // could be relabelled to impersonate the pinned account.
    const storedSubject = jwtSubject(stored.accessToken);
    if (identityConflicts(storedSubject)) {
      throw identitySwitchError();
    }
    if (Date.now() < stored.expiresAt - EXPIRY_BUFFER_MS) {
      setMemCache(stored.accessToken, stored.expiresAt, apiUrl, storedSubject);
      return stored.accessToken;
    }

    // Token is expired or close to expiry, so try to refresh. The refreshed token's
    // identity is re-checked OUTSIDE the try/catch: a refresh must never silently
    // change the effective account, and the catch (which falls back to browser
    // login) must not swallow that refusal.
    if (apiType === 'cloud' && stored.firebaseRefreshToken) {
      // Cloud: use Firebase refresh token to get a new ID token.
      let refreshed: { idToken: string; refreshToken: string | undefined } | null = null;
      try {
        const r = await refreshFirebaseToken(stored.firebaseRefreshToken);
        refreshed = { idToken: r.idToken, refreshToken: r.refreshToken };
      } catch (err) {
        process.stderr.write(`[MCP] Firebase token refresh failed, falling back to browser login: ${err instanceof Error ? err.message : err}\n`);
      }
      if (refreshed) {
        const refreshedSubject = jwtSubject(refreshed.idToken);
        if (refreshIdentityConflicts(refreshedSubject, storedSubject)) throw identitySwitchError();
        const expiresAt = jwtExpiresAt(refreshed.idToken);
        const subject = refreshedSubject ?? storedSubject;
        storeAuth({ ...stored, accessToken: refreshed.idToken, firebaseRefreshToken: refreshed.refreshToken, expiresAt, subject });
        setMemCache(refreshed.idToken, expiresAt, apiUrl, subject);
        return refreshed.idToken;
      }
    } else if (stored.refreshToken && apiType !== 'cloud') {
      // Self-hosted: use Hoppscotch backend refresh endpoint.
      let refreshed: { accessToken: string; refreshToken: string } | null = null;
      try {
        refreshed = await refreshAccessToken(apiUrl, stored.refreshToken);
      } catch (err) {
        process.stderr.write(`[MCP] Token refresh failed, falling back to browser login: ${err instanceof Error ? err.message : err}\n`);
      }
      if (refreshed) {
        const refreshedSubject = jwtSubject(refreshed.accessToken);
        // Identity-check BEFORE persisting: a refresh that returns a DIFFERENT
        // account must never be written to disk: an unpinned later start would
        // otherwise silently adopt it. The stored-subject arm also catches the
        // fresh-start case where nothing is pinned yet. (Mirrors the Cloud branch.)
        if (refreshIdentityConflicts(refreshedSubject, storedSubject)) throw identitySwitchError();
        const expiresAt = jwtExpiresAt(refreshed.accessToken);
        const subject = refreshedSubject ?? storedSubject;
        storeAuth({ ...stored, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresAt, subject });
        setMemCache(refreshed.accessToken, expiresAt, apiUrl, subject);
        return refreshed.accessToken;
      }
    }
  }

  // 4. Browser-based login. A single shared `pendingLogin` flow is reused by all
  // concurrent callers so the browser window opens once and the callback server
  // binds once. The per-call PROMPT timeout (default 60s; HOPPSCOTCH_AUTH_TIMEOUT_MS)
  // bounds how long THIS call blocks; the underlying flow + callback server stay
  // alive for CALLBACK_TTL_MS so a slow login still completes and caches the
  // token for the next call.
  if (!pendingLogin) {
    const urlSink: { url: string | null } = { url: null };
    const controller = new AbortController();
    const promise = runLoginFlow(serverUrl, apiUrl, apiType, urlSink, controller.signal).finally(() => {
      // Identity-checked: only clear if WE are still the active flow. A flow that
      // was abandoned (e.g. by reauthenticate starting a fresh one) must not null
      // out the newer pendingLogin when it finally settles.
      if (pendingLogin?.promise === promise) pendingLogin = null;
    });
    pendingLogin = { promise, urlSink, abort: () => controller.abort() };
  }

  return awaitLoginWithPromptTimeout(pendingLogin);
}

/**
 * Wait for the shared login flow, but only up to the per-call prompt timeout.
 * On timeout we reject with an actionable, URL-bearing message WITHOUT
 * cancelling the underlying flow. It keeps running (and caching the token on
 * success) so the caller's next attempt resolves from cache.
 */
function awaitLoginWithPromptTimeout(current: PendingLogin): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const url = current.urlSink.url;
      const mins = Math.round(CALLBACK_TTL_MS / 60_000);
      reject(
        new Error(
          'Hoppscotch login is not finished yet. ' +
            (url
              ? `Open this URL in a browser and sign in:\n  ${url}\n`
              : 'A browser window was opened for you to sign in.\n') +
            `The login stays active for ~${mins} minutes — once you've signed in, run the tool again ` +
            '(or call the `reauth` tool) and the token will be picked up automatically.'
        )
      );
    }, loginPromptTimeoutMs());
    current.promise.then(
      (token) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(token);
      },
      (err: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * Open the Hoppscotch `/device-login` page (frontend) in the default browser,
 * spin up a temporary local HTTP server to capture the callback, and return
 * the access token.
 *
 * The login page must be served by the frontend app; the API backend does not
 * render the consent UI.
 */
/**
 * Best-effort detection of an environment where no browser can be opened
 * (CI, SSH session, or a Linux host with no display server). Used to fail the
 * login fast with actionable guidance instead of blocking for 5 minutes.
 */
function isHeadlessEnvironment(): boolean {
  if (process.env.CI) return true;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return true;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true;
  }
  return false;
}

async function runLoginFlow(
  serverUrl: string,
  apiUrl: string,
  apiType: ApiType,
  urlSink: { url: string | null },
  signal: AbortSignal
): Promise<string> {
  // Fail fast on headless hosts: the browser device-login can't complete, and
  // without this the caller would hang for the full 5-minute LOGIN_TIMEOUT_MS
  // (usually surfacing as an opaque client-side timeout). The escape hatch lets
  // a user who genuinely has a browser override the heuristic.
  if (isHeadlessEnvironment() && process.env.HOPPSCOTCH_FORCE_BROWSER_LOGIN !== 'true') {
    return Promise.reject(
      new Error(
        'Browser device-login is unavailable (headless/CI/SSH environment detected). ' +
        'Set HOPPSCOTCH_ACCESS_TOKEN to a Hoppscotch JWT for non-interactive auth, ' +
        'or set HOPPSCOTCH_FORCE_BROWSER_LOGIN=true if a browser is actually available here.'
      )
    );
  }
  // Origin to allow for the cross-origin callback from the Hoppscotch frontend.
  // Restricting to the expected frontend origin (rather than reflecting arbitrary
  // Origin headers) prevents a malicious page the user may have open from
  // successfully posting a crafted token to our local callback.
  const allowedOrigin = new URL(serverUrl).origin;
  // CSRF-style nonce echoed back in the callback. A malicious page would need
  // to guess this value to inject a token during the login window.
  const stateNonce = randomBytes(32).toString('base64url');
  const expectedStateBuf = Buffer.from(stateNonce, 'utf8');

  return new Promise((resolve, reject) => {
    // We bind TWO servers, one on 127.0.0.1 and one on ::1, to the same
    // random port so the callback reaches us regardless of which loopback
    // family the browser resolves `localhost` to. Both servers share this
    // one request handler. Closing either is routed through closeAllServers
    // so a single callback tears down both listeners and cancels the timer.
    const servers: http.Server[] = [];
    const closeAllServers = () => {
      for (const s of servers) {
        try { s.close(); } catch { /* already closed */ }
      }
    };

    // Latch flipped by the first terminal outcome (success, timeout, or
    // fatal bind error). Guards against late callbacks mutating auth state
    // after the caller has already seen a resolve/reject: `server.close()`
    // is async and lets in-flight accepted requests continue, so a
    // callback that was mid-flight when the timer fired can still reach
    // `requestHandler`.
    let settled = false;
    const settleOnce = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };

    const requestHandler: http.RequestListener = (req, res) => {
      // Reject any request that arrives after we've already settled the
      // Promise (timeout, success, or bind error). The client gets a 410
      // so they know this attempt is dead; the caller's timeout rejection
      // stands and no auth state is mutated.
      if (settled) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', reason: 'login_flow_ended' }));
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');

      // Response varies by Origin regardless of whether we grant CORS, so set
      // unconditionally so any intermediary cache keys on it.
      res.setHeader('Vary', 'Origin');

      // Origin enforcement happens HERE, server-side, BEFORE any callback
      // parsing or side effects. The earlier "withhold Allow-Origin for
      // foreign origins" approach only gated whether the browser would let
      // the foreign page READ our response; it did NOT prevent the request
      // from reaching this handler and triggering settleOnce/storeAuth.
      //
      // - No Origin header: same-origin or non-browser caller (curl, axios
      //   without withCredentials, etc). Allowed; the state nonce is the
      //   only check for these.
      // - Origin === allowedOrigin: the legitimate Hoppscotch frontend.
      //   Grant CORS so the frontend's axios.get can read the response.
      // - Origin set to anything else: refuse before any side effect.
      const requestOrigin = req.headers.origin;
      if (requestOrigin !== undefined && requestOrigin !== allowedOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', reason: 'origin_forbidden' }));
        return;
      }

      if (requestOrigin === allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      }

      // Preflight OPTIONS request from the browser's CORS check
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Ignore favicon / unexpected paths silently.
      if (!url.pathname.startsWith('/callback/')) {
        res.writeHead(204);
        res.end();
        return;
      }

      const accessToken = url.searchParams.get('access_token');
      const refreshToken = url.searchParams.get('refresh_token');
      // The state nonce travels in the URL PATH (/callback/<nonce>), never
      // the query string. Both deployed Hoppscotch frontends deliver tokens
      // by string concatenation, axios.get(`${redirect_uri}?access_token=…`),
      // so a redirect_uri that already carries a query gains a second '?'
      // and the state param swallows the token params (broken login that
      // surfaces as a silent 5-minute timeout).
      const callbackState = url.pathname.slice('/callback/'.length);

      // Constant-time comparison prevents timing side-channels. Mismatched
      // length → definitely invalid, avoid the compare entirely.
      const stateValid =
        callbackState.length === stateNonce.length &&
        timingSafeEqual(Buffer.from(callbackState, 'utf8'), expectedStateBuf);

      if (!stateValid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', reason: 'invalid_state' }));
        // Don't close the server: a legitimate callback may still arrive.
        return;
      }

      // Respond 200 OK to the axios.get from the frontend
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));

      settleOnce(() => {
        closeAllServers();
        clearTimeout(callbackTimer);

        if (!accessToken) {
          reject(new Error('Login failed: no access_token received in callback'));
          return;
        }

        // For Cloud, the backend returns a Firebase Custom Token that must be
        // exchanged for a Firebase ID Token before it can be used as a Bearer
        // token with the GQL API.
        (apiType === 'cloud'
          ? exchangeFirebaseCustomToken(accessToken)
          : Promise.resolve({ idToken: accessToken, refreshToken: refreshToken ?? null })
        ).then(({ idToken, refreshToken: fbRefreshToken }) => {
          // The callback already flipped `settled`, so an abort that lands while
          // the (async) Cloud token exchange is in flight can't go through
          // settleOnce, where it would be a silent no-op. Re-check the signal HERE so
          // an explicit reauthenticate() during the exchange window can't persist
          // or cache this now-stale token (the user asked to switch identities).
          if (signal.aborted) {
            reject(new Error('Login aborted: a new authentication was started.'));
            return;
          }
          const expiresAt = jwtExpiresAt(idToken);
          // An explicit browser sign-in (re)pins the active identity: the user
          // actively chose this account, so it becomes the session identity even
          // if a different one was pinned before (a passive disk switch would be
          // refused instead, see getValidToken).
          const subject = jwtSubject(idToken);
          sessionSubject = subject;
          storeAuth({
            accessToken: idToken,
            refreshToken: apiType === 'cloud' ? null : (refreshToken ?? null),
            firebaseRefreshToken: apiType === 'cloud' ? (fbRefreshToken ?? undefined) : undefined,
            apiUrl,
            apiType,
            expiresAt,
            subject,
          });
          setMemCache(idToken, expiresAt, apiUrl, subject);
          resolve(idToken);
        }).catch((err: Error) => {
          reject(new Error(`Login failed: could not exchange token: ${err.message}`));
        });
      });
    };

    const callbackTimer = setTimeout(() => {
      settleOnce(() => {
        closeAllServers();
        reject(
          new Error(
            `Hoppscotch login callback window expired after ${Math.round(
              CALLBACK_TTL_MS / 60_000
            )} minutes without a completed sign-in.`
          )
        );
      });
    }, CALLBACK_TTL_MS);
    // Don't let the TTL timer keep the host process alive on its own: a pending
    // login must never block shutdown. The stdio transport (or an embedder's
    // transport) keeps the loop alive during a real login, so the timer still
    // fires normally; unref only matters once nothing else is running.
    callbackTimer.unref();

    // Abort path: reauthenticate() aborts an abandoned flow so its callback
    // listeners are torn down immediately (not at TTL) and a late sign-in on the
    // stale browser tab can't store a token after an explicit re-auth. Routed
    // through settleOnce so it composes with the success/timeout/bind-error
    // terminal paths and never double-settles. Registered AFTER callbackTimer so
    // a (theoretical) already-aborted signal can clear it without a TDZ hazard.
    const onAbort = () => {
      settleOnce(() => {
        clearTimeout(callbackTimer);
        closeAllServers();
        reject(new Error('Login aborted: a new authentication was started.'));
      });
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // First server binds to IPv4 loopback on a random port. This is the
    // guaranteed-available family; IPv4 loopback is universally supported.
    const ipv4Server = http.createServer(requestHandler);
    servers.push(ipv4Server);
    // Same rationale as callbackTimer.unref(): the callback listener must not,
    // by itself, keep a host process alive after everything else has stopped.
    ipv4Server.unref();

    ipv4Server.on('error', (err) => {
      settleOnce(() => {
        clearTimeout(callbackTimer);
        closeAllServers();
        reject(new Error(`Failed to start local auth server: ${err.message}`));
      });
    });

    ipv4Server.listen(0, '127.0.0.1', () => {
      const port = (ipv4Server.address() as { port: number }).port;

      // Second server binds ::1 on the SAME port as the IPv4 listener. This
      // closes the family-mismatch gap where `localhost` in the browser
      // resolves to ::1 on IPv6-first systems (Node 20+ verbatim DNS order,
      // macOS IPv6 /etc/hosts entries, etc.). We wait for its bind to
      // settle (ready OR known-unavailable) before emitting the callback
      // URL, otherwise an IPv6-first browser could resolve ::1 and hit a
      // socket that's still binding, with no IPv4 fallback for it.
      const ipv6Server = http.createServer(requestHandler);
      ipv6Server.unref();
      let ipv6Settled = false;
      const proceed = (haveIpv6: boolean) => {
        if (ipv6Settled) return;
        ipv6Settled = true;
        if (haveIpv6) servers.push(ipv6Server);
        emitCallbackUrl(port);
      };

      // Any IPv6 bind failure that ISN'T proof of kernel-level IPv6-loopback
      // unavailability is fail-closed: we cannot tell whether an IPv6-first
      // browser callback would reach us, another process, or nothing. Only
      // EADDRNOTAVAIL / EAFNOSUPPORT are treated as "IPv6 genuinely
      // unavailable here, IPv4-only is safe": on those hosts no browser can
      // resolve `localhost` to ::1 in the first place.
      const failClosed = (reason: string) => {
        settleOnce(() => {
          clearTimeout(callbackTimer);
          closeAllServers();
          reject(new Error(
            `Auth callback server could not bind to [::1]:${port} (${reason}). ` +
            'Refusing to proceed because a callback from an IPv6-first browser ' +
            'would not reach this process and may leak the access token to ' +
            'another listener. Check for a conflicting process or retry.'
          ));
        });
      };

      ipv6Server.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        // IPv6 loopback genuinely unavailable at kernel level → safe IPv4-only.
        if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
          process.stderr.write(`[MCP] IPv6 loopback unavailable (${code}); continuing with IPv4-only listener.\n`);
          proceed(false);
          return;
        }
        // EADDRINUSE, EACCES, or anything else: fail closed.
        failClosed(code ?? err.message);
      });

      ipv6Server.on('listening', () => proceed(true));

      try {
        ipv6Server.listen(port, '::1');
      } catch (err) {
        // Synchronous throw (rare; most listen errors are async 'error').
        // Treat conservatively as fail-closed.
        failClosed(`synchronous: ${String(err)}`);
      }
    });

    // Bake the state nonce into the callback URL PATH (base64url is
    // path-safe). It must NOT ride in the query string: the frontends
    // append `?access_token=…` to the redirect_uri verbatim, so an
    // existing query would be mangled into the state value. The Hoppscotch
    // backend's /auth/desktop validator requires the redirect_uri to start
    // with `http://localhost`, so the hostname stays `localhost`; the
    // dual-bind above ensures whichever family the browser resolves it to
    // will hit one of our listeners (or we fail loudly if that guarantee
    // can't hold).
    const emitCallbackUrl = (port: number) => {
      const callbackUrl = `http://localhost:${port}/callback/${stateNonce}`;
      const loginUrl =
        serverUrl.replace(/\/$/, '') +
        `/device-login?redirect_uri=${encodeURIComponent(callbackUrl)}`;

      // Publish the URL so a caller whose prompt timeout fires can surface it in
      // the tool result, and push it as a live progress notification (QoL).
      urlSink.url = loginUrl;
      reportAuthProgress(`Hoppscotch sign-in required — open this URL in a browser:\n  ${loginUrl}`);

      process.stderr.write('\n┌─────────────────────────────────────────┐\n');
      process.stderr.write('│  Hoppscotch MCP: Authentication required │\n');
      process.stderr.write('└─────────────────────────────────────────┘\n');
      process.stderr.write('Opening Hoppscotch login in your browser...\n');
      process.stderr.write(`If it doesn't open automatically:\n  ${loginUrl}\n\n`);

      open(loginUrl).catch(() => {
        // open() failure is non-fatal; user can copy the URL.
      });
    };
  });
}

/**
 * Exchange a Firebase Custom Token for a Firebase ID Token + refresh token.
 *
 * Cloud's /auth/desktop returns a Firebase Custom Token (aud: identitytoolkit.googleapis.com).
 * This must be exchanged via Firebase's signInWithCustomToken REST API to get a proper
 * ID Token that the Cloud GQL API's GqlAuthGuard (which verifies Firebase ID tokens) accepts.
 *
 * The Firebase Web API key is the public client key embedded in hoppscotch.io. It is
 * intentionally public and not a secret.
 */
async function exchangeFirebaseCustomToken(
  customToken: string
): Promise<{ idToken: string; refreshToken: string | null }> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseWebApiKey()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Firebase API key for hoppscotch.io has HTTP referrer restrictions;
        // providing the origin satisfies the check.
        Referer: 'https://hoppscotch.io',
      },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      signal: AbortSignal.timeout(10_000),
    }
  );

  const data = (await res.json()) as {
    idToken?: string;
    refreshToken?: string;
    error?: { message: string };
  };

  if (!res.ok || !data.idToken) {
    throw new Error(data.error?.message ?? 'Firebase token exchange failed');
  }

  return { idToken: data.idToken, refreshToken: data.refreshToken ?? null };
}

/**
 * Refresh a Firebase ID Token using a Firebase refresh token.
 * Works for Cloud (hoppscotch.io) only; SH uses its own /auth/refresh endpoint.
 */
async function refreshFirebaseToken(
  firebaseRefreshToken: string
): Promise<{ idToken: string; refreshToken: string }> {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${firebaseWebApiKey()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://hoppscotch.io',
      },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: firebaseRefreshToken }),
      signal: AbortSignal.timeout(10_000),
    }
  );

  const data = (await res.json()) as {
    id_token?: string;
    refresh_token?: string;
    error?: { message: string };
  };

  if (!res.ok || !data.id_token) {
    throw new Error(data.error?.message ?? 'Firebase token refresh failed');
  }

  return { idToken: data.id_token, refreshToken: data.refresh_token ?? firebaseRefreshToken };
}

/**
 * Exchange a refresh token for a new access token via the self-hosted `/auth/refresh`
 * endpoint (self-hosted only; Cloud uses Firebase). Returns the new tokens WITHOUT
 * persisting them. The caller re-checks the refreshed token's identity first and
 * persists only after that check passes, so a refresh that returns a DIFFERENT
 * account is never written to disk (which a later unpinned start would adopt).
 */
async function refreshAccessToken(
  apiUrl: string,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${apiUrl}/auth/refresh`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
  };

  if (!data.access_token) {
    throw new Error('Token refresh response missing access_token');
  }

  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? refreshToken };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function readStoredAuth(): StoredAuth | null {
  try {
    const raw = readFileSync(AUTH_FILE, 'utf8');
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return null;
  }
}

function storeAuth(auth: StoredAuth): void {
  try {
    // Dir 0o700 + file 0o600 so other local users can't list or read tokens.
    // chmodSync re-applies after mkdir to repair pre-existing dirs created
    // under a looser umask; failures (Windows, system-owned paths) are
    // non-fatal so the write itself still proceeds.
    mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    try { chmodSync(AUTH_DIR, 0o700); } catch { /* non-POSIX or EPERM */ }
    writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), {
      mode: 0o600,
      flag: 'w',
    });
    // writeFileSync's `mode` only applies when the file is CREATED; a
    // pre-existing auth.json under a looser mode would keep it. Re-apply so an
    // older/loose file is tightened to owner-only on every write.
    try { chmodSync(AUTH_FILE, 0o600); } catch { /* non-POSIX or EPERM */ }
  } catch (err) {
    // Non-fatal: the token won't persist across sessions but login still works.
    process.stderr.write(`Warning: could not persist auth token: ${err}\n`);
  }
}

/**
 * Clear stored auth, called when the server returns auth/fail (expired/revoked token).
 * Clears both disk and in-process memory cache.
 */
export function clearStoredAuth(): void {
  memCache = null;
  // Do NOT unpin sessionSubject here: clearStoredAuth runs on an ordinary
  // auth/fail (expired/revoked token) followed by an immediate retry; unpinning
  // would let an attacker who rewrites auth.json during that window get a
  // different account adopted. Only explicit reauthenticate() unpins identity.
  // Do NOT reset pendingLogin here: if a login window is already open,
  // subsequent calls should await it rather than opening another. (reauthenticate
  // is the explicit path that abandons an in-flight flow to start fresh.)
  try {
    writeFileSync(AUTH_FILE, '', { mode: 0o600, flag: 'w' });
  } catch {
    // Ignore.
  }
}

/**
 * Force a fresh login on demand: drop the in-memory + disk caches AND abandon
 * any in-flight shared login flow, then resolve a token, which starts a
 * brand-new browser flow. The exception is an explicit `accessToken`: the
 * CLI populates it from HOPPSCOTCH_ACCESS_TOKEN via loadConfig and an embedder
 * sets it directly, and that token is then returned as-is. Lets an agent
 * re-trigger sign-in without waiting for a natural cache miss. The previously-open callback server (if any)
 * is torn down immediately via its abort handle, so the stale browser tab can't
 * store a token after the user explicitly asked to re-authenticate.
 */
export async function reauthenticate(
  serverUrl: string,
  apiUrl: string,
  apiType: ApiType,
  accessToken?: string
): Promise<string> {
  memCache = null;
  sessionSubject = null;
  pendingLogin?.abort();
  pendingLogin = null;
  clearStoredAuth();
  return getValidToken(serverUrl, apiUrl, apiType, accessToken);
}

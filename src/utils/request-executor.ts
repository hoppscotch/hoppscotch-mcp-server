/**
 * Request execution utilities for running API requests
 */

import type { EnvironmentVariable } from '../types.js';
import { VERSION } from '../version.js';
import { assertScheme, assertUrlAllowed, privateHostsAllowed, getPinnedDispatcher, SSRFBlockedError } from './ssrf-guard.js';

/** Default cap on the response body we buffer into memory (bytes). */
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;

function maxResponseBytes(): number {
  const raw = Number(process.env.HOPPSCOTCH_MAX_RESPONSE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_RESPONSE_BYTES;
}

/**
 * Read a response body up to `max + margin` bytes. Guards against an unbounded
 * response exhausting memory. `margin` lets the caller buffer past `max` so a
 * secret straddling the `max` boundary is fully present for redaction.
 *
 * Returns two independent signals:
 *  - `truncated`: the body exceeded `max`, so the returned/clamped view is partial
 *    (drives the caller's user-facing truncation flag).
 *  - `hitLimit`: the read stopped AT the `max + margin` hard limit, so a secret
 *    may be cut at the read edge — the redactor must not emit that edge as text.
 */
async function readBodyCapped(
  response: Response,
  max: number,
  margin = 0
): Promise<{ text: string; truncated: boolean; hitLimit: boolean }> {
  if (!response.body) return { text: await response.text(), truncated: false, hitLimit: false };
  const hardLimit = max + margin;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let hitLimit = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      if (total + value.byteLength > hardLimit) {
        chunks.push(value.subarray(0, hardLimit - total));
        total = hardLimit;
        hitLimit = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: hitLimit || total > max, hitLimit };
}

export interface RequestDefinition {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  auth?: {
    type: 'bearer' | 'basic' | 'api-key';
    token?: string;
    username?: string;
    password?: string;
    key?: string;
    value?: string;
    addTo?: 'header' | 'query';
  };
}

export interface ExecutionResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  responseTime: number;
  success: boolean;
  error?: string;
  /** True when the body was cut off at HOPPSCOTCH_MAX_RESPONSE_BYTES. */
  truncated?: boolean;
}

/**
 * Substitute environment variables in a string
 */
export function substituteVariables(
  text: string,
  variables: EnvironmentVariable[]
): string {
  let result = text;

  for (const variable of variables) {
    // Literal split/join — never build a RegExp from a user-controlled key
    // (a metacharacter in the key would throw or mis-match).
    result = result.split(`{{${variable.key}}}`).join(variable.value);
  }

  return result;
}

/**
 * A string undergoing secret substitution, carrying a parallel per-code-unit flag
 * marking which characters originate from a substituted secret value. Lets us recover
 * the EXACT secret-derived spans of the final request — the precise bytes response
 * scrubbing must cover — instead of guessing from raw secret values. This stays correct
 * when a secret's value embeds another secret's placeholder, when a placeholder forms
 * across a value/text boundary, and when a value collapses to empty.
 */
interface TaintedText {
  text: string;
  /** secretMask[i] === true ⇔ text[i] came from a substituted secret value. */
  secretMask: boolean[];
}

/** Non-secret text seeds an all-false mask (its characters are not secrets). */
function untaintedText(text: string): TaintedText {
  return { text, secretMask: new Array(text.length).fill(false) };
}

/**
 * Replace every literal occurrence of `token` with `value`, marking the inserted
 * characters as secret-derived and preserving the taint of untouched characters.
 * Byte-for-byte identical to `text.split(token).join(value)` (non-overlapping,
 * left-to-right), so the wire request is unchanged while provenance is tracked.
 *
 * Uses native `indexOf` to jump between matches and slices whole runs at a time —
 * keeping it O(text length) per call rather than the Θ(n²) a per-position `startsWith`
 * scan would cost on a pathological (long-key) token.
 */
function replaceTainted(t: TaintedText, token: string, value: string): void {
  let match = t.text.indexOf(token);
  if (match === -1) return; // token absent — text and mask unchanged
  const valueMask = new Array(value.length).fill(true);
  const textParts: string[] = [];
  const maskParts: boolean[][] = [];
  let from = 0;
  while (match !== -1) {
    if (match > from) {
      textParts.push(t.text.slice(from, match));
      maskParts.push(t.secretMask.slice(from, match));
    }
    if (value.length > 0) {
      textParts.push(value);
      maskParts.push(valueMask);
    }
    from = match + token.length;
    match = t.text.indexOf(token, from);
  }
  if (from < t.text.length) {
    textParts.push(t.text.slice(from));
    maskParts.push(t.secretMask.slice(from));
  }
  t.text = textParts.join('');
  t.secretMask = maskParts.flat();
}

/** The maximal contiguous runs of secret-derived characters — the exact secret
 *  byte-spans that reach the wire, which response scrubbing must cover. Empty runs
 *  are naturally excluded (an empty secret contributes no characters). */
function secretSpans(t: TaintedText): string[] {
  const spans: string[] = [];
  let start = -1;
  for (let i = 0; i < t.text.length; i++) {
    if (t.secretMask[i]) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      spans.push(t.text.slice(start, i));
      start = -1;
    }
  }
  if (start !== -1) spans.push(t.text.slice(start));
  return spans;
}

export class SecretEgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretEgressBlockedError';
  }
}

export class UnresolvedPlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvedPlaceholderError';
  }
}

/** Matches a `{{name}}` template placeholder (name = any run without braces). */
const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** The URL origin (scheme://host:port), or null if not a parseable absolute URL. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Origins an operator has allowlisted to receive secret env values, from
 * HOPPSCOTCH_SECRET_ALLOWED_ORIGINS (comma-separated absolute origins, e.g.
 * "https://api.example.com,https://api2.example.com").
 *
 * Returns null when the var is UNSET — meaning no restriction, so secret values
 * substitute freely (the pre-hardening default). Setting the var opts IN to the
 * allowlist: only the listed origins may then receive secrets (set it to an empty
 * value to deny all). Read at call time.
 */
function allowedSecretOrigins(): Set<string> | null {
  const raw = process.env.HOPPSCOTCH_SECRET_ALLOWED_ORIGINS;
  if (raw === undefined) return null; // unset ⇒ no restriction (opt-in by setting it)
  const out = new Set<string>();
  for (const entry of raw.split(',')) {
    const origin = originOf(entry.trim());
    if (origin) out.add(origin);
  }
  return out;
}

const REDACTED = '<redacted>';

/**
 * The distinct strings we must scrub for a given secret set: each secret value
 * plus its JSON-string-escaped inner form, so a secret echoed inside a JSON body
 * (where e.g. a `"` in the value is serialised as `\"`) is caught by the literal
 * match. Sorted longest-first so an overlapping longer variant wins.
 */
function secretRedactionVariants(secretValues: string[]): string[] {
  const variants = new Set<string>();
  for (const value of secretValues) {
    if (!value) continue;
    variants.add(value);
    const jsonEscaped = JSON.stringify(value).slice(1, -1); // inner (escaped) form, no quotes
    if (jsonEscaped !== value) variants.add(jsonEscaped);
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

/** Max BYTE length across all redaction variants — the read margin needed so a
 *  secret straddling a byte cap is fully buffered (char length under-counts a
 *  multibyte or `\uXXXX`-escaped secret, which would let a prefix leak). */
function longestVariantBytes(secretValues: string[]): number {
  let max = 0;
  for (const v of secretRedactionVariants(secretValues)) max = Math.max(max, Buffer.byteLength(v));
  return max;
}

/**
 * Replace every occurrence of each secret value (and its JSON-escaped form) with
 * <redacted>. Unbounded — use only on small strings (headers, statusText); for a
 * response body use {@link redactSecretsClamped}, which bounds output.
 */
export function redactSecrets(text: string, secretValues: string[] = []): string {
  let out = text;
  for (const value of secretRedactionVariants(secretValues)) {
    out = out.split(value).join(REDACTED);
  }
  return out;
}

/** Native-indexOf work a single redaction pass may spend before it fails safe. A
 *  realistic body (a few secrets, ordinary values) costs far less; the cap only
 *  fires on a pathological input (e.g. many secrets that are long single-char
 *  runs matching a same-char body), which would otherwise stall the event loop. */
const REDACTION_WORK_CAP = 50_000_000;

/** Pathological-input fallback: emit only a placeholder (never body content), still
 *  bounded to maxOut. Leak-safe by construction — no scanned text is returned. */
function failSafeRedaction(maxOut: number): { text: string; clamped: boolean } {
  return { text: maxOut < REDACTED.length ? REDACTED.slice(0, maxOut) : REDACTED, clamped: true };
}

/**
 * Redact secrets from a response body AND bound the output to `maxOut` chars.
 *
 * Find-all → merge → emit: every variant is scanned ONCE for all its occurrences
 * with native `indexOf` (cost O(variants · n), never O(n²)), the occurrence
 * intervals are merged, then non-secret gaps and one `<redacted>` per merged
 * interval are emitted up to `maxOut`. Merging is essential — a secret whose
 * occurrence begins INSIDE another secret's match would otherwise be skipped and
 * its tail leaked. Stopping at `maxOut` bounds expansion (a short secret across a
 * huge body never allocates the fully-expanded string). A cumulative work cap
 * fails safe to a single placeholder on a pathological input.
 *
 * `readHitLimit` says the source was cut at the reader's hard limit, so a secret
 * may straddle the read edge with only its prefix present. Occurrences starting
 * in the trailing longest-variant window are ignored and that window is never
 * emitted, so such a prefix can never surface as ordinary text.
 *
 * `clamped` is true when the returned body is incomplete (edge trimmed, output
 * capped, or work cap hit), so the caller can flag truncation honestly.
 */
export function redactSecretsClamped(
  text: string,
  secretValues: string[],
  maxOut: number,
  readHitLimit = false
): { text: string; clamped: boolean } {
  const variants = secretRedactionVariants(secretValues);
  if (variants.length === 0) {
    return text.length > maxOut ? { text: text.slice(0, maxOut), clamped: true } : { text, clamped: false };
  }

  // Exclude a trailing longest-variant window when the read was cut, so a secret
  // straddling the read edge (prefix buffered, suffix not) is never emitted.
  const longest = variants[0]!.length; // variants are sorted longest-first
  const scanEnd = readHitLimit ? Math.max(0, text.length - longest) : text.length;

  // 1. Collect every occurrence interval [start, end) that STARTS before scanEnd.
  //    +1 stepping finds overlapping occurrences of the same variant too. Adjacent/
  //    overlapping hits are merged into the previous interval IN PLACE, so a dense
  //    run (e.g. a 1-char secret over a huge body) stays O(1) memory, not O(n).
  const intervals: Array<[number, number]> = [];
  let work = 0;
  for (const v of variants) {
    let from = 0;
    // Per-variant merge anchor. Within ONE variant, indexOf walks strictly forward
    // (from = p+1), so its occurrences are position-monotonic and adjacent/overlapping
    // hits fold into `last` in O(1) memory (a dense 1-char secret over a huge body stays
    // a single interval). It is reset per variant on purpose: a LATER (shorter) variant
    // may match at an EARLIER position than an already-pushed interval, which is NOT
    // monotonic across variants — merging against the global last there silently dropped
    // the earlier match (round-10 leak). Cross-variant overlaps are left as separate
    // intervals and reconciled by the sort+merge below.
    let last: [number, number] | null = null;
    for (;;) {
      const p = text.indexOf(v, from);
      // Charge the ACTUAL scan distance so the cap reflects real work: indexOf may
      // scan to text.length (not just scanEnd) to return -1, and past-scanEnd to
      // find a match we then discard. Undercounting here let many absent secrets
      // run unbounded below the cap.
      if (p === -1) {
        work += text.length - from;
        break;
      }
      if (p >= scanEnd) {
        work += p - from;
        break;
      }
      const end = p + v.length;
      if (last && p <= last[1]) {
        if (end > last[1]) last[1] = end;
      } else {
        last = [p, end];
        intervals.push(last);
      }
      work += p - from + v.length; // scan distance + the matched compare
      if (work > REDACTION_WORK_CAP) return failSafeRedaction(maxOut); // fail safe
      from = p + 1;
    }
    if (work > REDACTION_WORK_CAP) return failSafeRedaction(maxOut);
  }

  // 2. Merge overlapping/adjacent intervals so a secret occurrence beginning inside
  //    another's match is still fully covered (no fragment leak).
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) {
      if (iv[1] > last[1]) last[1] = iv[1];
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }

  // 3. Emit non-secret gaps + one placeholder per merged interval, bounded to maxOut.
  const parts: string[] = [];
  let outLen = 0;
  let cursor = 0;
  for (const [s, e] of merged) {
    if (outLen >= maxOut) break;
    if (s > cursor) {
      const end = Math.min(s, cursor + (maxOut - outLen)); // gap within budget
      parts.push(text.slice(cursor, end));
      outLen += end - cursor;
      cursor = end;
      if (cursor < s) break; // budget exhausted mid-gap
    }
    if (outLen >= maxOut) break;
    parts.push(REDACTED);
    outLen += REDACTED.length;
    cursor = e;
  }
  if (cursor < scanEnd && outLen < maxOut) {
    const end = Math.min(scanEnd, cursor + (maxOut - outLen)); // trailing non-secret gap
    parts.push(text.slice(cursor, end));
    outLen += end - cursor;
    cursor = end;
  }

  let result = parts.join('');
  let clamped = cursor < text.length;
  if (result.length > maxOut) {
    result = result.slice(0, maxOut);
    clamped = true;
  }
  return { text: result, clamped };
}

/**
 * Substitute environment variables into a model-supplied request, enforcing the
 * secret-egress policy:
 *  - Non-secret values are substituted freely.
 *  - Secret (secret:true) values substitute freely by default. If the operator
 *    opts in by setting HOPPSCOTCH_SECRET_ALLOWED_ORIGINS, a secret is then
 *    substituted ONLY when the request's target origin is allowlisted; otherwise
 *    this throws, so a prompt-injected request can't exfiltrate a secret to an
 *    attacker-chosen origin. The origin is resolved from non-secret substitution
 *    first, and a transitive secret reference (a non-secret value that expands to
 *    a `{{secret}}` placeholder) is caught.
 *  - When `requireResolved` is set (an environment was requested), any leftover
 *    `{{placeholder}}` throws rather than being sent literally or as a partial
 *    request.
 */
export function substituteRequestVariables(
  raw: { url: string; headers: Record<string, string>; body?: string },
  variables: EnvironmentVariable[],
  options: { requireResolved: boolean }
): { url: string; headers: Record<string, string>; body?: string; substitutedSecretValues: string[] } {
  const nonSecret = variables.filter((v) => !v.secret);
  const secret = variables.filter((v) => v.secret);

  // 1. Substitute non-secret values everywhere first (this also expands a
  //    non-secret value that itself contains a `{{secret}}` placeholder).
  let url = substituteVariables(raw.url, nonSecret);
  let body = raw.body !== undefined ? substituteVariables(raw.body, nonSecret) : raw.body;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.headers)) headers[k] = substituteVariables(v, nonSecret);

  // 2. Which secrets does the (non-secret-substituted) request still reference?
  const references = (key: string): boolean => {
    const token = `{{${key}}}`;
    return (
      url.includes(token) ||
      (body?.includes(token) ?? false) ||
      Object.values(headers).some((h) => h.includes(token))
    );
  };
  const referencedSecrets = secret.filter((s) => references(s.key));

  // 3. Substitute secret values on taint-tracked copies, then record — as the
  //    response-scrub set — the EXACT secret-derived spans of the final request. This
  //    covers precisely the secret bytes that can echo back, so it (a) drops
  //    unreferenced and shadowed-duplicate secrets, fixing the over-redaction of
  //    ordinary response text, and (b) still captures every secret byte actually sent,
  //    including a secret referenced only transitively and the composed value of a
  //    secret whose value embeds another `{{placeholder}}` or forms a token across a
  //    value boundary. The substitution is byte-identical to substituteVariables.
  const substitutedSecretValues: string[] = [];
  if (referencedSecrets.length > 0) {
    const allowed = allowedSecretOrigins();
    if (allowed !== null) {
      const origin = originOf(url);
      if (origin === null || !allowed.has(origin)) {
        const keys = referencedSecrets.map((s) => s.key).join(', ');
        throw new SecretEgressBlockedError(
          `Refusing to substitute secret environment variable(s) {${keys}} into a request to ` +
            `${origin ?? 'an undetermined origin'}: that origin is not allowlisted for secrets. ` +
            `Add it to HOPPSCOTCH_SECRET_ALLOWED_ORIGINS (comma-separated origins).`
        );
      }
    }
    // Apply each secret in array order to tainted copies (byte-identical to the prior
    // substituteVariables(text, secret) form), marking inserted value characters as
    // secret-derived. The final secret spans are the exact bytes to scrub.
    const urlT = untaintedText(url);
    const bodyT = body !== undefined ? untaintedText(body) : undefined;
    const headerTs = Object.entries(headers).map(([k, v]) => [k, untaintedText(v)] as const);
    for (const s of secret) {
      const token = `{{${s.key}}}`;
      replaceTainted(urlT, token, s.value);
      if (bodyT) replaceTainted(bodyT, token, s.value);
      for (const [, t] of headerTs) replaceTainted(t, token, s.value);
    }
    url = urlT.text;
    if (bodyT) body = bodyT.text;
    for (const [k, t] of headerTs) headers[k] = t.text;

    const spans = new Set<string>();
    for (const t of [urlT, ...(bodyT ? [bodyT] : []), ...headerTs.map(([, t]) => t)]) {
      for (const span of secretSpans(t)) spans.add(span);
    }
    for (const span of spans) substitutedSecretValues.push(span);
    // Re-check the EFFECTIVE origin after substitution (only when the allowlist is
    // in force): a secret value could have changed the target host (e.g. userinfo
    // `{{SECRET}}@host`, or a secret-built authority). URL.origin excludes userinfo,
    // so the pre-check could pass while the connect target differs.
    if (allowed !== null) {
      const finalOrigin = originOf(url);
      if (finalOrigin === null || !allowed.has(finalOrigin)) {
        const keys = referencedSecrets.map((s) => s.key).join(', ');
        throw new SecretEgressBlockedError(
          `Refusing to send secret environment variable(s) {${keys}}: after substitution the ` +
            `request targets ${finalOrigin ?? 'an undetermined origin'}, which is not allowlisted ` +
            `for secrets. Check HOPPSCOTCH_SECRET_ALLOWED_ORIGINS.`
        );
      }
    }
  }

  // 4. When substitution was requested, no placeholder may be left unresolved —
  //    never send a literal {{...}} or a partially-substituted request.
  if (options.requireResolved) {
    const unresolved = new Set<string>();
    const scan = (text: string) => {
      for (const m of text.matchAll(PLACEHOLDER_RE)) {
        if (m[1]) unresolved.add(m[1]);
      }
    };
    scan(url);
    if (body !== undefined) scan(body);
    for (const v of Object.values(headers)) scan(v);
    if (unresolved.size > 0) {
      throw new UnresolvedPlaceholderError(
        `Unresolved variable placeholder(s): ${[...unresolved].map((n) => `{{${n}}}`).join(', ')}. ` +
          `Provide them via the selected environment or remove them; the request was not sent.`
      );
    }
  }

  // substitutedSecretValues holds the exact secret-derived spans of the request built
  // above — the only bytes that can echo back — so they, and only they, drive response
  // scrubbing. Passing every env secret (incl. unreferenced or short/common values)
  // would over-redact and corrupt ordinary response text; a raw-value set would miss a
  // secret's composed wire form. See SECURITY.md ("secret values it substituted").
  return { url, headers, body, substitutedSecretValues };
}

/**
 * Execute an HTTP request
 */
export async function executeRequest(
  request: RequestDefinition,
  timeout: number = 30000,
  secretValues: string[] = []
): Promise<ExecutionResult> {
  const startTime = Date.now();

  try {
    const headers: Record<string, string> = {
      'User-Agent': `Hoppscotch-MCP-Server/${VERSION}`,
      ...request.headers,
    };

    // Resolve target URL: api-key auth with addTo='query' appends key=value
    // to the URL's search params. Default is 'header' if unspecified.
    let targetUrl = request.url;

    if (request.auth) {
      if (request.auth.type === 'bearer' && request.auth.token) {
        headers['Authorization'] = `Bearer ${request.auth.token}`;
      } else if (request.auth.type === 'basic' && request.auth.username && request.auth.password) {
        const credentials = Buffer.from(
          `${request.auth.username}:${request.auth.password}`
        ).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
      } else if (request.auth.type === 'api-key' && request.auth.key && request.auth.value) {
        const addTo = request.auth.addTo ?? 'header';
        if (addTo === 'header') {
          headers[request.auth.key] = request.auth.value;
        } else if (addTo === 'query') {
          const u = new URL(request.url);
          u.searchParams.set(request.auth.key, request.auth.value);
          targetUrl = u.toString();
        }
      }
    }

    // SSRF guard. Scheme is enforced unconditionally; the private/loopback/
    // metadata address checks (incl. DNS resolution) are skipped only when the
    // operator opts in via HOPPSCOTCH_ALLOW_PRIVATE_HOSTS=true for local/
    // self-hosted API testing.
    assertScheme(targetUrl);
    let dispatcher: ReturnType<typeof getPinnedDispatcher> | undefined;
    if (!privateHostsAllowed()) {
      await assertUrlAllowed(targetUrl);
      // Pin the validated address at connect time so the request can't be
      // re-resolved to a different (private) IP after the pre-flight check —
      // closes the DNS-rebinding TOCTOU. The dispatcher's lookup re-validates.
      dispatcher = getPinnedDispatcher();
    }

    const options: RequestInit = {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(timeout),
      // Do NOT auto-follow redirects: a permitted host could 30x cross-origin and
      // leak custom auth headers (e.g. X-API-Key) — and a redirect could point at
      // a private/metadata IP, bypassing the pre-flight guard. Surface the 3xx.
      redirect: 'manual',
    };
    if (dispatcher) {
      (options as RequestInit & { dispatcher?: unknown }).dispatcher = dispatcher;
    }

    if (request.body && !['GET', 'HEAD'].includes(request.method.toUpperCase())) {
      options.body = request.body;
    }

    const response = await fetch(targetUrl, options as RequestInit);
    const responseTime = Date.now() - startTime;

    // Parse response. An allowlisted API can echo a substituted secret in a 4xx
    // body/header (fetch does not throw on 4xx/5xx), so scrub secret values from
    // BOTH — they must never reach model context.
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = redactSecrets(value, secretValues);
    });

    // Buffer a margin = longest redaction-variant BYTE length past the cap so a
    // secret straddling the cap boundary is fully present for matching (cutting at
    // the cap first would leave its prefix in the output; a char-length margin
    // would under-count a multibyte/escaped secret). redactSecretsClamped then
    // fuses redaction with the clamp to the cap, so it never allocates the fully
    // expanded string, and reports whether the returned body was cut.
    const rawCap = maxResponseBytes();
    const { text: rawBody, truncated: rawTruncated, hitLimit } = await readBodyCapped(
      response,
      rawCap,
      longestVariantBytes(secretValues)
    );
    const { text: body, clamped } = redactSecretsClamped(rawBody, secretValues, rawCap, hitLimit);
    const truncated = rawTruncated || clamped;

    return {
      status: response.status,
      statusText: redactSecrets(response.statusText, secretValues),
      headers: responseHeaders,
      body,
      responseTime,
      success: response.ok,
      truncated,
    };
  } catch (error) {
    // A rebinding block surfaces from the pinned dispatcher's lookup as the
    // `cause` of a fetch TypeError; unwrap it so it still reports cleanly.
    const ssrf =
      error instanceof SSRFBlockedError
        ? error
        : error instanceof Error && error.cause instanceof SSRFBlockedError
          ? error.cause
          : null;
    if (ssrf) {
      return {
        status: 0,
        statusText: 'Blocked',
        headers: {},
        body: '',
        responseTime: Date.now() - startTime,
        success: false,
        error: redactSecrets(ssrf.message, secretValues),
      };
    }
    const responseTime = Date.now() - startTime;

    return {
      status: 0,
      statusText: 'Error',
      headers: {},
      body: '',
      responseTime,
      success: false,
      error: redactSecrets(error instanceof Error ? error.message : String(error), secretValues),
    };
  }
}

/**
 * Validate response against expected criteria
 */
export interface ValidationCriteria {
  expectedStatus?: number;
  expectedStatusRange?: { min: number; max: number };
  expectedHeaders?: Record<string, string>;
  expectedBodyContains?: string[];
  /** Assert the body parses as a JSON object/array (NOT full JSON Schema validation). */
  jsonObject?: boolean;
  /** @deprecated alias of jsonObject — triggers the same is-a-JSON-object check; does not validate against the schema. */
  jsonSchema?: object;
  maxResponseTime?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateResponse(
  result: ExecutionResult,
  criteria: ValidationCriteria
): ValidationResult {
  const errors: string[] = [];

  // A request that never completed (network error, SSRF block, timeout) reports
  // status 0 with an error message. Fail hard and short-circuit so a permissive
  // (or empty) criteria set can't report a blocked/errored request as valid.
  if (result.status === 0 && result.error) {
    return { valid: false, errors: [`Request did not complete: ${result.error}`] };
  }

  // Check status code
  if (criteria.expectedStatus !== undefined) {
    if (result.status !== criteria.expectedStatus) {
      errors.push(
        `Expected status ${criteria.expectedStatus}, got ${result.status}`
      );
    }
  }

  // Check status range
  if (criteria.expectedStatusRange) {
    const { min, max } = criteria.expectedStatusRange;
    if (result.status < min || result.status > max) {
      errors.push(
        `Expected status in range ${min}-${max}, got ${result.status}`
      );
    }
  }

  // Check headers
  if (criteria.expectedHeaders) {
    for (const [key, value] of Object.entries(criteria.expectedHeaders)) {
      const actualValue = result.headers[key.toLowerCase()];
      if (actualValue !== value) {
        errors.push(
          `Expected header ${key}: ${value}, got ${actualValue || 'undefined'}`
        );
      }
    }
  }

  // Check body content
  if (criteria.expectedBodyContains) {
    for (const substring of criteria.expectedBodyContains) {
      if (!result.body.includes(substring)) {
        errors.push(`Expected body to contain "${substring}"`);
      }
    }
  }

  // Check response time
  if (criteria.maxResponseTime !== undefined) {
    if (result.responseTime > criteria.maxResponseTime) {
      errors.push(
        `Response time ${result.responseTime}ms exceeds maximum ${criteria.maxResponseTime}ms`
      );
    }
  }

  // Assert the body is structured JSON (object/array). This is NOT JSON Schema
  // validation — it only checks that the body parses to an object/array. Both
  // `jsonObject` and the deprecated `jsonSchema` alias trigger this same check.
  if (criteria.jsonObject || criteria.jsonSchema !== undefined) {
    try {
      const parsed: unknown = JSON.parse(result.body);
      // Preserve the existing `typeof === 'object'` semantics exactly (objects,
      // arrays, and the JS quirk `null` all pass) — this is a rename/redocument,
      // not a behavior change.
      if (typeof parsed !== 'object') {
        errors.push('Response body is not a JSON object/array');
      }
    } catch {
      errors.push('Response body is not valid JSON');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Format response for display
 */
export function formatResponse(result: ExecutionResult): string {
  const sections: string[] = [];

  // Status line
  sections.push(`Status: ${result.status} ${result.statusText}`);
  sections.push(`Response Time: ${result.responseTime}ms`);
  sections.push('');

  // Headers
  if (Object.keys(result.headers).length > 0) {
    sections.push('Headers:');
    for (const [key, value] of Object.entries(result.headers)) {
      sections.push(`  ${key}: ${value}`);
    }
    sections.push('');
  }

  // Body
  sections.push('Body:');
  try {
    const parsed = JSON.parse(result.body);
    sections.push(JSON.stringify(parsed, null, 2));
  } catch {
    sections.push(result.body);
  }

  if (result.truncated) {
    sections.push('');
    sections.push('[response truncated at HOPPSCOTCH_MAX_RESPONSE_BYTES]');
  }

  if (result.error) {
    sections.push('');
    sections.push(`Error: ${result.error}`);
  }

  return sections.join('\n');
}

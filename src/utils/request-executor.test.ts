import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  substituteVariables,
  validateResponse,
  formatResponse,
  executeRequest,
  substituteRequestVariables,
  redactSecrets,
  redactSecretsClamped,
  SecretEgressBlockedError,
  UnresolvedPlaceholderError,
} from './request-executor.js';
import type { ExecutionResult, ValidationCriteria } from '../types.js';

describe('request-executor', () => {
  describe('substituteVariables', () => {
    it('should substitute single variable', () => {
      const template = 'https://api.example.com/{{version}}/users';
      const variables = [{ key: 'version', value: 'v1' }];

      const result = substituteVariables(template, variables);

      expect(result).toBe('https://api.example.com/v1/users');
    });

    it('should substitute multiple variables', () => {
      const template = '{{BASE_URL}}/{{resource}}';
      const variables = [
        { key: 'BASE_URL', value: 'https://api.example.com' },
        { key: 'resource', value: 'users' },
      ];

      const result = substituteVariables(template, variables);

      expect(result).toBe('https://api.example.com/users');
    });

    it('should handle missing variables', () => {
      const template = 'https://api.example.com/{{missing}}/users';
      const variables: Array<{ key: string; value: string }> = [];

      const result = substituteVariables(template, variables);

      expect(result).toBe('https://api.example.com/{{missing}}/users');
    });

    it('should substitute same variable multiple times', () => {
      const template = '{{token}} and {{token}}';
      const variables = [{ key: 'token', value: 'abc123' }];

      const result = substituteVariables(template, variables);

      expect(result).toBe('abc123 and abc123');
    });
  });

  describe('validateResponse', () => {
    const mockResult: ExecutionResult = {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'x-custom': 'value',
      },
      body: JSON.stringify({ id: 1, name: 'John' }),
      responseTime: 150,
      success: true,
    };

    it('should validate status code - pass', () => {
      const criteria: ValidationCriteria = {
        expectedStatus: 200,
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate status code - fail', () => {
      const criteria: ValidationCriteria = {
        expectedStatus: 201,
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should validate status range - pass', () => {
      const criteria: ValidationCriteria = {
        expectedStatusRange: { min: 200, max: 299 },
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(true);
    });

    it('should validate status range - fail', () => {
      const criteria: ValidationCriteria = {
        expectedStatusRange: { min: 400, max: 499 },
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(false);
    });

    it('should validate headers - pass', () => {
      const criteria: ValidationCriteria = {
        expectedHeaders: {
          'content-type': 'application/json',
        },
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(true);
    });

    it('should validate headers - fail', () => {
      const criteria: ValidationCriteria = {
        expectedHeaders: {
          'x-missing': 'value',
        },
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(false);
    });

    it('should validate body contains - pass', () => {
      const criteria: ValidationCriteria = {
        expectedBodyContains: ['John', 'id'],
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(true);
    });

    it('should validate body contains - fail', () => {
      const criteria: ValidationCriteria = {
        expectedBodyContains: ['missing-text'],
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(false);
    });

    it('should validate response time - pass', () => {
      const criteria: ValidationCriteria = {
        maxResponseTime: 200,
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(true);
    });

    it('should validate response time - fail', () => {
      const criteria: ValidationCriteria = {
        maxResponseTime: 100,
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(false);
    });

    it('should validate multiple criteria', () => {
      const criteria: ValidationCriteria = {
        expectedStatus: 200,
        expectedBodyContains: ['John'],
        maxResponseTime: 200,
      };

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(true);
    });

    it('should handle empty criteria', () => {
      const criteria: ValidationCriteria = {};

      const result = validateResponse(mockResult, criteria);

      expect(result.valid).toBe(true);
    });

    it('jsonObject: true passes for a JSON object body', () => {
      expect(validateResponse(mockResult, { jsonObject: true }).valid).toBe(true);
    });

    it('jsonObject: true fails for a non-JSON body', () => {
      const nonJson: ExecutionResult = { ...mockResult, body: 'plain text, not json' };
      const result = validateResponse(nonJson, { jsonObject: true });
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/not valid JSON/);
    });

    it('jsonObject: true fails for a JSON primitive (not an object/array)', () => {
      const primitive: ExecutionResult = { ...mockResult, body: '42' };
      const result = validateResponse(primitive, { jsonObject: true });
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/not a JSON object/);
    });

    it('jsonSchema (deprecated alias) triggers the same is-a-JSON-object check as jsonObject', () => {
      // Any value under jsonSchema behaves exactly like jsonObject: true.
      expect(validateResponse(mockResult, { jsonSchema: {} }).valid).toBe(true);
      const nonJson: ExecutionResult = { ...mockResult, body: 'plain text, not json' };
      const failed = validateResponse(nonJson, { jsonSchema: {} });
      expect(failed.valid).toBe(false);
      expect(failed.errors.join(' ')).toMatch(/not valid JSON/);
    });

    it('fails hard when the request did not complete (status 0 + error), even with permissive criteria', () => {
      const blocked: ExecutionResult = {
        status: 0,
        statusText: 'Blocked',
        headers: {},
        body: '',
        responseTime: 5,
        success: false,
        error: 'Blocked request to a private/internal address',
      };
      // Empty / permissive criteria would previously PASS — a request that never
      // completed must not be reported valid.
      expect(validateResponse(blocked, {}).valid).toBe(false);
      expect(validateResponse(blocked, { maxResponseTime: 100000 }).valid).toBe(false);
      expect(validateResponse(blocked, {}).errors.join(' ')).toMatch(/did not complete/);
    });
  });

  describe('formatResponse', () => {
    it('should format successful response', () => {
      const result: ExecutionResult = {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"data":"test"}',
        responseTime: 123,
        success: true,
      };

      const formatted = formatResponse(result);

      expect(formatted).toContain('Status: 200 OK');
      expect(formatted).toContain('Response Time: 123ms');
      expect(formatted).toContain('content-type: application/json');
    });

    it('should format failed response', () => {
      const result: ExecutionResult = {
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: 'Resource not found',
        responseTime: 50,
        success: false,
      };

      const formatted = formatResponse(result);

      expect(formatted).toContain('Status: 404 Not Found');
      expect(formatted).toContain('Response Time: 50ms');
    });

    it('should handle empty body', () => {
      const result: ExecutionResult = {
        status: 204,
        statusText: 'No Content',
        headers: {},
        body: '',
        responseTime: 25,
        success: true,
      };

      const formatted = formatResponse(result);

      expect(formatted).toContain('Status: 204 No Content');
    });
  });
});

describe('substituteRequestVariables — secret-egress policy', () => {
  const nonSecret = (key: string, value: string) => ({ key, value, secret: false });
  const secret = (key: string, value: string) => ({ key, value, secret: true });
  const base = (
    over: Partial<{ url: string; headers: Record<string, string>; body?: string }> = {}
  ) => ({
    url: 'https://api.example.com/x',
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    ...over,
  });

  afterEach(() => {
    delete process.env.HOPPSCOTCH_SECRET_ALLOWED_ORIGINS;
  });

  it('substitutes non-secret variables freely (no allowlist required)', () => {
    const out = substituteRequestVariables(
      base({ url: 'https://api.example.com/{{ver}}/u', headers: { 'X-A': '{{ver}}' } }),
      [nonSecret('ver', 'v2')],
      { requireResolved: true }
    );
    expect(out.url).toBe('https://api.example.com/v2/u');
    expect(out.headers['X-A']).toBe('v2');
  });

  it('substitutes a secret freely when no allowlist is configured (opt-in egress control)', () => {
    const out = substituteRequestVariables(
      base({ headers: { Authorization: 'Bearer {{TOKEN}}' } }),
      [secret('TOKEN', 'super-secret')],
      { requireResolved: true }
    );
    expect(out.headers.Authorization).toBe('Bearer super-secret');
  });

  it('refuses a secret to a non-allowlisted origin once the allowlist is set (enforced)', () => {
    process.env.HOPPSCOTCH_SECRET_ALLOWED_ORIGINS = 'https://allowed.example.com';
    expect(() =>
      substituteRequestVariables(
        base({ headers: { Authorization: 'Bearer {{TOKEN}}' } }), // origin api.example.com not listed
        [secret('TOKEN', 'super-secret')],
        { requireResolved: true }
      )
    ).toThrow(SecretEgressBlockedError);
  });

  it('names the secret key but never leaks its value in the block error', () => {
    process.env.HOPPSCOTCH_SECRET_ALLOWED_ORIGINS = 'https://allowed.example.com';
    try {
      substituteRequestVariables(
        base({ headers: { Authorization: 'Bearer {{TOKEN}}' } }),
        [secret('TOKEN', 'super-secret')],
        { requireResolved: true }
      );
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('TOKEN');
      expect(msg).not.toContain('super-secret');
    }
  });

  it('substitutes a secret when the target origin is operator-allowlisted', () => {
    process.env.HOPPSCOTCH_SECRET_ALLOWED_ORIGINS = 'https://api.example.com';
    const out = substituteRequestVariables(
      base({ headers: { Authorization: 'Bearer {{TOKEN}}' } }),
      [secret('TOKEN', 'super-secret')],
      { requireResolved: true }
    );
    expect(out.headers.Authorization).toBe('Bearer super-secret');
  });

  it('gates a transitively-referenced secret when the allowlist is enforced', () => {
    process.env.HOPPSCOTCH_SECRET_ALLOWED_ORIGINS = 'https://allowed.example.com';
    expect(() =>
      substituteRequestVariables(
        base({ headers: { Authorization: '{{HDR}}' } }),
        [nonSecret('HDR', 'Bearer {{TOKEN}}'), secret('TOKEN', 'super-secret')],
        { requireResolved: true }
      )
    ).toThrow(SecretEgressBlockedError);
  });

  it('rejects an unresolved placeholder when substitution was requested', () => {
    expect(() =>
      substituteRequestVariables(
        base({ url: 'https://api.example.com/{{missing}}' }),
        [],
        { requireResolved: true }
      )
    ).toThrow(UnresolvedPlaceholderError);
  });

  it('leaves an unresolved placeholder literal when no environment was requested', () => {
    const out = substituteRequestVariables(
      base({ url: 'https://api.example.com/{{literal}}' }),
      [],
      { requireResolved: false }
    );
    expect(out.url).toBe('https://api.example.com/{{literal}}');
  });

  it('refuses when a substituted secret changes the effective origin (userinfo bypass)', () => {
    process.env.HOPPSCOTCH_SECRET_ALLOWED_ORIGINS = 'https://api.example.com';
    // Pre-substitution origin is the allowlisted api.example.com (userinfo excluded),
    // but the secret value carries a '/' that flips the effective host to evil.com.
    expect(() =>
      substituteRequestVariables(
        base({ url: 'https://{{TOKEN}}@api.example.com/x' }),
        [secret('TOKEN', 'evil.com/')],
        { requireResolved: true }
      )
    ).toThrow(SecretEgressBlockedError);
  });

  it('returns ONLY actually-substituted secret values, not every env secret (no response over-redaction)', () => {
    // The request references {{USED}} only. An unreferenced secret whose value is a
    // common substring ('a') must NOT be threaded into response scrubbing — otherwise
    // it corrupts ordinary response text (the over-redaction regression).
    const out = substituteRequestVariables(
      base({ headers: { Authorization: 'Bearer {{USED}}' } }),
      [secret('USED', 'super-secret'), secret('UNUSED', 'a')],
      { requireResolved: false }
    );
    expect(out.substitutedSecretValues).toEqual(['super-secret']);
    expect(out.substitutedSecretValues).not.toContain('a');
  });

  it('threads no secrets when the request references none (scrubbing stays inert)', () => {
    const out = substituteRequestVariables(
      base({ url: 'https://api.example.com/public' }),
      [secret('UNUSED', 'a'), nonSecret('ver', 'v2')],
      { requireResolved: false }
    );
    expect(out.substitutedSecretValues).toEqual([]);
  });

  it('captures a secret referenced only transitively through another secret', () => {
    // A={{B}}, B=real: request {{A}} sends B's real value. B's token appears only after
    // A expands, so B is substituted and its value MUST be in the scrub set (a by-key
    // set computed before secret substitution would miss it — the round-1 leak).
    const out = substituteRequestVariables(
      base({ headers: { Authorization: 'Bearer {{A}}' } }),
      [secret('A', '{{B}}'), secret('B', 'chained-actual-secret')],
      { requireResolved: false }
    );
    expect(out.headers.Authorization).toBe('Bearer chained-actual-secret');
    expect(out.substitutedSecretValues).toContain('chained-actual-secret');
  });

  it('captures only the applied value for duplicate secret keys (shadowed duplicate not over-redacted)', () => {
    // The first entry wins the substitution; the shadowed 'x' is never sent, so it must
    // NOT reach scrubbing — else a short/common duplicate corrupts ordinary response text.
    const out = substituteRequestVariables(
      base({ headers: { Authorization: 'Bearer {{DUP}}' } }),
      [secret('DUP', 'applied-secret'), secret('DUP', 'x')],
      { requireResolved: false }
    );
    expect(out.headers.Authorization).toBe('Bearer applied-secret');
    expect(out.substitutedSecretValues).toEqual(['applied-secret']);
    expect(out.substitutedSecretValues).not.toContain('x');
  });

  it('scrubs only the secret span, not surrounding non-secret text', () => {
    const out = substituteRequestVariables(
      base({ headers: { Authorization: 'Bearer {{TOKEN}}' } }),
      [secret('TOKEN', 'abc')],
      { requireResolved: false }
    );
    expect(out.headers.Authorization).toBe('Bearer abc');
    expect(out.substitutedSecretValues).toEqual(['abc']);
    expect(out.substitutedSecretValues).not.toContain('Bearer abc');
  });

  it('captures the composed wire value of a decorated secret chain (no residual leak)', () => {
    // A="prefix{{B}}suffix", B="": the wire receives "prefixsuffix", equal to NO single
    // raw secret value. The provenance mask records the composed span so it is scrubbed.
    const out = substituteRequestVariables(
      base({ headers: { Authorization: '{{A}}' } }),
      [secret('A', 'prefix{{B}}suffix'), secret('B', '')],
      { requireResolved: false }
    );
    expect(out.headers.Authorization).toBe('prefixsuffix');
    expect(out.substitutedSecretValues).toContain('prefixsuffix');
  });

  it('captures a secret token formed across a value/text boundary (no residual leak)', () => {
    // A="x{" then literal "{B}}" combine into "{{B}}", which B (empty) collapses: the
    // wire is "x". Recording raw "x{" would miss it; the mask records the wire span "x".
    const out = substituteRequestVariables(
      base({ headers: { X: '{{A}}{B}}' } }),
      [secret('A', 'x{'), secret('B', '')],
      { requireResolved: false }
    );
    expect(out.headers.X).toBe('x');
    expect(out.substitutedSecretValues).toContain('x');
  });

  it('does not scrub a byte that is not secret-derived on the wire (no new over-redaction)', () => {
    // A="{{B}}{", B="", C="": the whole request collapses to empty. An intermediate "{"
    // must NOT enter the scrub set (recording it would corrupt "{" in ordinary responses).
    const out = substituteRequestVariables(
      base({ headers: { X: '{{A}}{C}}' } }),
      [secret('A', '{{B}}{'), secret('B', ''), secret('C', '')],
      { requireResolved: false }
    );
    expect(out.headers.X).toBe('');
    expect(out.substitutedSecretValues).toEqual([]);
  });

  it('keeps scrubbing a secret whose value equals another secret’s composed wire value', () => {
    // A="p{{B}}q", B="" send "pq"; C="pq" is unreferenced. Narrowing that merely dropped
    // C would stop scrubbing "pq" (a fail-open regression). The mask records "pq" from A.
    const out = substituteRequestVariables(
      base({ headers: { X: '{{A}}' } }),
      [secret('A', 'p{{B}}q'), secret('B', ''), secret('C', 'pq')],
      { requireResolved: false }
    );
    expect(out.headers.X).toBe('pq');
    expect(out.substitutedSecretValues).toContain('pq');
  });
});

describe('redactSecrets', () => {
  it('masks every occurrence of each secret value', () => {
    expect(redactSecrets('token=abc123 and again abc123', ['abc123'])).toBe(
      'token=<redacted> and again <redacted>'
    );
  });

  it('is a no-op with no secrets', () => {
    expect(redactSecrets('nothing here', [])).toBe('nothing here');
  });

  it('also masks the JSON-escaped form of a secret (a quote/backslash-bearing value)', () => {
    const secret = 'a"b\\c';
    const jsonBody = JSON.stringify({ echo: secret }); // {"echo":"a\"b\\c"}
    expect(jsonBody).toContain('a\\"b\\\\c'); // sanity: value is stored in escaped form
    const out = redactSecrets(jsonBody, [secret]);
    expect(out).not.toContain('a\\"b\\\\c'); // the escaped form is caught too
    expect(out).toContain('<redacted>');
  });

  it('also masks the percent-/plus-/query-encoded URL forms of a secret', () => {
    const secret = 'a b/c'; // space + slash → encoded when placed in a URL
    expect(redactSecrets('t=a%20b%2Fc', [secret])).not.toContain('a%20b%2Fc'); // encodeURIComponent form
    expect(redactSecrets('t=a+b%2Fc', [secret])).not.toContain('a+b%2Fc'); // URLSearchParams + form
    expect(redactSecrets('t=a%20b/c', [secret])).not.toContain('a%20b/c'); // WHATWG query form (slash kept)
    expect(redactSecrets('raw a b/c', [secret])).toBe('raw <redacted>'); // raw still caught
  });

  it('masks the shortened wire form of a secret the URL parser stripped', () => {
    // Tab, LF and CR are removed by the parser rather than encoded, so a secret
    // pasted with a trailing newline travels WITHOUT it — and that shortened
    // string, not the raw value, is what a target can echo back. Ask the parser
    // for it rather than stripping by hand, so the expectation cannot drift from
    // what actually goes on the wire.
    const token = 'fixture-newline-token-value\n';
    const wire = new URL(`http://h/?${token}`).search.slice(1);
    expect(wire).toBe('fixture-newline-token-value');
    expect(redactSecrets(`{"key":"${wire}"}`, [token])).toBe('{"key":"<redacted>"}');
    expect(redactSecrets(`raw ${token}`, [token])).toBe('raw <redacted>'); // raw still caught
  });

  it('masks the wire form of a secret that itself contains a literal `%HH`', () => {
    const secret = 'a%2Fb c'; // literal %2F + space → wire form `a%2Fb%20c`
    expect(redactSecrets('q=a%2Fb%20c', [secret])).not.toContain('a%2Fb%20c');
    expect(redactSecrets('raw a%2Fb c', [secret])).toBe('raw <redacted>');
  });

  it('masks the exact URLSearchParams form (e.g. tilde → %7E), not just an approximation', () => {
    const secret = 'a~b c'; // URLSearchParams serializes to `a%7Eb+c`
    expect(redactSecrets('x=a%7Eb+c', [secret])).not.toContain('a%7Eb+c');
    expect(redactSecrets('raw a~b c', [secret])).toBe('raw <redacted>');
  });

  it('does not over-redact on a trailing `#` (query form is skipped, not truncated)', () => {
    const secret = 'abc#';
    expect(redactSecrets('the abc word stays', [secret])).toBe('the abc word stays'); // no bare `abc` variant
    expect(redactSecrets('raw abc#', [secret])).toBe('raw <redacted>');
  });

  it('does not over-redact when the query-form guard would truncate a `#`-bearing secret', () => {
    const secret = 'a#b'; // `?a#b` splits at the fragment → truncated 'a' must NOT become a variant
    expect(redactSecrets('the letter a appears here', [secret])).toBe('the letter a appears here');
    expect(redactSecrets('raw a#b', [secret])).toBe('raw <redacted>'); // raw form still caught
  });
});

describe('redactSecretsClamped — bounded, leak-free redaction', () => {
  it('does not leak a later secret prefix when an earlier redaction contracts output (round-6 regression)', () => {
    const secret = 'ABCDEFGHIJKLMNOPQRST'; // 20 chars
    // The reader buffered cap(20)+margin(20)=40 bytes of a longer body and hit the
    // limit (hitLimit=true): first secret whole, second secret cut at the read edge.
    const buffered = `${secret}x${secret}`.slice(0, 40);
    const { text, clamped } = redactSecretsClamped(buffered, [secret], 20, true);
    expect(text).not.toContain('ABCDE'); // no fragment of the edge-cut second secret
    expect(text).toBe('<redacted>');
    expect(clamped).toBe(true);
  });

  it('redacts a whole secret that straddles the cap but is fully buffered (not over-trimmed)', () => {
    const secret = 'SUPERSECRET'; // 11 chars
    const buffered = `aaaa${secret}`; // fully present (read did not hit the limit)
    const { text } = redactSecretsClamped(buffered, [secret], 10, false);
    expect(text).not.toContain('SUPER');
    expect(text.startsWith('aaaa<red')).toBe(true);
  });

  it('covers a secret whose occurrence begins inside another secret match (overlap merge, round-7 regression)', () => {
    const A = 'A'.repeat(99) + 'X';
    const B = 'X' + 'B'.repeat(99);
    const text = A + 'B'.repeat(99); // B's occurrence starts at the 'X' inside A's match
    const { text: out } = redactSecretsClamped(text, [A, B], 1000, false);
    // Redacting A first must not strand B: merged intervals cover both.
    expect(out).not.toContain('BBBBB');
    expect(out).toBe('<redacted>');
  });

  it('does not drop a shorter secret occurring BEFORE a longer secret (cross-variant order, round-10 regression)', () => {
    // Variants are scanned longest-first, so the LONGER secret's interval is pushed
    // first. The SHORTER secret occurs EARLIER in the text. The old on-the-fly merge
    // compared each new match against intervals[last] across ALL variants — a monotonic
    // assumption that only holds within one variant's walk — so the shorter match at an
    // earlier position was silently discarded (p <= last[1] but end <= last[1]) and leaked.
    const short = 'short-value'; // 11 chars
    const long = 'LONGER-SECRET-VALUE'; // 19 chars
    const text = `${short} prefix xxxxx ${long} suffix`;
    const { text: out } = redactSecretsClamped(text, [long, short], 1000, false);
    expect(out).not.toContain('short-value'); // the earlier, shorter secret must be redacted
    expect(out).not.toContain('LONGER-SECRET-VALUE');
    expect(out).toBe('<redacted> prefix xxxxx <redacted> suffix');
  });

  it('stays bounded against a dense matching secret + many long near-miss variants (round-7 2b regression)', () => {
    const body = 'a'.repeat(50_000);
    // Codex's repro: a 1-char secret that matches EVERY position, plus 50 long
    // near-miss variants. The old indexOf-per-match re-scan was O(V·n²) (~7.9s).
    const secrets = ['a', ...Array.from({ length: 50 }, (_, k) => 'a'.repeat(250 + k) + 'b')];
    const start = performance.now();
    const { text } = redactSecretsClamped(body, secrets, 5_000_000, false);
    const elapsed = performance.now() - start;
    expect(text).toBe('<redacted>'); // every 'a' merges into one interval
    expect(elapsed).toBeLessThan(800);
  });
});

describe('executeRequest — secret scrubbing on the response', () => {
  const originalAllow = process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS;
  const originalMax = process.env.HOPPSCOTCH_MAX_RESPONSE_BYTES;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalAllow === undefined) delete process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS;
    else process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS = originalAllow;
    if (originalMax === undefined) delete process.env.HOPPSCOTCH_MAX_RESPONSE_BYTES;
    else process.env.HOPPSCOTCH_MAX_RESPONSE_BYTES = originalMax;
  });

  const streamOf = (payload: string): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });

  it('scrubs secret values echoed back in a 4xx body and headers', async () => {
    process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS = 'true'; // skip SSRF/DNS in this unit test
    const fetchMock = vi.fn(async () => ({
      status: 401,
      statusText: 'Unauthorized',
      ok: false,
      headers: {
        forEach: (cb: (v: string, k: string) => void) => cb('Bearer super-secret', 'www-authenticate'),
      },
      body: null,
      text: async () => '{"error":"invalid token super-secret"}',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await executeRequest(
      { method: 'GET', url: 'https://api.example.com/x' },
      5000,
      ['super-secret']
    );
    expect(result.body).not.toContain('super-secret');
    expect(result.body).toContain('<redacted>');
    expect(result.headers['www-authenticate']).toBe('Bearer <redacted>');
  });

  it('scrubs a secret echoed in the response statusText', async () => {
    process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS = 'true';
    const fetchMock = vi.fn(async () => ({
      status: 401,
      statusText: 'Unauthorized: super-secret',
      ok: false,
      headers: { forEach: () => {} },
      body: null,
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await executeRequest(
      { method: 'GET', url: 'https://api.example.com/x' },
      5000,
      ['super-secret']
    );
    expect(result.statusText).toBe('Unauthorized: <redacted>');
  });

  it('redacts a secret straddling the byte cap — no partial-prefix leak', async () => {
    process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS = 'true';
    process.env.HOPPSCOTCH_MAX_RESPONSE_BYTES = '10'; // cap lands INSIDE the secret
    const secret = 'SUPERSECRET';
    const payload = `aaaa${secret}`; // cap 10 cuts at 'aaaaSUPERS' — old order would leak 'SUPERS'
    const fetchMock = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: { forEach: () => {} },
      body: streamOf(payload),
      text: async () => payload,
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await executeRequest(
      { method: 'GET', url: 'https://api.example.com/x' },
      5000,
      [secret]
    );
    expect(result.body).not.toContain('SUPER'); // no fragment of the secret survives
    expect(result.body).toContain('<red'); // redaction ran before the clamp
    expect(result.body.length).toBeLessThanOrEqual(10); // clamped to the cap
    expect(result.truncated).toBe(true);
  });

  it('bounds output when redaction would expand a short secret (DoS clamp)', async () => {
    process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS = 'true';
    process.env.HOPPSCOTCH_MAX_RESPONSE_BYTES = '20';
    const payload = 'a'.repeat(1000); // every 'a' would expand to <redacted> (10x) without a clamp
    const fetchMock = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: { forEach: () => {} },
      body: streamOf(payload),
      text: async () => payload,
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await executeRequest(
      { method: 'GET', url: 'https://api.example.com/x' },
      5000,
      ['a']
    );
    // Without the post-redaction clamp this would balloon to ~10000 chars
    // (1000 × the 10-char placeholder). The clamp holds it at the cap.
    expect(result.body.length).toBeLessThanOrEqual(20);
    expect(result.body.startsWith('<redacted>')).toBe(true); // all placeholder, no raw run
    expect(result.truncated).toBe(true);
  });

  it('redacts a JSON-escaped secret straddling the byte cap (byte-length margin)', async () => {
    process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS = 'true';
    process.env.HOPPSCOTCH_MAX_RESPONSE_BYTES = '8'; // cap lands inside the escaped form
    const secret = '"'.repeat(5); // raw is 5 chars; its JSON-escaped form is 10 chars
    const escaped = JSON.stringify(secret).slice(1, -1); // \"\"\"\"\"
    const payload = `aaaa${escaped}`; // escaped secret starts at index 4 — spans past the cap
    const fetchMock = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: { forEach: () => {} },
      body: streamOf(payload),
      text: async () => payload,
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await executeRequest(
      { method: 'GET', url: 'https://api.example.com/x' },
      5000,
      [secret]
    );
    // A char-length margin would under-buffer the 10-char escaped form and leak a
    // `\"` fragment; the byte-length margin over all variants buffers it fully.
    expect(result.body).not.toContain('\\"');
    expect(result.body).toContain('<red');
    expect(result.body.length).toBeLessThanOrEqual(8);
  });

  it('flags truncation when redaction expansion forces a clamp even though the raw body fit the cap', async () => {
    process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS = 'true';
    process.env.HOPPSCOTCH_MAX_RESPONSE_BYTES = '8';
    const payload = 'aXa'; // 3 bytes < cap, but 'X' → <redacted> expands it to 12 > cap
    const fetchMock = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: { forEach: () => {} },
      body: streamOf(payload),
      text: async () => payload,
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await executeRequest(
      { method: 'GET', url: 'https://api.example.com/x' },
      5000,
      ['X']
    );
    // The raw body fit the cap (not truncated), but redaction expanded it past the
    // cap and the clamp cut it — so `truncated` must still be honest.
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(8);
    expect(result.body).not.toContain('X'); // the secret is gone
  });
});

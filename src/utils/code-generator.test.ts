import { describe, it, expect } from 'vitest';
import { generateCode, generateDocumentation } from './code-generator.js';
import type { RequestDefinition } from './request-executor.js';

describe('code-generator', () => {
  describe('generateCode - curl', () => {
    it('should generate GET request', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
      };

      const code = generateCode(request, 'curl');

      expect(code).toContain('curl');
      expect(code).toContain('https://api.example.com/users');
    });

    it('should generate POST request with body and headers', () => {
      const request: RequestDefinition = {
        method: 'POST',
        url: 'https://api.example.com/users',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"John"}',
      };

      const code = generateCode(request, 'curl');

      expect(code).toContain('-X POST');
      expect(code).toContain("-H 'Content-Type: application/json'");
      expect(code).toContain('-d ');
    });

    it('should add bearer authentication', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'bearer', token: 'abc123' },
      };

      const code = generateCode(request, 'curl', { redactCredentials: false });

      expect(code).toContain("-H 'Authorization: Bearer abc123'");
    });

    it('should use -u for basic auth', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'basic', username: 'user', password: 'pass' },
      };

      const code = generateCode(request, 'curl', { redactCredentials: false });

      expect(code).toContain("-u 'user:pass'");
    });
  });

  describe('generateCode - javascript', () => {
    it('should generate fetch code', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
      };

      const code = generateCode(request, 'javascript');

      expect(code).toContain('const response = await fetch(');
      expect(code).toContain('https://api.example.com/users');
      expect(code).toContain("method: 'GET'");
    });

    it('should include headers and body for POST', () => {
      const request: RequestDefinition = {
        method: 'POST',
        url: 'https://api.example.com/users',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"John"}',
      };

      const code = generateCode(request, 'javascript');

      expect(code).toContain("method: 'POST'");
      expect(code).toContain('headers: {');
      expect(code).toContain('body:');
    });
  });

  describe('generateCode - python', () => {
    it('should generate requests code', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
      };

      const code = generateCode(request, 'python');

      expect(code).toContain('import requests');
      expect(code).toContain("url = 'https://api.example.com/users'");
      expect(code).toContain('requests.request');
    });
  });

  describe('generateCode - go', () => {
    it('should generate http.NewRequest code', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
      };

      const code = generateCode(request, 'go');

      expect(code).toContain('package main');
      expect(code).toContain('"net/http"');
      expect(code).toContain('http.NewRequest');
    });

    it('should emit SetBasicAuth for basic auth (regression: was silently dropped)', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'basic', username: 'user', password: 'pass' },
      };

      const code = generateCode(request, 'go', { redactCredentials: false });

      expect(code).toContain('req.SetBasicAuth("user", "pass")');
    });
  });

  describe('generateCode - rust', () => {
    it('should generate reqwest code', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
      };

      const code = generateCode(request, 'rust');

      expect(code).toContain('use reqwest');
      expect(code).toContain('#[tokio::main]');
      expect(code).toContain('.get(');
    });

    it('should emit .basic_auth for basic auth (regression: was silently dropped)', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'basic', username: 'user', password: 'pass' },
      };

      const code = generateCode(request, 'rust', { redactCredentials: false });

      expect(code).toContain('.basic_auth("user", Some("pass"))');
    });

    it('should route OPTIONS through the generic builder (regression: client.options() does not exist in reqwest)', () => {
      const request: RequestDefinition = {
        method: 'OPTIONS',
        url: 'https://api.example.com/users',
      };

      const code = generateCode(request, 'rust');

      expect(code).toContain('client.request(reqwest::Method::OPTIONS, ');
      expect(code).not.toContain('client.options(');
    });
  });

  describe('generateCode — accepted-input regressions', () => {
    it('should emit --head for HEAD (regression: -X HEAD hangs waiting for a body)', () => {
      const request: RequestDefinition = {
        method: 'HEAD',
        url: 'https://api.example.com/users',
      };

      const code = generateCode(request, 'curl');

      expect(code).toContain('--head');
      expect(code).not.toContain('-X HEAD');
    });

    it('should keep basic auth with an empty password (Stripe-style key-as-username), defined and used together', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
        auth: { type: 'basic', username: 'api-key', password: '' },
      };

      const python = generateCode(request, 'python', { redactCredentials: false });
      expect(python).toContain("auth = ('api-key', '')");
      expect(python).toContain('auth=auth');

      expect(generateCode(request, 'curl', { redactCredentials: false })).toContain(
        "-u 'api-key:'"
      );
      expect(generateCode(request, 'javascript', { redactCredentials: false })).toContain(
        `Basic ${Buffer.from('api-key:').toString('base64')}`
      );
      expect(generateCode(request, 'go', { redactCredentials: false })).toContain(
        'req.SetBasicAuth("api-key", "")'
      );
      expect(generateCode(request, 'rust', { redactCredentials: false })).toContain(
        '.basic_auth("api-key", Some(""))'
      );
    });

    it('should drop the body from GET and HEAD snippets, mirroring the executor', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
        body: '{"ignored": true}',
      };

      expect(generateCode(request, 'curl')).not.toContain('-d ');
      expect(generateCode(request, 'javascript')).not.toContain('body:');
      expect(generateCode(request, 'python')).not.toContain('data=data');
      expect(generateCode(request, 'go')).toContain('var payload []byte');
      expect(generateCode(request, 'rust')).not.toContain('.body(');

      const post: RequestDefinition = { ...request, method: 'POST' };
      expect(generateCode(post, 'curl')).toContain('-d ');
    });

    it('should print the response body body-safely in javascript and python (regression: HEAD/204 blew up response.json())', () => {
      const request: RequestDefinition = {
        method: 'HEAD',
        url: 'https://api.example.com/users',
      };

      expect(generateCode(request, 'javascript')).toContain('response.text()');
      expect(generateCode(request, 'javascript')).not.toContain('response.json()');
      expect(generateCode(request, 'python')).toContain('response.text');
      expect(generateCode(request, 'python')).not.toContain('response.json()');
    });
  });

  describe('generateCode — credential redaction (opt-in redactCredentials:true)', () => {
    const redact = { redactCredentials: true } as const;

    it('emits live credentials by DEFAULT (backwards-compatible, runnable snippet)', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'bearer', token: 'live-bearer-secret' },
      };
      const code = generateCode(request, 'curl');
      expect(code).toContain('live-bearer-secret');
    });

    it('curl: masks a bearer token when opted in', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'bearer', token: 'live-bearer-secret' },
      };
      const code = generateCode(request, 'curl', redact);
      expect(code).not.toContain('live-bearer-secret');
      expect(code).toContain('<BEARER_TOKEN>');
    });

    it('curl: masks the basic-auth password but keeps the username', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'basic', username: 'demo-user', password: 'live-basic-secret' },
      };
      const code = generateCode(request, 'curl', redact);
      expect(code).not.toContain('live-basic-secret');
      expect(code).toContain('<PASSWORD>');
      expect(code).toContain('demo-user');
    });

    it('masks an api-key value in both header and query placements', () => {
      const header = generateCode(
        {
          method: 'GET',
          url: 'https://api.example.com/u',
          auth: { type: 'api-key', key: 'X-API-Key', value: 'live-key-secret', addTo: 'header' },
        },
        'curl',
        redact
      );
      expect(header).not.toContain('live-key-secret');
      expect(header).toContain('<API_KEY>');

      const query = generateCode(
        {
          method: 'GET',
          url: 'https://api.example.com/u',
          auth: { type: 'api-key', key: 'api_key', value: 'live-key-secret', addTo: 'query' },
        },
        'curl',
        redact
      );
      expect(query).not.toContain('live-key-secret');
      expect(query).toMatch(/api_key=/);
    });

    it('masks a sensitive raw header and a secret URL query param', () => {
      const code = generateCode(
        {
          method: 'GET',
          url: 'https://api.example.com/u?access_token=live-qs-secret&page=2',
          headers: { Authorization: 'Bearer live-hdr-secret', 'X-Trace-Id': 'keep-me' },
        },
        'curl',
        redact
      );
      expect(code).not.toContain('live-qs-secret');
      expect(code).not.toContain('live-hdr-secret');
      expect(code).toContain('<redacted>'); // sensitive raw header masked
      expect(code).toContain('keep-me'); // non-sensitive header preserved
      expect(code).toContain('page=2'); // non-sensitive query preserved
    });

    it('masks HTTP basic-auth credentials embedded in the URL', () => {
      const code = generateCode(
        { method: 'GET', url: 'https://admin:s3cr3t-pw@api.example.com/data?page=2' },
        'curl',
        redact
      );
      expect(code).not.toContain('s3cr3t-pw');
      expect(code).not.toContain('admin:');
      expect(code).toContain('api.example.com'); // host preserved
      expect(code).toContain('page=2'); // non-sensitive query preserved
    });

    it('masks a non-standard api-key header and a private_key body field', () => {
      const code = generateCode(
        {
          method: 'POST',
          url: 'https://api.example.com/x',
          headers: { 'X-ApiKey': 'header-live-secret' },
          body: JSON.stringify({ private_key: 'body-live-secret', note: 'keep' }),
        },
        'curl',
        redact
      );
      expect(code).not.toContain('header-live-secret');
      expect(code).not.toContain('body-live-secret');
      expect(code).toContain('<redacted>');
      expect(code).toContain('keep'); // non-sensitive field preserved
    });

    it('masks Azure APIM / Functions credential headers', () => {
      const code = generateCode(
        {
          method: 'GET',
          url: 'https://api.example.com/x',
          headers: {
            'Ocp-Apim-Subscription-Key': 'apim-live-secret',
            'X-Functions-Key': 'func-live-secret',
          },
        },
        'curl',
        redact
      );
      expect(code).not.toContain('apim-live-secret');
      expect(code).not.toContain('func-live-secret');
      expect(code).toContain('<redacted>');
    });
  });

  describe('generateDocumentation', () => {
    it('should generate basic documentation', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
      };

      const doc = generateDocumentation(request, { title: 'Get Users' });

      expect(doc).toContain('# Get Users');
      expect(doc).toContain('## Request');
      expect(doc).toContain('GET https://api.example.com/users');
    });

    it('should include description when provided', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
      };

      const doc = generateDocumentation(request, {
        title: 'Get Users',
        description: 'Retrieve list of users',
      });

      expect(doc).toContain('Retrieve list of users');
    });

    it('should include headers table', () => {
      const request: RequestDefinition = {
        method: 'POST',
        url: 'https://api.example.com/users',
        headers: { 'Content-Type': 'application/json' },
      };

      const doc = generateDocumentation(request, { title: 'Create User' });

      expect(doc).toContain('### Headers');
      expect(doc).toContain('Content-Type');
    });

    it('should include authentication info', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'bearer', token: 'abc123' },
      };

      const doc = generateDocumentation(request, { title: 'Protected' });

      expect(doc).toContain('### Authentication');
      expect(doc).toContain('bearer');
    });

    it('should include request body', () => {
      const request: RequestDefinition = {
        method: 'POST',
        url: 'https://api.example.com/users',
        body: '{"name":"John"}',
      };

      const doc = generateDocumentation(request, { title: 'Create User' });

      expect(doc).toContain('### Request Body');
    });

    it('should include code examples when requested', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/users',
      };

      const doc = generateDocumentation(request, {
        title: 'Get Users',
        includeExamples: true,
      });

      expect(doc).toContain('## Examples');
      expect(doc).toContain('### cURL');
      expect(doc).toContain('### JavaScript');
      expect(doc).toContain('### Python');
    });

    it('masks bearer credentials in examples by default (share-oriented artifact)', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'bearer', token: 'super-secret-token' },
      };

      const doc = generateDocumentation(request, { includeExamples: true });

      expect(doc).not.toContain('super-secret-token');
      expect(doc).toContain('<BEARER_TOKEN>');
    });

    it('emits live credentials only when redactCredentials is explicitly false', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'bearer', token: 'super-secret-token' },
      };

      const doc = generateDocumentation(request, {
        includeExamples: true,
        redactCredentials: false,
      });

      expect(doc).toContain('super-secret-token');
    });

    it('masks the basic-auth password but keeps the username', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/protected',
        auth: { type: 'basic', username: 'demo-user', password: 'super-secret-pass' },
      };

      const doc = generateDocumentation(request, { includeExamples: true });

      expect(doc).not.toContain('super-secret-pass');
      expect(doc).toContain('<PASSWORD>');
      expect(doc).toContain('demo-user');
    });

    it('masks credential-bearing raw headers by default, keeps non-sensitive ones', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/x',
        headers: { Authorization: 'Bearer raw-header-secret', 'X-Trace-Id': 'keep-me' },
      };

      const doc = generateDocumentation(request, { includeExamples: true });

      expect(doc).not.toContain('raw-header-secret');
      expect(doc).toContain('<redacted>');
      expect(doc).toContain('keep-me');
    });

    it('masks OAuth-style query credentials (client_secret / refresh_token / access_token, any case), keeps non-sensitive', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/x?client_secret=cs-leak&Refresh_Token=rt-leak&access_token=at-leak&api_key=ak-leak&page=2',
      };

      const doc = generateDocumentation(request, { includeExamples: true });

      expect(doc).not.toContain('cs-leak');
      expect(doc).not.toContain('rt-leak');
      expect(doc).not.toContain('at-leak');
      expect(doc).not.toContain('ak-leak');
      expect(doc).toContain('page=2');
    });

    it('leaves raw headers and query params intact when redactCredentials is false', () => {
      const request: RequestDefinition = {
        method: 'GET',
        url: 'https://api.example.com/x?api_key=query-secret',
        headers: { Authorization: 'Bearer raw-header-secret' },
      };

      const doc = generateDocumentation(request, {
        includeExamples: true,
        redactCredentials: false,
      });

      expect(doc).toContain('raw-header-secret');
      expect(doc).toContain('query-secret');
    });

    it('masks credential fields inside a JSON body (incl. nested) by default, keeps non-sensitive', () => {
      const request: RequestDefinition = {
        method: 'POST',
        url: 'https://auth.example.com/token',
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_secret: 'json-secret-leak',
          nested: { refresh_token: 'nested-token-leak' },
        }),
      };

      const doc = generateDocumentation(request, { includeExamples: true });

      // Body section AND the cURL/JS/Python examples all derive from the redacted view.
      expect(doc).not.toContain('json-secret-leak');
      expect(doc).not.toContain('nested-token-leak');
      expect(doc).toContain('<redacted>');
      expect(doc).toContain('client_credentials'); // non-sensitive value preserved
    });

    it('masks credentials in a form-urlencoded body (OAuth token request) by default', () => {
      const request: RequestDefinition = {
        method: 'POST',
        url: 'https://auth.example.com/token',
        body: 'grant_type=password&username=demo-user&password=form-pass-leak&client_secret=form-cs-leak',
      };

      const doc = generateDocumentation(request, { includeExamples: true });

      expect(doc).not.toContain('form-pass-leak');
      expect(doc).not.toContain('form-cs-leak');
      expect(doc).toContain('demo-user'); // non-sensitive value preserved
    });

    it('emits live body credentials only when redactCredentials is explicitly false', () => {
      const request: RequestDefinition = {
        method: 'POST',
        url: 'https://auth.example.com/token',
        body: JSON.stringify({ client_secret: 'json-secret-leak' }),
      };

      const doc = generateDocumentation(request, {
        includeExamples: true,
        redactCredentials: false,
      });

      expect(doc).toContain('json-secret-leak');
    });

    it('masks private_key_jwt (client_assertion) and PKCE (code_verifier) body credentials', () => {
      const request: RequestDefinition = {
        method: 'POST',
        url: 'https://auth.example.com/token',
        body:
          'grant_type=authorization_code' +
          '&client_assertion=eyJhbGci-assertion-leak' +
          '&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer' +
          '&code_verifier=pkce-verifier-leak',
      };

      const doc = generateDocumentation(request, { includeExamples: true });

      expect(doc).not.toContain('assertion-leak');
      expect(doc).not.toContain('pkce-verifier-leak');
      expect(doc).toContain('authorization_code'); // non-sensitive value preserved
    });
  });

  describe('api-key auth — addTo placement', () => {
    const baseHeader: RequestDefinition = {
      method: 'GET',
      url: 'https://api.example.com/users',
      auth: { type: 'api-key', key: 'X-API-Key', value: 'secret', addTo: 'header' },
    };
    const baseQuery: RequestDefinition = {
      method: 'GET',
      url: 'https://api.example.com/users',
      auth: { type: 'api-key', key: 'api_key', value: 'secret', addTo: 'query' },
    };

    for (const lang of ['curl', 'javascript', 'python', 'go', 'rust'] as const) {
      it(`${lang}: addTo=header injects the api key as a header, not a query param`, () => {
        const code = generateCode(baseHeader, lang, { redactCredentials: false });
        expect(code).toContain('X-API-Key');
        expect(code).toContain('secret');
        expect(code).not.toContain('?X-API-Key=');
      });

      it(`${lang}: addTo=query bakes api_key=secret into the URL`, () => {
        const code = generateCode(baseQuery, lang, { redactCredentials: false });
        // URL is rewritten before being embedded in the generated snippet.
        expect(code).toMatch(/api\.example\.com\/users\?api_key=secret/);
        // And it isn't ALSO added as a header.
        expect(code).not.toMatch(/['"]api_key['"]\s*[:,]\s*['"]secret['"]/);
      });
    }
  });

  describe('escaping — no quote breakout / shell injection', () => {
    // A value crafted to break each target's quoting context if interpolated
    // raw: a single quote (shell / JS / Python) and a double quote (Go / Rust),
    // plus a shell-command-injection attempt.
    const NASTY = `a'; rm -rf /; echo "x`;
    const nastyHeader: RequestDefinition = {
      method: 'POST',
      url: 'https://api.example.com/v1',
      headers: { 'X-Test': NASTY },
    };

    it("curl: single quotes escaped as POSIX '\\'', no bare breakout", () => {
      const code = generateCode(nastyHeader, 'curl');
      expect(code).toContain(`'\\''`);
      // Raw breakout would emit `a'; rm` (quote closes the token); the safe
      // form emits `a'\''; rm` (quote escaped, payload stays inside the token).
      expect(code).not.toContain(`a'; rm`);
    });

    it('curl: bearer token and URL are escaped single-quoted tokens', () => {
      const code = generateCode(
        {
          method: 'GET',
          url: `https://x.test/'; touch pwned`,
          auth: { type: 'bearer', token: `t'oken` },
        },
        'curl',
        { redactCredentials: false }
      );
      // Raw breakout would emit `/'; touch pwned`; safe form emits `/'\''; …`.
      expect(code).not.toContain(`/'; touch pwned`);
      expect(code).toContain(`'\\''`);
    });

    it('javascript: a multiline body becomes a valid single-line literal', () => {
      const code = generateCode(
        { method: 'POST', url: 'https://x.test', body: 'line1\nline2' },
        'javascript'
      );
      expect(code).toContain('line1\\nline2');
    });

    it('python: single quotes escaped in headers and basic-auth', () => {
      const code = generateCode(
        {
          method: 'GET',
          url: 'https://x.test',
          headers: { 'X-Test': NASTY },
          auth: { type: 'basic', username: `u'`, password: `p'` },
        },
        'python',
        { redactCredentials: false }
      );
      expect(code).toContain(`\\'`);
    });

    it('go: double quotes/backslashes escaped, body uses interpreted string (no raw backtick)', () => {
      const code = generateCode(
        { method: 'POST', url: 'https://x.test', body: 'has "quote" and \\ slash' },
        'go'
      );
      expect(code).toContain('\\"');
      expect(code).toContain('\\\\');
      expect(code).not.toContain('`');
    });

    it('rust: double quotes escaped in url and headers', () => {
      const code = generateCode(
        { method: 'GET', url: `https://x.test/"q`, headers: { 'X-Test': NASTY } },
        'rust'
      );
      expect(code).toContain('\\"');
    });

    it('every language: the raw NASTY string never survives unescaped', () => {
      for (const lang of ['curl', 'javascript', 'python', 'go', 'rust'] as const) {
        expect(generateCode(nastyHeader, lang), lang).not.toContain(NASTY);
      }
    });
  });
});

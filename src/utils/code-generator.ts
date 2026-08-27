/**
 * Code generation utilities for API requests
 */

import type { RequestDefinition } from './request-executor.js';

export type CodeLanguage = 'curl' | 'javascript' | 'python' | 'go' | 'rust';

// --- Escaping helpers -------------------------------------------------------
// Every value interpolated into a generated snippet (URL, header key/value,
// inline credentials, body) must be escaped for its target's quoting context,
// otherwise a quote or metacharacter in the request data breaks the emitted
// code, or injects into it. The body was already escaped per-language; these
// extend the same treatment to the values that were previously interpolated
// raw.

/** POSIX shell: emit as a single-quoted token, escaping embedded single quotes. */
function shToken(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Inner content of a single-quoted source literal (JS / Python). */
function sq(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** Inner content of a double-quoted source literal (Go / Rust). */
function dq(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** Markdown table cell: keep a pipe or newline from breaking the table row. */
function mdCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Resolve api-key auth placement so each codegen target sees the same view:
 * either a header to inject, or a URL with the key=value baked into the query
 * string. Keeps the addTo='query' branch consistent across all 5 languages.
 */
function resolveApiKeyPlacement(request: RequestDefinition): {
  url: string;
  apiKeyHeader: { key: string; value: string } | null;
} {
  const auth = request.auth;
  if (auth?.type !== 'api-key' || !auth.key || !auth.value) {
    return { url: request.url, apiKeyHeader: null };
  }
  const addTo = auth.addTo ?? 'header';
  if (addTo === 'query') {
    const u = new URL(request.url);
    u.searchParams.set(auth.key, auth.value);
    return { url: u.toString(), apiKeyHeader: null };
  }
  return { url: request.url, apiKeyHeader: { key: auth.key, value: auth.value } };
}

/**
 * Generate cURL command from request
 */
function generateCurl(request: RequestDefinition): string {
  const parts: string[] = ['curl'];

  if (request.method !== 'GET') {
    parts.push(`-X ${request.method}`);
  }

  if (request.headers) {
    for (const [key, value] of Object.entries(request.headers)) {
      parts.push(`-H ${shToken(`${key}: ${value}`)}`);
    }
  }

  const { url, apiKeyHeader } = resolveApiKeyPlacement(request);

  if (request.auth) {
    if (request.auth.type === 'bearer' && request.auth.token) {
      parts.push(`-H ${shToken(`Authorization: Bearer ${request.auth.token}`)}`);
    } else if (request.auth.type === 'basic' && request.auth.username && request.auth.password) {
      parts.push(`-u ${shToken(`${request.auth.username}:${request.auth.password}`)}`);
    } else if (apiKeyHeader) {
      parts.push(`-H ${shToken(`${apiKeyHeader.key}: ${apiKeyHeader.value}`)}`);
    }
  }

  if (request.body) {
    parts.push(`-d ${shToken(request.body)}`);
  }

  parts.push(shToken(url));

  return parts.join(' \\\n  ');
}

/**
 * Generate JavaScript fetch code from request
 */
function generateJavaScript(request: RequestDefinition): string {
  const lines: string[] = [];
  const { url, apiKeyHeader } = resolveApiKeyPlacement(request);

  lines.push('const response = await fetch(');
  lines.push(`  '${sq(url)}',`);
  lines.push('  {');
  lines.push(`    method: '${sq(request.method)}',`);

  const headers: Record<string, string> = { ...request.headers };

  if (request.auth) {
    if (request.auth.type === 'bearer' && request.auth.token) {
      headers['Authorization'] = `Bearer ${request.auth.token}`;
    } else if (request.auth.type === 'basic' && request.auth.username && request.auth.password) {
      const credentials = Buffer.from(`${request.auth.username}:${request.auth.password}`).toString(
        'base64'
      );
      headers['Authorization'] = `Basic ${credentials}`;
    } else if (apiKeyHeader) {
      headers[apiKeyHeader.key] = apiKeyHeader.value;
    }
  }

  if (Object.keys(headers).length > 0) {
    lines.push('    headers: {');
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`      '${sq(key)}': '${sq(value)}',`);
    }
    lines.push('    },');
  }

  if (request.body) {
    lines.push(`    body: '${sq(request.body)}',`);
  }

  lines.push('  }');
  lines.push(');');
  lines.push('');
  lines.push('const data = await response.json();');
  lines.push('console.log(data);');

  return lines.join('\n');
}

/**
 * Generate Python requests code from request
 */
function generatePython(request: RequestDefinition): string {
  const lines: string[] = [];

  lines.push('import requests');
  lines.push('');

  const { url, apiKeyHeader } = resolveApiKeyPlacement(request);
  lines.push(`url = '${sq(url)}'`);

  const headers: Record<string, string> = { ...request.headers };

  if (request.auth) {
    if (request.auth.type === 'bearer' && request.auth.token) {
      headers['Authorization'] = `Bearer ${request.auth.token}`;
    } else if (apiKeyHeader) {
      headers[apiKeyHeader.key] = apiKeyHeader.value;
    }
  }

  if (Object.keys(headers).length > 0) {
    lines.push('headers = {');
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`    '${sq(key)}': '${sq(value)}',`);
    }
    lines.push('}');
  }

  if (request.auth?.type === 'basic' && request.auth.username && request.auth.password) {
    lines.push(`auth = ('${sq(request.auth.username)}', '${sq(request.auth.password)}')`);
  }

  if (request.body) {
    lines.push(`data = '${sq(request.body)}'`);
  }

  lines.push('');
  const requestParts: string[] = [`'${sq(request.method.toLowerCase())}'`, 'url'];

  if (Object.keys(headers).length > 0) {
    requestParts.push('headers=headers');
  }
  if (request.auth?.type === 'basic') {
    requestParts.push('auth=auth');
  }
  if (request.body) {
    requestParts.push('data=data');
  }

  lines.push(`response = requests.request(${requestParts.join(', ')})`);
  lines.push('');
  lines.push('print(response.status_code)');
  lines.push('print(response.json())');

  return lines.join('\n');
}

/**
 * Generate Go code from request
 */
function generateGo(request: RequestDefinition): string {
  const lines: string[] = [];
  const { url, apiKeyHeader } = resolveApiKeyPlacement(request);

  lines.push('package main');
  lines.push('');
  lines.push('import (');
  lines.push('\t"bytes"');
  lines.push('\t"fmt"');
  lines.push('\t"io"');
  lines.push('\t"net/http"');
  lines.push(')');
  lines.push('');
  lines.push('func main() {');

  if (request.body) {
    // Interpreted ("...") string literal: a raw (`...`) literal can't carry an
    // embedded backtick, and dq() escapes quotes/backslashes/newlines safely.
    lines.push(`\tpayload := []byte("${dq(request.body)}")`);
  } else {
    lines.push('\tvar payload []byte');
  }

  lines.push('');
  lines.push(
    `\treq, err := http.NewRequest("${dq(request.method)}", "${dq(url)}", bytes.NewBuffer(payload))`
  );
  lines.push('\tif err != nil {');
  lines.push('\t\tpanic(err)');
  lines.push('\t}');

  const headers: Record<string, string> = { ...request.headers };
  let basicAuth: { username: string; password: string } | null = null;

  if (request.auth) {
    if (request.auth.type === 'bearer' && request.auth.token) {
      headers['Authorization'] = `Bearer ${request.auth.token}`;
    } else if (request.auth.type === 'basic' && request.auth.username && request.auth.password) {
      basicAuth = { username: request.auth.username, password: request.auth.password };
    } else if (apiKeyHeader) {
      headers[apiKeyHeader.key] = apiKeyHeader.value;
    }
  }

  if (Object.keys(headers).length > 0) {
    lines.push('');
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`\treq.Header.Set("${dq(key)}", "${dq(value)}")`);
    }
  }

  if (basicAuth) {
    lines.push(`\treq.SetBasicAuth("${dq(basicAuth.username)}", "${dq(basicAuth.password)}")`);
  }

  lines.push('');
  lines.push('\tclient := &http.Client{}');
  lines.push('\tresp, err := client.Do(req)');
  lines.push('\tif err != nil {');
  lines.push('\t\tpanic(err)');
  lines.push('\t}');
  lines.push('\tdefer resp.Body.Close()');
  lines.push('');
  lines.push('\tbody, _ := io.ReadAll(resp.Body)');
  lines.push('\tfmt.Println(resp.StatusCode)');
  lines.push('\tfmt.Println(string(body))');
  lines.push('}');

  return lines.join('\n');
}

/**
 * Generate Rust code from request
 */
function generateRust(request: RequestDefinition): string {
  const lines: string[] = [];
  const { url, apiKeyHeader } = resolveApiKeyPlacement(request);

  lines.push('use reqwest;');
  lines.push('use std::collections::HashMap;');
  lines.push('');
  lines.push('#[tokio::main]');
  lines.push('async fn main() -> Result<(), Box<dyn std::error::Error>> {');

  lines.push('    let client = reqwest::Client::new();');
  lines.push('');

  // reqwest's Client has no `options()` convenience method, so OPTIONS goes
  // through the generic request builder.
  const opener =
    request.method === 'OPTIONS'
      ? `client.request(reqwest::Method::OPTIONS, "${dq(url)}")`
      : `client.${request.method.toLowerCase()}("${dq(url)}")`;
  lines.push(`    let mut request = ${opener}`);

  const headers: Record<string, string> = { ...request.headers };

  if (request.auth) {
    if (request.auth.type === 'bearer' && request.auth.token) {
      headers['Authorization'] = `Bearer ${request.auth.token}`;
    } else if (apiKeyHeader) {
      headers[apiKeyHeader.key] = apiKeyHeader.value;
    }
  }

  for (const [key, value] of Object.entries(headers)) {
    lines.push(`        .header("${dq(key)}", "${dq(value)}")`);
  }

  // reqwest's RequestBuilder.basic_auth(username, Some(password)) sets the
  // Authorization header; mirror curl/JS/Python which all support basic auth.
  if (request.auth?.type === 'basic' && request.auth.username && request.auth.password) {
    lines.push(
      `        .basic_auth("${dq(request.auth.username)}", Some("${dq(request.auth.password)}"))`
    );
  }

  if (request.body) {
    lines.push(`        .body("${dq(request.body)}")`);
  }

  lines.push('        .build()?;');
  lines.push('');

  lines.push('    let response = client.execute(request).await?;');
  lines.push('    let status = response.status();');
  lines.push('    let body = response.text().await?;');
  lines.push('');
  lines.push('    println!("Status: {}", status);');
  lines.push('    println!("Body: {}", body);');
  lines.push('');
  lines.push('    Ok(())');
  lines.push('}');

  return lines.join('\n');
}

/**
 * Generate code snippet for a request in the specified language
 */
export function generateCode(
  request: RequestDefinition,
  language: CodeLanguage,
  options: {
    /**
     * Mask credential values (structured bearer/basic/api-key auth, sensitive
     * raw headers, secret URL query params, and secret body fields) in the
     * emitted snippet. Default false, so generate_code returns a copy-paste-runnable
     * snippet with live values, matching the tool's original behaviour. Pass true
     * to mask credentials when the snippet will be shared.
     */
    redactCredentials?: boolean;
  } = {}
): string {
  const req = options.redactCredentials === true ? redactRequestForDocs(request) : request;
  switch (language) {
    case 'curl':
      return generateCurl(req);
    case 'javascript':
      return generateJavaScript(req);
    case 'python':
      return generatePython(req);
    case 'go':
      return generateGo(req);
    case 'rust':
      return generateRust(req);
    default:
      throw new Error(`Unsupported language: ${language}`);
  }
}

/**
 * Return a copy of the request with credential values replaced by placeholders.
 * Used for documentation examples, which are share-oriented (wikis, READMEs,
 * chat), where reproducing a live bearer/basic/api-key value verbatim would leak it.
 * The username (basic) and header/key name (api-key) are kept as they are not
 * secrets; only the secret half is masked.
 */
function redactRequestAuth(request: RequestDefinition): RequestDefinition {
  if (!request.auth) return request;
  const auth = { ...request.auth };
  if (auth.type === 'bearer' && auth.token) auth.token = '<BEARER_TOKEN>';
  if (auth.type === 'basic' && auth.password) auth.password = '<PASSWORD>';
  if (auth.type === 'api-key' && auth.value) auth.value = '<API_KEY>';
  return { ...request, auth };
}

/** Header names whose value is a credential and must be masked in shared docs. */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-amz-security-token',
]);

/**
 * True if a header name carries a credential: the base set plus high-signal
 * substrings, so compound names like `X-Auth-Token` / `X-Refresh-Token` are
 * caught too. Bare `key` is intentionally NOT matched (would mask
 * `Idempotency-Key` etc.).
 */
function isSensitiveHeader(name: string): boolean {
  const n = name.toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(n) ||
    n.includes('authorization') ||
    n.includes('token') ||
    n.includes('secret') ||
    n.includes('password') ||
    n.includes('apikey') ||
    n.includes('api-key') ||
    n.includes('api_key') ||
    n.includes('subscription-key') || // Azure APIM: Ocp-Apim-Subscription-Key
    n.includes('functions-key') // Azure Functions: X-Functions-Key
  );
}

/**
 * True if a param/field name commonly carries a credential. Substring-matched
 * and deliberately biased to over-mask: the doc is a share-oriented artifact, so
 * masking a stray `*_token` field is harmless, whereas leaking a `client_secret`
 * / `refresh_token` / `access_token` is not. Covers the OAuth credential params
 * an exact-match list misses. Used for both URL query params and request-body
 * field names (JSON keys, form-urlencoded params).
 */
function isSensitiveParamName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes('secret') || // secret, client_secret, app_secret
    n.includes('password') ||
    n.includes('passwd') ||
    n.includes('token') || // token, access_token, refresh_token, id_token, session_token, auth_token
    n.includes('signature') ||
    n.includes('credential') ||
    n.includes('apikey') ||
    n.includes('api_key') ||
    n.includes('api-key') ||
    n.includes('assertion') || // client_assertion (private_key_jwt client auth)
    n.includes('verifier') || // code_verifier (PKCE secret)
    n.includes('private') || // private_key / privatekey
    n.includes('authorization') || // authorization_code (OAuth)
    n === 'key' ||
    n === 'pwd' ||
    n === 'sig' ||
    n === 'auth'
  );
}

/** Mask the values of credential-bearing query params in a URL (best-effort). */
function redactUrlQuery(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    // Basic-auth credentials embedded in the URL authority (`user:pass@host`) are
    // a structured credential location, so strip them like the structured auth
    // object. URL.origin excludes userinfo, so leaving it would leak a live
    // password into the generated snippet (curl turns it into `Authorization:
    // Basic …`).
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      changed = true;
    }
    for (const key of [...u.searchParams.keys()]) {
      if (isSensitiveParamName(key)) {
        u.searchParams.set(key, '<redacted>');
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url; // not a parseable absolute URL, leave untouched
  }
}

/** Recursively mask the values of credential-bearing keys in a parsed JSON value. */
function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveParamName(k) ? '<redacted>' : redactJsonValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Best-effort masking of credential values inside a request body. Targets the
 * two body shapes that commonly carry secrets and whose fields are reliably
 * keyed: JSON objects and `application/x-www-form-urlencoded` (e.g. OAuth token
 * requests: `grant_type=…&client_secret=…`). Anything else (XML, plain text,
 * multipart, binary) is left untouched: there's no reliable way to target a
 * secret in it without risking mangling the body, and over-masking arbitrary
 * text would corrupt the doc.
 */
function redactRequestBody(body: string): string {
  // JSON object/array: recursively mask sensitive keys at any depth.
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      return JSON.stringify(redactJsonValue(parsed));
    }
  } catch {
    /* not JSON, fall through to the form-data check */
  }
  // Form-urlencoded, only when it cleanly matches `k=v(&k=v)*` AND carries at
  // least one sensitive param, so we never mangle arbitrary text that happens to
  // contain an '='.
  if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(body.trim())) {
    const params = new URLSearchParams(body);
    let hasSensitive = false;
    for (const key of params.keys()) {
      if (isSensitiveParamName(key)) hasSensitive = true;
    }
    if (hasSensitive) {
      const out = new URLSearchParams();
      for (const [key, value] of params) {
        out.append(key, isSensitiveParamName(key) ? '<redacted>' : value);
      }
      return out.toString();
    }
  }
  return body;
}

/**
 * Full documentation-facing redaction: the structured `auth` object PLUS any
 * credential-bearing raw header, query param, OR request-body field. Applied to
 * the WHOLE generated doc (request line, headers table, body, AND examples) so a
 * secret supplied via a raw header (e.g. `Authorization: Bearer …`), a `?token=…`
 * query string, or a body field (`{"client_secret": …}`, `grant_type=…&client_secret=…`)
 * is masked too, not just the structured auth field.
 */
function redactRequestForDocs(request: RequestDefinition): RequestDefinition {
  let out = redactRequestAuth(request);
  if (out.headers) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(out.headers)) {
      headers[key] = isSensitiveHeader(key) ? '<redacted>' : value;
    }
    out = { ...out, headers };
  }
  out = { ...out, url: redactUrlQuery(out.url) };
  if (typeof out.body === 'string' && out.body.length > 0) {
    out = { ...out, body: redactRequestBody(out.body) };
  }
  return out;
}

/**
 * Generate markdown documentation for a request
 */
export function generateDocumentation(
  request: RequestDefinition,
  options: {
    title?: string;
    description?: string;
    includeExamples?: boolean;
    /** Mask credentials throughout the document (default true). */
    redactCredentials?: boolean;
  } = {}
): string {
  const lines: string[] = [];

  // Credentials default to masked in documentation (the markdown is a
  // share-oriented artifact). This covers the structured auth object AND
  // credential-bearing raw headers and query params; the whole doc, meaning the
  // request line, headers table, and examples, is generated from the redacted view.
  // Opt out with redactCredentials:false for runnable snippets with live values.
  const docRequest = options.redactCredentials === false ? request : redactRequestForDocs(request);

  // Title
  lines.push(`# ${options.title || docRequest.method + ' ' + docRequest.url}`);
  lines.push('');

  // Description
  if (options.description) {
    lines.push(options.description);
    lines.push('');
  }

  // Request details
  lines.push('## Request');
  lines.push('');
  lines.push('```');
  lines.push(`${docRequest.method} ${docRequest.url}`);
  lines.push('```');
  lines.push('');

  // Headers
  if (docRequest.headers && Object.keys(docRequest.headers).length > 0) {
    lines.push('### Headers');
    lines.push('');
    lines.push('| Header | Value |');
    lines.push('|--------|-------|');
    for (const [key, value] of Object.entries(docRequest.headers)) {
      lines.push(`| ${mdCell(key)} | ${mdCell(value)} |`);
    }
    lines.push('');
  }

  // Authentication
  if (docRequest.auth) {
    lines.push('### Authentication');
    lines.push('');
    lines.push(`Type: \`${docRequest.auth.type}\``);
    lines.push('');
  }

  // Body
  if (docRequest.body) {
    lines.push('### Request Body');
    lines.push('');
    lines.push('```json');
    try {
      const parsed = JSON.parse(docRequest.body);
      lines.push(JSON.stringify(parsed, null, 2));
    } catch {
      lines.push(docRequest.body);
    }
    lines.push('```');
    lines.push('');
  }

  // Examples, generated from the same redacted view as the rest of the doc.
  if (options.includeExamples) {
    lines.push('## Examples');
    lines.push('');

    lines.push('### cURL');
    lines.push('');
    lines.push('```bash');
    lines.push(generateCurl(docRequest));
    lines.push('```');
    lines.push('');

    lines.push('### JavaScript');
    lines.push('');
    lines.push('```javascript');
    lines.push(generateJavaScript(docRequest));
    lines.push('```');
    lines.push('');

    lines.push('### Python');
    lines.push('');
    lines.push('```python');
    lines.push(generatePython(docRequest));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

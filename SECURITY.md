# Security Policy

## Reporting a vulnerability

Please do **not** file security reports as public GitHub issues. Instead, use
GitHub's private vulnerability reporting: go to the **Security** tab of this
repository and click **Report a vulnerability** (Security → Advisories → Report
a vulnerability). This opens a private advisory visible only to you and the
maintainers. Include:

- A description of the vulnerability and the affected version(s).
- Steps to reproduce, with a minimal example if possible.
- Your assessment of impact (auth bypass, token exposure, RCE, DoS, etc).

We aim to acknowledge reports within a few business days and ship a fix
in a patch release as soon as a remediation is validated. Reporters are
credited in the changelog unless they prefer to remain anonymous.

## What this package handles

`hoppscotch-mcp-server` is a stdio MCP server. It:

- Performs a browser-based device-login flow against a Hoppscotch frontend
  (Cloud or self-hosted), and stores the resulting auth token at
  `~/.config/hoppscotch-mcp/auth.json` (file mode `0o600`, directory mode
  `0o700`, best-effort on POSIX). This is a single per-OS-user session, shared across all server
  processes and restarts; the server refuses to silently switch to a different
  account if the on-disk token changes mid-session (switch via the `reauth`
  tool).
- Exchanges and refreshes Firebase tokens for the Cloud backend, using
  Firebase's public web API key (Firebase web API keys are public by
  design and are not secrets).
- Executes the tool-calling GraphQL + REST requests the MCP host asks it
  to, using the resolved token as a Bearer credential.

The `execute_request` / `validate_response` tools are the generic
API-workbench capability of the server: they fetch a host-supplied URL and
return the response into model context. By **default** they block targets
that resolve to loopback, link-local, cloud-metadata (`169.254.169.254`),
private, and CGNAT addresses — plus additional special-use ranges (IETF
protocol assignments incl. `192.0.0.192`, TEST-NETs, multicast, reserved,
broadcast, and IPv6 site-local/multicast), covering IPv4, IPv6, and
v4-mapped/compatible forms, with DNS resolution validated and **failing closed**
on resolution error — and restrict the scheme to `http`/`https`. The validated
address is **pinned at connect time** (an undici dispatcher whose lookup
re-validates and connects only to a permitted address), so the same resolution
is used for the check and the connection — closing the resolve-then-reconnect
DNS-rebinding TOCTOU. Redirects are not auto-followed (`redirect: 'manual'`), so
a permitted host cannot 30x-redirect to a private/metadata address or leak auth
headers cross-origin. Set `HOPPSCOTCH_ALLOW_PRIVATE_HOSTS=true` to opt out for
legitimate local / self-hosted testing.

Secret (`secret: true`) environment values substitute freely by default. Setting
`HOPPSCOTCH_SECRET_ALLOWED_ORIGINS` opts in to egress control: a secret is then
substituted only when the request's target origin is allowlisted, otherwise the
call is refused, so a prompt-injected request cannot exfiltrate a secret to an
attacker-chosen origin. Independently of that setting, when an environment is
requested an unresolved `{{placeholder}}` fails the call rather than being sent
literally (substitution covers the URL, header values and body — the `auth` block is
sent as given), secret values are scrubbed from any surfaced error text, and
secret values echoed in a response body/headers are scrubbed before they reach
the model.

Scrubbing works by matching the forms a secret takes when it is sent, so it is
best-effort rather than complete, and two things defeat it. The request can drop
part of the value before it is sent: everything after a `#` becomes a URL
fragment and never leaves this machine, so a target echoing back what it did
receive returns a prefix no form matches. And a target can transform what it
received before echoing it — decoding a percent-escape, turning a `+` back into
a space, splitting at a delimiter.

Only `secret: true` environment values are tracked and scrubbed. A non-secret
variable, a credential passed in a request's `auth` block, and anything written
straight into a header are never added to the scrub set at all.
`HOPPSCOTCH_SECRET_ALLOWED_ORIGINS` does not cover them either — it gates which
origins may receive `secret: true` values, and has no bearing on the other
three. Do not rely on response scrubbing for confidentiality.

Even with the guard enabled, the tool can still reach any **public** host the
machine can, using the request's own auth — agents should apply their own
redaction / approval policy.

## Non-goals

- SSRF protection blocks private/internal targets by default (see above) but
  does not restrict which **public** hosts may be reached.
- Beyond scrubbing the values of `secret`-flagged environment variables it
  substituted, this server does not redact response bodies (e.g. PII or other
  sensitive content) before returning them to the MCP host. Downstream agents /
  Hoppscotch product-level AI features are responsible for that policy.
- This server does not provide a hosted / multi-tenant mode. Running it
  as a publicly-reachable HTTP server is out of scope.

## Known-safe exposures

- The Cloud Firebase Web API key is the public client key from the
  hoppscotch.io frontend. Firebase web API keys are client identifiers, not
  secrets. It is no longer hardcoded in the source — the release build bakes it in from
  `HOPPSCOTCH_FIREBASE_API_KEY` (see `tsup.config.ts`), and the same variable
  overrides it at runtime. It still ships inside the published bundle, so what
  protects it is the Google Cloud API-key restrictions and Firebase Security
  Rules on that key, not secrecy.
- The local device-login callback server dual-binds to `127.0.0.1` and
  `::1` (both loopback families) on the same random ephemeral port —
  no non-local traffic can reach it. It enforces origin server-side:
  any request whose `Origin` header is set and does not match the
  configured Hoppscotch frontend origin is rejected with HTTP 403
  before any callback parsing. A 32-byte random `state` nonce is
  required on the callback and is verified with `crypto.timingSafeEqual`
  before any auth state is mutated. A `settled` latch ensures late
  callbacks (arriving after the 5-minute timeout already rejected)
  receive HTTP 410 and cannot mutate auth state.

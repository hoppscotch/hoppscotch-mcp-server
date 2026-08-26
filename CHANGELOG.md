# Changelog

All notable changes to this project will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning policy

`hoppscotch-mcp-server` is versioned **independently** from the main Hoppscotch
product. A major version bump reflects a breaking change to the MCP tool
surface, the auth flow, or the minimum supported Node version.

- **MAJOR**: breaking changes to the public MCP tool surface (tool removed,
  argument shape changed, response shape changed in an incompatible way) or
  minimum Node version increase.
- **MINOR**: new tools, new tool arguments with defaults, new optional
  behaviour.
- **PATCH**: bug fixes, internal refactoring, documentation.

Deprecations are announced in the release notes for the preceding minor
release and removed no sooner than the next major.

## [1.0.0] - 2026-08-25

Initial public release.

`hoppscotch-mcp-server` is a stdio MCP server that exposes Hoppscotch (collections,
requests, environments, and teams) to MCP hosts such as Claude Code and Codex. It
signs in through a browser device-login flow and caches the session at
`~/.config/hoppscotch-mcp/auth.json` (mode `0600` on POSIX; file permissions are not
enforced on Windows). Requires Node 22+. Ships as a CLI binary only; there is no
importable library entry point.

Both Hoppscotch Cloud and self-hosted instances are supported, with the same tool
surface on each. Two tools are unavailable on Cloud: `get_user_collection`, whose
`data` field Cloud's resolver fails to serialize, and `search_team_requests`,
which the Cloud backend rejects. Everything else runs on both, including personal
collections, requests and environments, team collections and environments,
request execution and code generation.

### Tools

53 tools covering collection/request/environment CRUD, team management, request
execution, response validation, and code/documentation generation. `HOPPSCOTCH_TOOL_PROFILE`
selects how many are exposed: `minimal`, `core` (the default), `standard`, or `full`.
`core` and `standard` are separate branches of `full`, not a ladder.

### Security posture

- `execute_request` and `validate_response` block loopback, link-local,
  cloud-metadata, private, CGNAT and other special-use targets by default, across
  IPv4, IPv6 and v4-mapped forms, failing closed on DNS resolution errors. The
  validated address is pinned at connect time, so the resolution that was checked is
  the one that gets dialled. Redirects are not auto-followed. Opt out for local
  testing with `HOPPSCOTCH_ALLOW_PRIVATE_HOSTS=true`.
- Requests time out after 30s, and responses over the 5 MB default body cap
  (`HOPPSCOTCH_MAX_RESPONSE_BYTES`) are truncated and flagged.
- `secret: true` environment values are masked in environment listings, and any that
  were substituted into a request are scrubbed from the response body, headers and
  error text before they reach the model. Scrubbing is best-effort: it matches the
  forms a secret takes when sent. Everything after a `#` becomes a URL fragment
  and is never sent at all, and a target can transform what it did receive before
  echoing it, by decoding a percent-escape, turning a `+` back into a space,
  or splitting at a delimiter, so either end can produce something those forms
  miss. Only `secret: true` values are tracked: a non-secret variable, a
  credential passed in `auth`, and anything written straight into a header are
  never added to the scrub set.
- `HOPPSCOTCH_SECRET_ALLOWED_ORIGINS` optionally restricts which origins may receive
  secret values at all. `HOPPSCOTCH_STRICT_ENV` optionally ignores trust-sensitive
  variables introduced by a working-directory `.env`, for hosts that open untrusted
  repositories.
- When an environment is selected, an unresolved `{{placeholder}}` fails the call
  rather than going out on the wire literally. Substitution covers the URL, header
  values and body; the `auth` block is not substituted, so pass credentials there
  directly.
- `generate_code` emits runnable snippets with live credentials; pass
  `redactCredentials: true` to mask them. `generate_documentation` masks by default.
- GraphQL mutations are not retried on network errors, so a lost response cannot
  duplicate a write. (An expired-token failure still re-issues the request once, after
  re-authenticating, and that path fails before the server commits anything.)
- Removing or demoting a team's last owner is refused client-side before the mutation
  is sent. This is best-effort defence in depth: if team membership can't be read, the
  call proceeds and the backend, which is authoritative, rejects it.
- The Firebase Web API key used for Cloud sign-in is injected at build time rather
  than committed to this repository.

Tools marked destructive (`delete_*`, `update_*`, `rename_*`, `move_*`, team
member changes, `reauth`, and the two request-execution tools; 25 of 53) execute
on the first call; the server implements no confirmation step. Hosts may prompt based on each tool's MCP annotations (`destructiveHint`,
`readOnlyHint`, `idempotentHint`, `openWorldHint`), which every tool carries.

# Hoppscotch MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that enables AI agents like Claude to interact with [Hoppscotch](https://hoppscotch.io): managing collections, environments, teams, and API workflows programmatically.

[![npm version](https://img.shields.io/npm/v/@hoppscotch/mcp-server)](https://www.npmjs.com/package/@hoppscotch/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **53 MCP tools** for comprehensive API workflow management
- **Collection management**: create, update, delete, import/export, duplicate, and move collections. The one search tool, `search_team_requests`, searches a team's **requests** by title, not collections
- **Environment management**: manage environment variables across deployment stages
- **Team collaboration**: full team workspace support including member management
- **Request execution**: execute HTTP requests with authentication and environment variable substitution
- **Response validation**: validate API responses against expected criteria (status, headers, body, response time)
- **Code generation**: generate code snippets in curl, JavaScript, Python, Go, and Rust
- **Documentation generation**: auto-generate API documentation in Markdown
- **REST and GraphQL collections**: personal collections and requests carry a REST/GraphQL type; team collections are untyped
- **Cloud and self-hosted targeting**: Cloud (`hoppscotch.io`) is supported. Self-hosted mode requires the backend under `<server URL>/backend` (subpath-based access, or a reverse proxy that routes it); a split-origin API on another host or port is not supported in this release. See [Cloud / self-hosted compatibility](#cloud--self-hosted-compatibility) for the verification boundary
- **Browser-based login**: no token setup required for interactive use. Sign in through Hoppscotch's device-login page and the session is cached

## Installation

### Via npx (recommended, no install needed)

```bash
npx @hoppscotch/mcp-server
```

### From npm

```bash
npm install -g @hoppscotch/mcp-server
```

This also installs the `hoppscotch-mcp` binary, which the client configs below can
use in place of `npx`.

### From source

This project uses **pnpm** (`corepack enable` picks up the pinned version):

```bash
git clone https://github.com/hoppscotch/hoppscotch-mcp-server.git
cd hoppscotch-mcp-server
pnpm install
pnpm run build
```

Released builds carry the Firebase Web API key needed for **Cloud** sign-in; a build
from source does not. To use Cloud from a source build, provide
`HOPPSCOTCH_FIREBASE_API_KEY` either at build time (it gets baked into the bundle) or
at runtime in your MCP client's `env` block. The runtime value takes precedence, so
no rebuild is needed. Without it, Cloud sign-in fails with a clear error. Self-hosted
instances don't use Firebase and need nothing extra.

## Quick Start

### 1. Configure your MCP client

**Claude Code** / **Codex**: register the server once at user scope. For a self-hosted
instance, pass `HOPPSCOTCH_SERVER_URL` through the host's env flag (`-e` for Claude Code,
`--env` for Codex).

```bash
claude mcp add -s user hoppscotch -- npx -y @hoppscotch/mcp-server
codex mcp add hoppscotch -- npx -y @hoppscotch/mcp-server
```

**Claude Desktop**: edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "hoppscotch": {
      "command": "npx",
      "args": ["-y", "@hoppscotch/mcp-server"]
    }
  }
}
```

For a self-hosted instance:

```json
{
  "mcpServers": {
    "hoppscotch": {
      "command": "npx",
      "args": ["-y", "@hoppscotch/mcp-server"],
      "env": {
        "HOPPSCOTCH_SERVER_URL": "https://your-hoppscotch.example.com"
      }
    }
  }
}
```

### 2. Authenticate

On the first tool call the server opens `hoppscotch.io/device-login` (or your self-hosted equivalent) in your browser. Sign in and the session is saved automatically, so subsequent calls skip the browser step.

> **Note:** Cloud sessions are refreshed automatically through the stored Firebase refresh token and may occasionally re-prompt for login. Sessions against the current Community Edition are **not** refreshed by this release (its refresh endpoint is cookie-based and this server does not use it; Enterprise/custom backends were not verified either way), so a new browser sign-in is needed when the token expires (backend-configured; the Community Edition default is one day). The sign-in page is the one the Hoppscotch Desktop app uses, so its copy says "Desktop".

## Configuration

**Most setups need none of these.** The Quick Start above sets no environment
variables at all: Cloud is the default and the browser login flow handles auth.
Everything below is optional, and each variable exists to serve one specific
situation.

### Commonly set

| Variable | Default | Purpose |
|---|---|---|
| `HOPPSCOTCH_SERVER_URL` | `https://hoppscotch.io` | Frontend URL. Omit for Cloud; set to your instance URL for self-hosted. The API URL and Cloud/self-hosted mode are derived from it. |
| `HOPPSCOTCH_TOOL_PROFILE` | `core` | Tool surface: `minimal` (22), `core` (default, 39), `standard` (38), or `full` (53). `core` covers CRUD + request execution + codegen + read-only team discovery; `standard` swaps in team administration + advanced collection ops; `full` is everything. `core` and `standard` are separate branches of `full`, not a ladder. An unknown value falls back to `core` with a stderr warning. |
| `HOPPSCOTCH_DEFAULT_TEAM_ID` | — | Default team ID for team-scoped tools when omitted from the call. |

### Headless and non-interactive use

| Variable | Default | Purpose |
|---|---|---|
| `HOPPSCOTCH_ACCESS_TOKEN` | — | A Hoppscotch **JWT** to skip browser login (e.g. for headless/CI). A `pat-…` PAT does **not** work (REST-only). |
| `HOPPSCOTCH_FORCE_BROWSER_LOGIN` | `false` | Set `true` to attempt browser login even when a headless environment is detected. |
| `HOPPSCOTCH_AUTH_TIMEOUT_MS` | `60000` | How long a tool call waits for browser sign-in before returning retry guidance (with the login URL once it is available). The local callback stays open ~5 min regardless, so a slower sign-in still completes. |

### Request execution

| Variable | Default | Purpose |
|---|---|---|
| `HOPPSCOTCH_TIMEOUT` | `30000` | Request timeout (ms). |
| `HOPPSCOTCH_MAX_RESPONSE_BYTES` | `5000000` | Cap on the response body `execute_request` buffers; a body that would exceed it is cut off and flagged `truncated`. Two limits apply: the raw read stops at the cap plus a small internal redaction margin (bytes), and the returned redacted text is additionally capped at the same number of UTF-16 code units — byte-exact for ASCII bodies; a non-ASCII body can be cut below the byte figure by the raw read, or come back somewhat larger than it after redaction. (Raw bytes that only spill into the internal redaction margin but shrink back under the cap after redaction are complete, not flagged.) |
| `HOPPSCOTCH_ALLOW_PRIVATE_HOSTS` | `false` | Set `true` to disable SSRF protection so `execute_request` can reach loopback/private/self-hosted targets. Only on trusted input. |

### Hardening (opt-in)

Both default to off, so behaviour is unchanged unless you set them.

| Variable | Default | Purpose |
|---|---|---|
| `HOPPSCOTCH_SECRET_ALLOWED_ORIGINS` | — | Comma-separated origins (e.g. `https://api.example.com`) allowed to receive **secret** environment values via `{{var}}` substitution in `execute_request`/`validate_response`. Unset ⇒ **no restriction** (secrets substitute freely). Set it to opt in: only the listed origins may then receive secrets; a secret referenced in a request to any other origin is refused. |
| `HOPPSCOTCH_STRICT_ENV` | `false` | Set `true` to harden against a hostile working-directory `.env`: trust-sensitive vars (auth target/token, tool profile, SSRF/secret-egress toggles, default team) that a `.env` *introduces* are then ignored and must come from the real environment. Off by default; a `.env` is honoured in full. |

### Building from source

| Variable | Default | Purpose |
|---|---|---|
| `HOPPSCOTCH_FIREBASE_API_KEY` | baked in at build | Firebase Web API key used for Hoppscotch **Cloud** sign-in. Released builds have it baked in, so you normally never set this. Set it when building from source and using Cloud: a source build without it fails Cloud sign-in with a clear error. Not used by self-hosted instances. |

> **Hardening a `.env`-loading setup.** By default a working-directory `.env` is honoured for every variable (backwards-compatible). If you run this server in an editor that may open untrusted repositories, set `HOPPSCOTCH_STRICT_ENV=true` in your MCP client's `env` block so a hostile repo `.env` can't repoint the auth target, disable the SSRF guard, or allowlist a secret-exfiltration origin.

The API URL and auth mode are derived from `HOPPSCOTCH_SERVER_URL`: `hoppscotch.io` (and `www.hoppscotch.io`) → `api.hoppscotch.io` (Cloud / Firebase auth); any other host → `<server_url>/backend` (self-hosted / JWT auth).

## Authentication

The server uses a **browser-based device login flow**, driven by Hoppscotch's `/device-login` page:

1. On first tool call, a temporary local HTTP server starts on a random port.
2. Your browser opens `<HOPPSCOTCH_SERVER_URL>/device-login?redirect_uri=http://localhost:<port>/callback/<nonce>`.
3. After sign-in, the server receives your tokens via the callback.
4. Tokens are stored at `~/.config/hoppscotch-mcp/auth.json` (permissions: `600`).
5. Cloud tokens (Firebase-backed, ~1 hour) are refreshed automatically before expiry via the stored Firebase refresh token; a new browser login is needed only if a refresh fails. Tokens from the current Community Edition are not refreshed in this release: when the JWT expires (backend-configured; the CE default is one day), the next tool call opens a new browser sign-in. Enterprise/custom backends were not verified either way.

**Advanced: override token.** You can set `HOPPSCOTCH_ACCESS_TOKEN` to a valid JWT (e.g. copied from `~/.config/hoppscotch-mcp/auth.json` after a device login) to skip the browser flow. Note that Hoppscotch PATs (`pat-xxx`) only work with REST API endpoints, not GQL queries, so they will **not** work here.

### Non-interactive / headless (CI, containers, SSH)

There is no browser on these hosts, so the device-login flow can't run. The server detects headless environments (CI / SSH / no display) and fails fast with guidance instead of hanging. To run non-interactively:

1. On a machine with a browser, complete a device login once.
2. Copy the `accessToken` JWT from `~/.config/hoppscotch-mcp/auth.json`.
3. Set `HOPPSCOTCH_ACCESS_TOKEN=<that JWT>` in the headless environment.

If you genuinely have a browser available but detection misfires, set `HOPPSCOTCH_FORCE_BROWSER_LOGIN=true`.

## Known limitations (current release)

- **`execute_request` is a real HTTP client.** By default it blocks requests to loopback, link-local, cloud-metadata (`169.254.169.254`), and private-network addresses (SSRF protection), covering IPv4/IPv6 and additional special-use ranges. The validated address is pinned at connect time (via an undici dispatcher), so a same-host DNS-rebinding race between check and connect is closed too (and redirects, which are disabled, can't reach a private IP either). To test a **local or self-hosted API on a private address**, set `HOPPSCOTCH_ALLOW_PRIVATE_HOSTS=true`. Only do this on trusted inputs, since the tool returns the full response into the model's context. Even with the guard on, it can still reach any **public** host using the request's own credentials.
- **Redirects are not auto-followed** (`execute_request`/`validate_response`): a 3xx is returned as-is, so a redirect can't silently forward your auth headers to another origin.
- **Response bodies are capped** at `HOPPSCOTCH_MAX_RESPONSE_BYTES` (default 5 MB); `truncated` in the result marks a body that is missing content (cut at the read limit, or clamped after redaction) — a body that only spilled into the redaction margin and shrank back under the cap arrives complete and unflagged.
- **`validate_response` makes its own HTTP call.** It executes the request you pass rather than inspecting an earlier result, so validating a request you already ran sends it again (a non-idempotent request runs a second time).
- Request execution and validation take a raw `method`/`url`; they do **not** execute a request already stored in a collection by ID.
- **`validate_response` does not check a JSON Schema.** `jsonSchema` is a deprecated alias of `jsonObject`: both assert only that the body parses as a JSON object or array. A schema document passed there is ignored, and nothing reports that it was. Use `jsonObject: true` for the check that actually runs.
- The default `core` profile already keeps the surface lean (CRUD + request execution + codegen + read-only team discovery). Set `HOPPSCOTCH_TOOL_PROFILE=minimal` for an even smaller surface, or `standard`/`full` to add team administration and advanced collection ops.
- **One signed-in identity per OS user.** The auth token in `~/.config/hoppscotch-mcp/auth.json` is a single session shared by every MCP-client process for that OS user and across restarts; tool calls do not select an identity per call. If the on-disk token changes to a **different** account mid-session, the server refuses to silently switch rather than acting as the wrong account. Use the `reauth` tool to switch or refresh the active identity. At runtime this is process-local: a running server keeps serving its in-memory token until expiry or its next disk read — `reauth` rewrites the shared store and refreshes the calling process, while other pinned processes accept same-identity updates and refuse a different account.
- **Variable substitution reads PERSONAL environments only.** `execute_request`/`validate_response` substitute `{{var}}` from your personal (user) environments on either backend; a team-environment ID is rejected. These tools also do **not** inherit authentication from a parent collection; they use only the `auth` you pass in the call. Values marked **secret** substitute freely by default; set `HOPPSCOTCH_SECRET_ALLOWED_ORIGINS` to restrict which origins may receive them. When an environment is requested, an unresolved `{{placeholder}}` fails the call rather than being sent literally. Substitution covers the URL, header values and body only; the `auth` block is not substituted, so a `{{var}}` written there is treated as the credential text itself; pass auth credentials directly.

## Available Tools

### Cloud / self-hosted compatibility

All 53 tool definitions are available in self-hosted mode (with `HOPPSCOTCH_TOOL_PROFILE=full`;
the default `core` profile exposes 39 of them) when the backend is
reachable at `<server URL>/backend`. Compatibility was assessed against the
current public Community Edition backend contract, not a live CE instance;
SHE and custom backends were not available for verification. On Hoppscotch
Cloud (`hoppscotch.io`), all but two tools were verified against a live account.

Two tools are unavailable on Cloud:

| Tool | Why |
|---|---|
| `get_user_collection` | Cloud's `userCollection` resolver fails to serialize `data` (`String cannot represent value`), so the query errors. The same field returns fine from `rootRESTUserCollections`. Gated client-side. |
| `search_team_requests` | The Cloud backend rejects the query with `bug/team/no_require_team_role`, surfaced from upstream rather than gated. |

### Teams

| Tool | Description |
|------|-------------|
| `list_teams` | List all teams you are a member of, with each team's members |
| `get_team_info` | Get team details including members and roles |
| `create_team` | Create a new team |
| `rename_team` | Rename a team |
| `delete_team` | Delete a team (irreversible) |
| `leave_team` | Leave a team |
| `invite_team_member` | Invite a member to a team by email |
| `revoke_team_invitation` | Revoke a pending team invitation |
| `remove_team_member` | Remove a member from a team |
| `update_team_member_role` | Update a team member's role (OWNER/EDITOR/VIEWER) |

> `list_teams` and `get_team_info` return each member's user ID, display name,
> and **email address** alongside their role. Both are read-only and both ship in
> the default `core` profile, so asking an agent to list your teams puts your
> colleagues' email addresses into the model's context.

### Team Collections

| Tool | Description |
|------|-------------|
| `list_team_collections` | List root collections in a team |
| `get_team_collection` | Get details of a specific team collection |
| `create_team_collection` | Create a root or child team collection |
| `update_team_collection` | Update a team collection's title or data |
| `delete_team_collection` | Delete a team collection |
| `duplicate_team_collection` | Duplicate a team collection |
| `move_team_collection` | Move a team collection to a new parent |
| `import_team_collection` | Import a team collection from JSON |
| `export_team_collection` | Export a team collection to JSON |
| `search_team_requests` | Search team requests by title (backed by `searchForRequest` GQL, which returns requests, not collections) |

### Team Environments

| Tool | Description |
|------|-------------|
| `list_team_environments` | List all environments in a team |
| `create_team_environment` | Create a team environment with variables |
| `update_team_environment` | Update a team environment's name or variables |
| `delete_team_environment` | Delete a team environment |

### User (Personal) Collections

> Personal (user) collection tools are exposed in self-hosted mode. On **Hoppscotch Cloud**, all except `get_user_collection` were live-verified; see the compatibility section above for the self-hosted verification boundary.

| Tool | Description |
|------|-------------|
| `list_user_collections` | List personal collections (REST or GraphQL) |
| `get_user_collection` | Get a specific personal collection |
| `create_user_collection` | Create a personal collection |
| `update_user_collection` | Update a personal collection's title or data |
| `delete_user_collection` | Delete a personal collection |
| `duplicate_user_collection` | Duplicate a personal collection |
| `move_user_collection` | Move a personal collection to a new parent or root |
| `import_user_collection` | Import personal collection(s) from JSON |
| `export_user_collection` | Export personal collection(s) to JSON |

### User (Personal) Environments

> Personal (user) environment tools are exposed in self-hosted mode. On **Hoppscotch Cloud**, all four tools (list, create, update, delete) were verified against a live account; see the compatibility section above for the self-hosted verification boundary.

| Tool | Description |
|------|-------------|
| `list_user_environments` | List personal environments |
| `create_user_environment` | Create a personal environment |
| `update_user_environment` | Update a personal environment |
| `delete_user_environment` | Delete a personal environment |

### Team Requests

| Tool | Description |
|------|-------------|
| `list_team_requests` | List requests in a team collection |
| `get_team_request` | Get a specific team request by ID |
| `create_team_request` | Create a request in a team collection |
| `update_team_request` | Update a team request's title or data |
| `delete_team_request` | Delete a team request |
| `move_team_request` | Move a team request to a different collection |

### User (Personal) Requests

> Personal (user) request tools are exposed in self-hosted mode and were live-verified on **Hoppscotch Cloud**; see the compatibility section above for the self-hosted verification boundary.

| Tool | Description |
|------|-------------|
| `list_user_requests` | List requests in a personal collection |
| `create_user_request` | Create a personal request (REST or GraphQL) |
| `update_user_request` | Update a personal request's title or data |
| `delete_user_request` | Delete a personal request |
| `move_user_request` | Move a personal request to a different collection |

### Request Execution

| Tool | Description |
|------|-------------|
| `execute_request` | Execute an HTTP request with full auth and environment variable support |
| `validate_response` | Execute a request and validate the response against criteria |

### Code Generation

| Tool | Description |
|------|-------------|
| `generate_code` | Generate a code snippet in curl, JavaScript, Python, Go, or Rust |
| `generate_documentation` | Generate Markdown API documentation with multi-language examples |

### Session

| Tool | Description |
|------|-------------|
| `reauth` | Force a fresh device-login (browser sign-in), bypassing cached tokens. Cannot replace a configured `HOPPSCOTCH_ACCESS_TOKEN`; that static token is always used. It clears the cached browser session and reports success only when the prior session was verifiably removed before the new sign-in (a successful login then stores the new session); otherwise it returns a tool error. Available in every profile. |

## Usage Examples

### Manage team collections

```
List all collections in my team and show me the details of the "Payments API" collection
```

```
Create a new team collection called "Analytics API" with a child collection "Reports"
```

### Work with environments

```
Create a staging environment with BASE_URL=https://staging.api.example.com and API_KEY=<staging-key>
```

```
Update the production environment to change the API_KEY variable
```

### Execute and validate requests

```
Execute a GET request to https://api.github.com/users/octocat with Accept: application/vnd.github.v3+json header
```

```
Test that https://api.example.com/health returns status 200 in under 300ms
```

### Generate code

```
Generate a Python snippet for POST https://api.example.com/users with JSON body {"name": "Jane"}
```

```
Generate curl and JavaScript examples for the Login endpoint in the Auth API collection
```

### Import and export

```
Export the "User API" team collection as JSON
```

```
Import this Hoppscotch collection JSON into my team workspace
```

## Development

### Prerequisites

- Node.js >= 22 (Node 20 reached upstream end-of-life on 2026-04-30)

### Setup

```bash
git clone https://github.com/hoppscotch/hoppscotch-mcp-server.git
cd hoppscotch-mcp-server
pnpm install
cp .env.example .env
# Edit .env with your configuration
pnpm run build
```

### Scripts

```bash
pnpm test                 # Unit tests (excludes e2e)
pnpm run test:coverage    # Unit tests with coverage
pnpm run test:e2e         # E2E integration tests (requires .env setup, see below)
pnpm run typecheck        # TypeScript type checking
pnpm run lint             # ESLint
pnpm run lint:fix         # ESLint with auto-fix
pnpm run build            # Production build
pnpm run dev              # Watch mode build
pnpm run format           # Prettier over src/
pnpm run validate:graphql # Check every GQL document against a backend schema
```

`validate:graphql` takes a captured introspection result and validates the
documents in `src/graphql/` against it. The unit tests mock the transport, so
they cannot catch a wrong argument name or a missing selection set: only this
does.

```bash
curl -s -X POST https://api.hoppscotch.io/graphql \
  -H 'Content-Type: application/json' \
  -d "$(node -e "const{getIntrospectionQuery}=require('graphql');console.log(JSON.stringify({query:getIntrospectionQuery()}))")" \
  -o schema.json
pnpm run validate:graphql schema.json
```

### Running E2E Tests

E2E tests spin up the real MCP server via stdio and call tools through the MCP SDK client, exactly how Claude uses it. They require a live Hoppscotch instance and real resource IDs.

1. Copy `.env.example` to `.env` and fill in:

```bash
# Only TEAM_ID is required; everything else is self-provisioned
HOPPSCOTCH_TEAM_ID=your-team-id

# Optional: set server URL for self-hosted (omit for Cloud)
# HOPPSCOTCH_SERVER_URL=https://your-hoppscotch.example.com
```

2. Authenticate first:

```bash
pnpm run build
npx tsx src/e2e/login.ts  # browser device login; stores the token and exits
```

3. Run the suite:

```bash
pnpm run test:e2e
```

Tests create and clean up their own resources. The same suite runs against both Cloud and self-hosted. `HOPPSCOTCH_TEAM_ID` is required; with `HOPPSCOTCH_E2E=1` set, a missing prerequisite fails the affected tests instead of skipping them.

### Project Structure

```
hoppscotch-mcp-server/
├── src/
│   ├── auth.ts                       # Browser device-login flow + token storage
│   ├── client.ts                     # Hoppscotch API client (GQL + REST)
│   ├── config.ts                     # Configuration and env var parsing
│   ├── types.ts                      # Shared TypeScript types
│   ├── server.ts                     # MCP server: tool registration and routing
│   ├── index.ts                      # Entry point
│   ├── graphql/
│   │   ├── queries.ts                # GraphQL queries
│   │   └── mutations.ts              # GraphQL mutations
│   ├── repositories/
│   │   ├── collection-repository.ts  # Collection CRUD operations
│   │   ├── environment-repository.ts # Environment CRUD operations
│   │   ├── request-repository.ts     # Request CRUD operations
│   │   └── team-repository.ts        # Team management operations
│   ├── tools/
│   │   ├── definitions.ts            # MCP tool definitions, annotations, profiles
│   │   ├── schemas.ts                # Zod input validation schemas
│   │   └── handlers.ts               # Tool execution handlers
│   ├── utils/
│   │   ├── request-executor.ts       # HTTP execution, variable substitution, scrubbing
│   │   ├── code-generator.ts         # Snippet and Markdown generation, redaction
│   │   ├── ssrf-guard.ts             # Address denylist and connect-time pinning
│   │   └── retry.ts                  # Backoff for retryable GraphQL reads
│   ├── version.ts                    # Version string reported over MCP
│   └── e2e/
│       ├── e2e.test.ts               # E2E integration test suite
│       └── login.ts                  # Login helper for e2e setup
├── examples/
│   ├── claude-prompts.md             # Example prompts for MCP hosts
│   └── collection-examples.json      # Example Hoppscotch collection JSON
├── .env.example                      # Environment variable template
├── package.json
└── tsconfig.json
```

## Troubleshooting

### Browser doesn't open

Copy the URL printed to stderr and open it manually.

### Login timed out

Complete the browser login within 5 minutes, or retry the tool call.

### Session expired (Cloud)

Cloud sessions are Firebase-backed and expire after ~1 hour. The server attempts to refresh automatically using the stored Firebase refresh token. If refresh fails, the next tool call opens a new browser login. Sessions against the current Community Edition are not refreshed by this release — it mounts refresh at `/v1/auth/refresh`, cookie-based, which this client does not use (Enterprise/custom backends unverified). When the JWT expires (backend-configured; the CE default is one day), the next tool call opens a new browser sign-in.

This applies to sessions created by device login. A token supplied through `HOPPSCOTCH_ACCESS_TOKEN` is used exactly as given and is never refreshed, so keeping it valid is up to you.

### GraphQL Unauthorized error

Delete `~/.config/hoppscotch-mcp/auth.json` and retry; a fresh login will be triggered.

### Team ID required

Set `HOPPSCOTCH_DEFAULT_TEAM_ID` in your environment, or pass `teamId` explicitly in the tool call.

### SSL certificate errors (self-hosted)

If your self-hosted instance uses a self-signed or private-CA certificate, point Node at the CA bundle with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in the server environment. **Do not** use `NODE_TLS_REJECT_UNAUTHORIZED=0`: it disables TLS verification for the *entire* Node process (Cloud/Firebase token exchange and every `execute_request` to public hosts included), not just your self-hosted host.

### Tools unavailable on Cloud

Two tools are unavailable on Cloud: `get_user_collection` (Cloud's resolver fails to serialize `data`; gated client-side) and `search_team_requests` (the backend rejects it with `bug/team/no_require_team_role`). The other Cloud tools were live-verified. Self-hosted verification is scoped in the compatibility section above.

## Security

- Never commit `.env` (it's gitignored); `auth.json` lives outside the repo at `~/.config/hoppscotch-mcp/`, not in your project
- Auth tokens are stored at `~/.config/hoppscotch-mcp/auth.json` with `600` permissions (owner-only, best-effort on POSIX)
- The server is stateless: no user data is cached locally beyond the auth token
- On Windows, file permissions (`0o600`) are not enforced, so keep `auth.json` in a secure location
- Only `secret: true` environment values are masked on read. Auth credentials stored on a collection or a request (a bearer token, a basic password, an API key) are returned as stored by `list_user_collections`, `get_user_collection`, `list_user_requests`, `get_team_request` and the team equivalents, so they reach the model in plaintext

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit using [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `test:`, etc.
4. Open a Pull Request

Please run `pnpm run lint`, `pnpm run typecheck`, and `pnpm test` before submitting. CI enforces the same.

## License

MIT. See [LICENSE](LICENSE) for details.

## Links

- [Hoppscotch](https://hoppscotch.io)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Hoppscotch Documentation](https://docs.hoppscotch.io)

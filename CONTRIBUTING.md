# Contributing

Thanks for your interest in contributing to `hoppscotch-mcp-server`.

## Development setup

This project uses **pnpm** (version pinned via `packageManager` in `package.json`;
run `corepack enable` to use it automatically).

```bash
pnpm install          # --frozen-lockfile in CI
pnpm run typecheck    # TypeScript check
pnpm run lint         # ESLint
pnpm test             # Unit tests (excludes e2e)
pnpm run build        # Produce dist/
```

`pnpm test` is hermetic (no network, no browser, no real filesystem) so it
behaves the same locally and in CI. Two suites are opt-in because they need a
live backend and are therefore skipped by default:

```bash
HOPPSCOTCH_INTEGRATION=1 pnpm test   # adds the live GraphQL query in client.test.ts
pnpm run test:e2e                    # the full end-to-end suite (see below)
```

## Running end-to-end tests

E2E tests exercise the real backend. You need a Hoppscotch team workspace
you own; the tests self-provision collections/environments under it and
clean up after themselves.

```bash
# Cloud
echo "HOPPSCOTCH_TEAM_ID=<your-team-id>" > .env
pnpm run test:e2e

# Self-hosted
HOPPSCOTCH_SERVER_URL=https://your-sh.example.com \
HOPPSCOTCH_TEAM_ID=<your-team-id> \
pnpm run test:e2e
```

The suite does write to the team you point it at: it creates a fixture
collection and environment there during setup and deletes them again in
teardown. It never touches membership: no invitations are sent, no members
are removed, and no roles are changed. Point it at a workspace you own and
don't mind writing to.

## Pull requests

- Keep changes focused: one PR per logical change.
- Include tests for new tools or behaviour changes.
- `pnpm run lint && pnpm run typecheck && pnpm test` must all pass locally
  before you push. CI enforces the same.
- Add tool `annotations` when introducing a new tool (see
  `src/tools/definitions.ts`).
- `.prettierrc.json` is there so your editor formats new code consistently.
  The existing sources are not uniformly Prettier-formatted, and a few spots
  are laid out by hand because Prettier's output reads worse there. Please
  don't run `pnpm run format` across `src/`; it produces a large diff that
  buries the change you actually made.

## Commit messages

Conventional-commits style: `feat`, `fix`, `chore`, `docs`, `refactor`,
`test`. Use `fix` for bug fixes and `feat` for new functionality, and do not
mix them up.

## Reporting security issues

Do not file security reports in public issues. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the Hoppscotch
[Code of Conduct](CODE_OF_CONDUCT.md).

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

If you change anything under `src/graphql/`, also run
`pnpm run validate:graphql <introspection.json>`. The unit tests mock the
transport, so a wrong argument name or a missing selection set passes them and
fails against a real backend. See the README for capturing the schema.

`pnpm test` does not contact an external backend or open a browser. Some auth
tests bind loopback sockets; the storage-facing auth suites mock the
filesystem entirely. Two suites
are opt-in because they need a live backend and are therefore skipped by
default:

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

- Before starting a substantial tool-surface, authentication, security, or
  release-process change, open an issue and agree on the direction with the
  maintainers.
- Keep changes focused: one PR per logical change.
- Include tests for new tools or behaviour changes.
- Typecheck, lint, format checking, unit tests, coverage, build, and the
  production dependency audit must pass before merge. CI runs typecheck, lint,
  format checking, tests, and coverage across the supported operating-system
  and Node.js matrix; build and the production dependency audit each run in
  a separate single-configuration job (Linux, Node 22).
- Never include `.env`, `auth.json`, JWTs, API keys, stored request credentials,
  or unredacted logs in a pull request.
- Tool `annotations` are derived from the tool name by `annotationsFor` in
  `src/tools/definitions.ts`; extend it when a new tool's hints differ.
- Run `pnpm run format` before you push. `src/` is uniformly Prettier-formatted
  and CI runs `pnpm run format:check`, so an unformatted file fails the build.

## Commit messages

Use Conventional Commit subjects for commits and pull-request titles: `feat`,
`fix`, `chore`, `docs`, `refactor`, `test`, or `ci`, with an optional scope.
Use `fix` for bug fixes and `feat` for new functionality, and do not mix them
up.

## Maintainers

Maintainers review and merge changes, triage issues and private security
reports, keep CI, release automation, compatibility claims, and security
documentation accurate, and publish and verify releases. Normal changes merge
through a focused pull request with green required checks and review from
someone other than the author; security fixes may be developed through a
private security advisory. Breaking changes to tool inputs, outputs,
authentication, or the minimum Node version require explicit maintainer
agreement and a documented migration. Maintainer access is
granted after sustained contributions, demonstrated review judgment, and
agreement from the existing
maintainers, scoped to what the role needs, with release or security roles
recorded in the corresponding protected service settings.

Access invariants:

- At least two people can administer the repository, the npm package, the
  protected release environment, and private security advisories.
  `npm owner ls @hoppscotch/mcp-server` checks npm ownership without exposing
  credentials.
- Publishing credentials and protected build inputs live in GitHub or npm
  settings, never in this repository.
- Release approval must not depend on the person who prepared the release.
- Access is reviewed whenever repository ownership changes and after any
  credential or workflow incident, and removed only after replacement
  ownership and recovery paths have been verified.

## Releasing

Releases are published by `.github/workflows/release.yml`, triggered only by
an explicit `vX.Y.Z` tag. The workflow refuses to publish unless the tag
points to a commit reachable from `main`, the tag matches `package.json` and
both `server.json` version fields, `CHANGELOG.md` has a matching section, the
core checks and the production dependency audit pass, and the Firebase build
input is present.

Required repository setup, once, before the first release:

- protect `main` (pull-request review, required CI checks) and release tags,
  restricting who can create or modify `v*` tags;
- a GitHub `release` environment with a required reviewer, self-review
  disabled, and deployment restricted to release tags;
- the npm publishing authentication the workflow expects; and
- `HOPPSCOTCH_FIREBASE_API_KEY` as a protected release build input. The key is
  public client configuration embedded in the published bundle; the protected
  environment prevents publishing an incomplete build — confidentiality is not
  the security control for this key.

To release:

1. Choose the version from the `Unreleased` changelog content per semver, then
   open a focused release PR updating `package.json`, both `server.json`
   version fields, and the changelog version/date; merge only after review and
   green CI. To preview the tarball, run `pnpm build` from a clean checkout
   and then `pnpm publish --dry-run --ignore-scripts --no-git-checks` —
   `dist/` is not tracked and `--ignore-scripts` skips the automatic rebuild,
   so a preview without a fresh build shows stale or missing output.
2. Tag exactly the released `main` commit — after CI has passed on that
   commit — and push only that tag, never `git push --tags`:

   ```bash
   git tag vX.Y.Z <main-commit-sha>
   git push origin vX.Y.Z
   ```

3. Have another maintainer approve the `release` environment, then watch the
   workflow through npm publication and GitHub release creation.
4. Verify: the GitHub release tag points to the intended `main` commit;
   `npm view @hoppscotch/mcp-server@X.Y.Z version dist-tags dist.attestations`
   shows the expected version, `latest` dist-tag, and provenance naming this
   repository, workflow, tag, and commit;
   `npm pack @hoppscotch/mcp-server@X.Y.Z --dry-run` lists only the expected
   files; and a clean install starts and completes one read-only Hoppscotch
   Cloud operation.

If the workflow fails before npm publication: cancel it, correct the release
commit, and create a new tag only after the previous tag and any draft GitHub
release have been handled deliberately. After npm publication: never reuse a
published version number — prefer deprecating the affected version and
publishing a fix-forward patch; restore `latest` to a known-good version with
`npm dist-tag add` if needed; use `npm unpublish` only when current npm policy
permits it and the maintainers agree. On credential or workflow compromise:
disable the release environment, revoke or rotate npm publishing
authentication, review workflow runs, tags, releases, and published artifacts,
and follow `SECURITY.md` if consumers may be affected.

MCP Registry publication is optional, follows successful npm/GitHub
verification, and registry ownership follows the same primary-and-backup
access rule as package publication.

## Reporting security issues

Do not file security reports in public issues. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the Hoppscotch
[Code of Conduct](CODE_OF_CONDUCT.md).

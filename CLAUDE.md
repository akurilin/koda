# Project Guidance

## Next.js

This version has breaking changes — APIs, conventions, and file structure
may all differ from your training data. Read the relevant guide in
`web/node_modules/next/dist/docs/` before writing any code. Heed deprecation
notices.

## Runtime

- Use the Node.js version pinned in the root `.nvmrc`.
- Run `nvm use` from the repository root before working with Node tooling.
- npm engine checks are strict via the root `.npmrc`; package folders should
  symlink their local `.npmrc` to it so installs fail when the active Node/npm
  versions do not match package `engines`.

## Development Workflow

- Do not commit changes unless the user explicitly asks you to commit.
- Do not push changes to a Git remote unless the user explicitly asks you to
  push.
- Static analysis runs automatically via `pre-commit` on every commit: ESLint,
  Prettier, `tsc --noEmit`, `shellcheck`, `gitleaks`, and `squawk` (Postgres
  migration safety). Install once with `pre-commit install` from the repo root.
  Do not bypass the hooks with `--no-verify`; fix the underlying issue instead.

## Database and migrations

- Use standard Supabase for local and production Postgres workflows.
- Manage schema changes through Supabase migrations in `supabase/migrations/`;
  do not introduce a separate migration tracker unless explicitly requested.
- Create and apply Supabase migrations with the Supabase CLI. Do not
  hand-apply migration SQL directly to local or remote databases, because
  that bypasses Supabase's migration tracking.
- The Supabase CLI is not installed on `PATH`. Invoke it via
  `npx supabase ...` (e.g. `npx supabase migration new <name>`,
  `npx supabase migration up`). Run from the repo root so it finds
  `supabase/config.toml`.
- Match the style of the existing migrations: unquoted lower-case identifiers
  with underscores, SQL keywords in upper case.

## Validating UI changes

- When a Playwright e2e test already exercises the surface you changed,
  run that test and rely on it.
- When no e2e test covers the change, drive the UI yourself with
  `npx agent-browser ...` against the running dev server before handing
  the task back. Treat "I can't test this" as a last resort — it pushes
  validation onto the user and should be called out explicitly when it
  happens, not silently skipped.

## Documentation

Every non-trivial construct should carry a short comment that leads with the
**why** — the constraint, invariant, or non-obvious interaction it exists
for — not the what. When you change a commented construct, update the
comment in the same change.

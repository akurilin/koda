# Project Guidance

This is a monorepo Git repository. The Next.js codebase lives under the
`web/` subfolder in this directory.

## Web App

- Location: `web/`
- Framework: Next.js
- Language: TypeScript
- Styling: Tailwind CSS
- Package manager: npm

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
- Before changes are ready to commit, run Prettier manually from the repository
  root with `npm run format` (or `npm --prefix web run format`).
- Static analysis runs automatically via `pre-commit` on every commit: ESLint,
  Prettier, `tsc --noEmit`, `shellcheck`, `gitleaks`, and `squawk` (Postgres
  migration safety). Install once with `pre-commit install` from the repo root.
  Do not bypass the hooks with `--no-verify`; fix the underlying issue instead.

## Validating UI changes

- When a Playwright e2e test already exercises the surface you changed,
  run that test and rely on it.
- When no e2e test covers the change, drive the UI yourself with
  `npx agent-browser ...` against the running dev server before handing
  the task back. Treat "I can't test this" as a last resort — it pushes
  validation onto the user and should be called out explicitly when it
  happens, not silently skipped.

## Documentation

- Every function, type, interface, React component, and other core logic
  construct should carry at least a minimal comment or docstring so future
  readers can orient without diving into internals.
- Lead with the **why**: the reason this piece exists, the constraint it
  enforces, the invariant it protects, or the non-obvious interaction it
  participates in. Avoid restating the **what** when a well-named identifier
  or a short function body already makes it obvious.
- Trivial helpers (one-liner getters, obvious adapters, internal formatting
  utilities) can stay uncommented when the name is unambiguous. When in
  doubt, prefer a short comment over none.
- When changing a commented construct, update the comment in the same change
  — stale documentation is worse than missing documentation.

## Project Purpose

The project implements a web-based agentic prose editor for article writers.
It helps writers iterate on individual passages, sections, and paragraphs of
the text they are working on with support from an AI assistant and a convenient,
delightful UX.

The editor should help writers refine prose until they are satisfied with how it
feels, whether that means improving style, sharpening the content they want to
share with the world, or developing and clarifying their own thinking around the
article.

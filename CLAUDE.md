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
- Before changes are ready to commit, run Prettier manually from the `web/`
  package with `npm run format`.
- Do not add automated Git hooks yet; formatting should remain a manual
  pre-commit step while the project is in flux.

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

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

## Project Purpose

The project implements a web-based agentic prose editor for article writers.
It helps writers iterate on individual passages, sections, and paragraphs of
the text they are working on with support from an AI assistant and a convenient,
delightful UX.

The editor should help writers refine prose until they are satisfied with how it
feels, whether that means improving style, sharpening the content they want to
share with the world, or developing and clarifying their own thinking around the
article.

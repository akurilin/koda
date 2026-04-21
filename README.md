# koda

[![CI](https://github.com/akurilin/koda/actions/workflows/ci.yml/badge.svg)](https://github.com/akurilin/koda/actions/workflows/ci.yml)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/akurilin/koda)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Anthropic](https://img.shields.io/badge/LLM-Anthropic-D97757?logo=anthropic&logoColor=white)](https://www.anthropic.com)
[![style: prettier](https://img.shields.io/badge/style-prettier-ff69b4.svg)](https://prettier.io)
[![lint: eslint](https://img.shields.io/badge/lint-eslint-4B32C3.svg)](https://eslint.org)

`koda` is a web-based agentic prose editor for article writers. You write in a
rich block editor on the left, chat with an AI assistant on the right, and the
assistant can read and edit the document directly through server-side tools —
without having to paste passages back and forth. No "copy this draft into
ChatGPT, paste the rewrite back, lose your formatting" loop.

The problem it solves: LLMs are genuinely useful at the sentence-and-paragraph
level of writing — sharpening a claim, untangling a clause, proposing a
rewrite — but the friction of shuttling prose between an editor and a chat
window burns any productivity gain. `koda` keeps the editor and the assistant
side-by-side and gives the assistant its own set of revision-safe tools
(`getDocument`, `replaceBlockText`, `insertBlockAfter`, `deleteBlock`) so it
can reason about, and act on, the actual document the writer is looking at.

## Highlights

Features koda is particularly proud of:

- **Agent that edits, not just suggests.** The assistant reads the current
  document with `getDocument` and edits it in place via `replaceBlockText`,
  `insertBlockAfter`, and `deleteBlock` — no copy-paste loop, no diff review
  screen. Edits appear in the editor the same way a human collaborator's
  would.
- **Revision-safe coexistence.** Every agent tool call passes the block's
  observed `revision` number. If the user edited the block in the meantime,
  the service layer rejects the stale write and the model re-fetches and
  retries. Human and agent can't silently overwrite each other.
- **Block-level persistence.** Each paragraph, heading, quote, list item is
  its own row in `document_blocks` with a monotonically-increasing
  `revision`. Whole-document autosave is a last-resort reconciliation;
  targeted edits never round-trip the full JSON.
- **Word-level streaming assistant.** The chat pane is built on
  [assistant-ui](https://github.com/assistant-ui/assistant-ui) so tokens
  stream in as the model produces them, including tool-call progress —
  the writer sees "reading document…" / "replacing block…" as it happens.
- **BlockNote editor with inline-mark fidelity.** Rich text (bold, italic,
  inline code, links) round-trips through the database without collapsing to
  plain text. Supported block types are `paragraph`, `heading`, `quote`,
  `codeBlock`, `bulletListItem`, `numberedListItem`, `checkListItem`.
- **Pre-commit gate with real static analysis.** Every commit runs ESLint,
  Prettier, `tsc --noEmit`, ShellCheck, gitleaks, and
  [squawk](https://squawkhq.com) (Postgres migration safety) locally, and the
  same checks run in GitHub Actions on push and PRs.
- **Deliberately narrow scope.** No auth, no collaboration, no versioning, no
  multi-document navigation. One document per browser, one writer at a time,
  one agent. The whole stack fits in your head.

## Architecture

`koda` is a small monorepo split by runtime:

| Component                  | Stack                                                                       | Role                                                                                         |
| -------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `web/app/`                 | Next.js 16 (App Router), TypeScript, React 19, Tailwind, Mantine            | Editor page, assistant panel, API routes (`/api/documents`, `/api/chat`)                     |
| `web/src/server/`          | `postgres.js`, AI SDK (`@ai-sdk/anthropic`), assistant-ui                   | Document service + repository, agent tool adapters, shared Postgres client                   |
| `web/app/components/`      | BlockNote (`@blocknote/core` + `@blocknote/mantine`), `@assistant-ui/react` | Rich block editor, chat pane, workspace shell that reconciles the two                        |
| `supabase/migrations/`     | Hand-written SQL, managed via the Supabase CLI                              | `documents` and `document_blocks` tables, plus RLS lockdown of the `public` schema           |
| `.github/workflows/ci.yml` | GitHub Actions                                                              | Runs pre-commit (lint/format/typecheck/security) and vitest + Playwright against Postgres 17 |

Runtime stack:

- **Web tier:** Next.js (any Node 24 host — no deployment target is enforced yet).
- **LLM:** Anthropic via the [AI SDK](https://sdk.vercel.ai/).
- **Database:** Postgres, via [Supabase](https://supabase.com) locally. The
  app talks to Postgres directly with `postgres.js`; Supabase's PostgREST and
  GraphQL surfaces are disabled in `supabase/config.toml` and every table in
  `public` has RLS enabled with no policies, so the `anon` and `authenticated`
  roles can't touch the data even if PostgREST were ever flipped back on.
- **Auth:** none. This is a single-user prototype.

### How an agent edit flows end to end

1. The writer types into the BlockNote editor in `document-workspace.tsx`.
   Edits debounce into a whole-document sync against
   `PUT /api/documents/[documentId]/blocks/sync`.
2. In the assistant panel, the writer asks the agent to revise a passage.
   `POST /api/chat` streams the request into Anthropic with the tool set
   defined in `src/server/agent/document-tools.ts`.
3. The model calls `getDocument` to read the current block list with each
   block's current `revision`, then decides which blocks to edit.
4. For each edit, the model calls `replaceBlockText` (or `insertBlockAfter`,
   `deleteBlock`) with the `expectedRevision` it observed. The service layer
   checks revision, persists the change, and returns the new revision so the
   model can chain further edits.
5. The editor polls the server every 2.5s for document changes; on the next
   poll it sees the updated blocks and rehydrates the editor in place. The
   writer sees the agent's edits appear alongside their own.

## Requirements

### Must-haves

- **Node.js 24.15.0 and npm 11.12.1** — pinned in `.nvmrc` and both
  `package.json` `engines` blocks. Root `.npmrc` sets `engine-strict=true`,
  so an `npm ci` on the wrong version fails immediately.
- **Docker Desktop** — `npx supabase start` boots Postgres, the Supabase
  Studio, and the other containers the local stack expects.
- **An [Anthropic API key](https://console.anthropic.com/)** — the
  assistant panel is backed by Anthropic via the AI SDK. Without a key the
  editor still works in manual mode, but the assistant won't respond.

### Nice-to-haves

- **`brew install pre-commit shellcheck gitleaks`** — so the pre-commit
  hook can run locally with the same checks CI runs. `squawk` is installed
  automatically by the hook via its npm dependency.
- **`pyenv` + a modern Python 3** — pre-commit itself is Python-based. If
  you want to avoid touching the system Python, install via pyenv.

## Configuration

`koda` has one environment file:

- **`web/.env.local`** — holds `ANTHROPIC_API_KEY` (required for the
  assistant) and optionally `ANTHROPIC_MODEL` (defaults to
  `claude-sonnet-4-5`) and `DATABASE_URL` (defaults to the local Supabase
  stack at `postgresql://postgres:postgres@127.0.0.1:54322/postgres`).

The file is gitignored. A typical local setup only needs `ANTHROPIC_API_KEY`;
everything else has sensible defaults tuned for `npx supabase start`. See
[`web/.env.example`](web/.env.example) for the full list of variables with
inline documentation — copy it to `web/.env.local` and fill in the required
values.

## Getting started

First-time setup from a clean machine:

```bash
# 1. Clone and install dependencies.
git clone https://github.com/akurilin/koda.git
cd koda
nvm use
npm --prefix web install

# 2. Boot the local Supabase stack and apply migrations.
npx supabase start
npx supabase migration up

# 3. Copy the env template and add your Anthropic API key.
cp web/.env.example web/.env.local
# then edit web/.env.local and set ANTHROPIC_API_KEY=sk-ant-...

# 4. Install the pre-commit hook so local commits run the same gate as CI.
pre-commit install

# 5. Run the dev server.
npm run dev
```

The repo root ships proxy scripts so the common commands don't need a `cd`:

```bash
npm run dev          # next dev, in web/
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run format       # prettier --write .
npm run test         # vitest run (unit + integration)
npm run test:e2e     # next build && playwright test
```

## Static analysis and CI

Every commit runs through [pre-commit](https://pre-commit.com/):

- **ESLint** + **Prettier** + **`tsc --noEmit`** — full TypeScript sanity pass.
- **[shellcheck](https://www.shellcheck.net/)** — catches any future `*.sh`
  scripts before they drift.
- **[gitleaks](https://github.com/gitleaks/gitleaks)** — secret scanning on
  staged changes.
- **[squawk](https://squawkhq.com)** — Postgres migration safety. Configured
  in `.squawk.toml` to skip rules that don't fit Supabase's transactional
  migration runner, while keeping the rules that genuinely prevent downtime
  (table rewrites, unsafe NOT NULLs, type changes, renames).
- Standard hygiene hooks — trailing whitespace, final newline,
  merge-conflict markers, oversized files.

The exact same hook set runs in GitHub Actions on every push and pull
request, plus vitest (unit + integration against a Postgres 17 service
container) and Playwright e2e against `next start`. A full pre-commit + test
run is ~1m40s.

Run the whole suite on demand:

```bash
pre-commit run --all-files
```

## Known trade-offs

This project is a prototype. Some issues below are understood and intentionally
left unaddressed so we can keep moving on the shape of the product rather than
the shape of its concurrency primitives. Each is small, contained, and would
be straightforward to harden when the product requires it.

### Client autosave can drop in-flight keystrokes on agent edits

The workspace shell debounces editor changes into a whole-document sync and
polls the server every 2.5s for out-of-band updates (e.g. an agent edit from
the assistant panel). If a poll returns a changed document _while the user is
mid-keystroke but before the debounce has fired_, the editor is remounted with
the server's version and any unsent typing in the BlockNote buffer is lost.

The minimal fix is a `dirty` flag set on every editor change that pauses
polling while dirty or saving, plus a follow-up save when new edits arrive
during an in-flight request. We have not wired this up because the only
currently deployed writer besides the user is the agent, and concurrent
human/agent edits on the same passage are rare at this stage. When the app
grows either multi-tab usage or a more aggressive agent, this becomes
load-bearing.

### Concurrent appends to the same document can race

`appendBlockRecord` reads `MAX(sort_index) + 1` inside a transaction, but at
READ COMMITTED isolation two concurrent appends on the same document can
still read the same max. One of them will then fail the unique
`(document_id, sort_index)` index and surface as an error rather than retry.

The fix is a per-document advisory lock (`pg_advisory_xact_lock(document_id)`)
at the top of the transaction, matching the pattern already used by
`getOrCreatePrimaryDocumentRecord`. We haven't added it because the append
path today has a single writer per document at a time (the user _or_ the
agent, not both simultaneously), so the race window is effectively empty.
Revisit when we add document-level collaboration or parallel agent tooling.

## Deeper reading

Longer-form write-ups live in [`docs/`](docs/):

- [`docs/agentic-editor-plan.md`](docs/agentic-editor-plan.md) — the
  original product brief and architectural sketch this repo implements.
- [`CLAUDE.md`](CLAUDE.md) — single source of truth for working rules on
  this codebase: runtime pins, the pre-commit gate, Supabase migration
  conventions, SQL identifier rules, and documentation expectations. The
  root `AGENTS.md` is a symlink to this file.

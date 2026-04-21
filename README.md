# koda

A web-based agentic prose editor for article writers. It helps the writer
iterate on individual passages, sections, and paragraphs with support from an
AI assistant — refining style, sharpening content, and clarifying thinking
until the piece feels right.

This repository is a monorepo; the Next.js application lives in `web/` and the
Postgres schema is managed with Supabase migrations in `supabase/migrations/`.

## Getting started

From the repository root:

```bash
nvm use
npm --prefix web install
npm run dev
```

The repo root ships proxy scripts (`npm run lint`, `npm run typecheck`,
`npm run test`, `npm run format`, `npm run dev`, …) that delegate into
`web/`, so day-to-day commands don't need a `cd`.

The Supabase stack must be running locally before the app can read or write
documents:

```bash
npx supabase start
npx supabase migration up
```

## Static analysis (pre-commit)

Every commit runs through [pre-commit](https://pre-commit.com/): ESLint,
Prettier, `tsc --noEmit`, [shellcheck](https://www.shellcheck.net/),
[gitleaks](https://github.com/gitleaks/gitleaks) for secret scanning, and
[squawk](https://github.com/sbdchd/squawk) for Postgres migration safety.

Install the git hook once per checkout:

```bash
pre-commit install
```

To run the full suite against the whole repo on demand:

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
the assistant panel). If a poll returns a changed document *while the user is
mid-keystroke but before the debounce has fired*, the editor is remounted with
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
path today has a single writer per document at a time (the user *or* the
agent, not both simultaneously), so the race window is effectively empty.
Revisit when we add document-level collaboration or parallel agent tooling.

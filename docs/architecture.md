# Architecture

A snapshot of what exists in the repo right now — the modules, the APIs they
expose, the data they persist, and the paths real requests take through them.
This is a descriptive map, not a design document; for the rationale behind the
shape of the system see `docs/agentic-editor-plan.md` and
`docs/workshop-feature.md`.

## Runtime shape

One Next.js 15 app under `web/` (Node 24, TypeScript, Tailwind,
`assistant-ui` + AI SDK + `@ai-sdk/anthropic`, BlockNote for the editor).
Server code talks to Postgres directly via a singleton `postgres.js` client;
Supabase is only used as the Postgres + migration host, not through its JS
client. BlockNote JSON is the canonical block content format, persisted one
row per block.

Top-level directories:

```text
web/app                  Next.js App Router surface (pages + route handlers)
web/app/components       Client components (editor, workspaces, panels)
web/src/server/documents Application + persistence logic
web/src/server/agent     AI SDK tool adapters over the document service
web/src/server/db        Postgres client singleton
web/src/shared           Types safe to import from client and server
supabase/migrations      Schema
```

## Module layers

```text
  ┌──────────────────────────────────────────────────────────────┐
  │  web/app pages + components         (React, client/server)   │
  │    page.tsx, documents/[id]/page.tsx,                        │
  │    documents/[id]/workshop/[blockId]/page.tsx                │
  │    components/document-workspace.tsx                         │
  │    components/workshop-workspace.tsx                         │
  │    components/blocknote-document-editor.tsx                  │
  │    components/assistant-panel.tsx                            │
  │    components/workshop-assistant-panel.tsx                   │
  └──────────────────────────────────────────────────────────────┘
                          │
                          ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  web/app/api/**              (transport layer, route.ts)     │
  │    /api/documents             POST                           │
  │    /api/documents/[id]        GET DELETE                     │
  │    /api/documents/[id]/blocks POST                           │
  │    /api/documents/[id]/blocks/[blockId]       GET PATCH DEL  │
  │    /api/documents/[id]/blocks/[blockId]/move  POST           │
  │    /api/documents/[id]/blocks/sync            PUT            │
  │    /api/chat                  POST  (main-editor agent)      │
  │    /api/workshop/chat         POST  (workshop agent)         │
  └──────────────────────────────────────────────────────────────┘
                          │                    │
                          ▼                    ▼
  ┌─────────────────────────────┐   ┌────────────────────────────┐
  │  web/src/server/documents/  │   │ web/src/server/agent/      │
  │  document-service.ts        │◄──│ document-tools.ts          │
  │  blocknote-blocks.ts        │   │   (AI SDK `tool(...)` defs │
  │    (validation, plaintext,  │   │    bound per-request to a  │
  │     normalization)          │   │    documentId)             │
  └─────────────────────────────┘   └────────────────────────────┘
                          │
                          ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  web/src/server/documents/document-repository.ts             │
  │    raw SQL (postgres.js), row<->domain mapping,              │
  │    transactional reorders/syncs                              │
  └──────────────────────────────────────────────────────────────┘
                          │
                          ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  web/src/server/db/postgres.ts   (shared `sql` client)       │
  │                                                              │
  │  Postgres (Supabase)  documents, document_blocks             │
  └──────────────────────────────────────────────────────────────┘
```

Rules of the road:

- `web/src/shared/documents.ts` is the only module client components import
  from `src/`; nothing in `shared/` may import from `src/server/**` or from
  Node built-ins.
- Every write on the document surface goes through `document-service`. Agent
  tools and HTTP routes differ only in how the call is transported.
- The repository is row-in / row-out. SQL lives nowhere else.

## HTTP APIs

All routes live under `web/app/api`. Responses are JSON; conflicts are
surfaced as HTTP 409 with a `currentBlock` payload so the caller can
reconcile.

### Document CRUD

| Method | Path                         | Purpose                                                                                                                       |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/documents`             | Create a document. Requires `{ testRunId }`; the "real" user document is a singleton created lazily on `/` visits. Test-only. |
| GET    | `/api/documents/:documentId` | Load a document with its ordered blocks.                                                                                      |
| DELETE | `/api/documents/:documentId` | Delete a document (cascades to its blocks).                                                                                   |

### Block CRUD

| Method | Path                                              | Purpose                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/documents/:documentId/blocks`               | Append a block, or insert after `afterBlockId` if the field is present (null = top of doc). Body: `{ blockJson, afterBlockId? }`.                                                                                                  |
| GET    | `/api/documents/:documentId/blocks/:blockId`      | Read one block.                                                                                                                                                                                                                    |
| PATCH  | `/api/documents/:documentId/blocks/:blockId`      | Update a block. Two modes: `{ text, expectedRevision }` replaces the plain text (agent primary verb); `{ blockJson, expectedRevision }` replaces the full structural block (editor save, workshop save). 409 on revision mismatch. |
| DELETE | `/api/documents/:documentId/blocks/:blockId`      | Delete a block. Body: `{ expectedRevision }`. 409 on mismatch.                                                                                                                                                                     |
| POST   | `/api/documents/:documentId/blocks/:blockId/move` | Reorder. Body: `{ afterBlockId, expectedRevision? }` where `afterBlockId: null` means "move to top". Revision check is optional because reorder doesn't change content.                                                            |
| PUT    | `/api/documents/:documentId/blocks/sync`          | Whole-document save used by the main editor's debounced autosave. Body: `{ blocks, expectedRevisions }`. The server runs per-block optimistic-concurrency checks and returns the canonical blocks; 409 on any block mismatch.      |

### Chat

| Method | Path                       | Purpose                                                                                                                                                                                                                                                                                                |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/chat?documentId=...` | Main editorial assistant. Streams an AI SDK text+tool response. Tools are bound to the `documentId` from the query string so the model can't cross-address documents. System prompt enforces "read-before-write with latest revision".                                                                 |
| POST   | `/api/workshop/chat`       | Workshop agent. Stateless about the database. Body: `{ messages, context: { documentBlocks, targetBlockId, versions, currentVersionIndex } }`. Renders a system prompt from the context and exposes exactly one tool (`proposeRewrite`) whose only job is to validate inline content and echo it back. |

Both chat routes use `anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5")`
and cap tool-call recursion with `stepCountIs(...)`.

## Core types

Defined in `web/src/shared/documents.ts`. Safe to import from either side of
the network.

- `SupportedBlockType` — narrowed list the backend will persist:
  `paragraph | heading | quote | codeBlock | bulletListItem |
numberedListItem | checkListItem`.
- `InlineText` / `InlineLink` / `InlineContent` — BlockNote inline runs and
  the discriminated union over them.
- `BlockNoteBlock` — the JSON persisted per block: `{ id, type, props,
content, children }`. `children` is always empty (the app treats documents
  as flat) but kept on the type because BlockNote emits the field.
- `DocumentRecord` — `documents` row: `{ id, testRunId, createdAt,
updatedAt }`.
- `DocumentBlockRecord` — `document_blocks` row: `{ id, documentId,
sortIndex, blockType, contentFormat, blockJson, plainText, revision,
createdAt, updatedAt }`.
- `DocumentWithBlocks` — document + its ordered blocks.
- `MutationResult<T>` — `{ ok: true, value } | { ok: false, reason:
"conflict", currentBlock }`. Every write returns this union so callers
  branch on conflicts rather than catching exceptions.

Workshop-only client types live with the component
(`web/app/components/workshop-workspace.tsx`): `Version` is a slot in the
client-owned version stack, `ViewMode` toggles between edit/diff views, and
`WorkshopChatContext` is the payload the client sends with each workshop
chat turn.

Agent tool input/output shapes are defined inline in
`web/src/server/agent/document-tools.ts` via Zod schemas.

## Database

One Postgres schema managed by Supabase migrations under
`supabase/migrations/`. Latest shape (after the five migrations):

### `documents`

```sql
id           UUID PRIMARY KEY DEFAULT gen_random_uuid()
test_run_id  UUID NULL
created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
```

- Partial unique index `documents_primary_singleton_key ON ((TRUE)) WHERE
test_run_id IS NULL` enforces at most one "real" user document. Test runs
  get their own rows, each tagged with their `test_run_id`.
- Partial index `documents_test_run_id_idx` on non-null `test_run_id` for
  test cleanup.
- `updated_at` is maintained by the shared `set_updated_at()` trigger.

### `document_blocks`

```sql
id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT
document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE
sort_index      INTEGER NOT NULL  -- contiguous, no gaps, 0-based
block_type      TEXT NOT NULL     -- in supportedBlockTypes, enforced by CHECK
content_format  TEXT NOT NULL DEFAULT 'blocknote_v1'  -- enforced by CHECK
block_json      JSONB NOT NULL
plain_text      TEXT NOT NULL DEFAULT ''
revision        INTEGER NOT NULL DEFAULT 1  -- >= 1
created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
```

- Unique `(document_id, sort_index)` — the two-phase reorder in the
  repository parks rows at `1_000_000 + i` before writing final indices to
  avoid tripping this mid-update.
- Index on `(document_id, sort_index)` for ordered loads.
- `updated_at` via the shared trigger.
- RLS is enabled but no policies exist, so the PostgREST-exposed `anon` /
  `authenticated` roles cannot read or write. The Next.js server connects as
  `postgres` (superuser), which bypasses RLS.

Nesting was dropped in migration 4 (`20260421105817_drop_block_nesting.sql`);
the `title` column on `documents` was dropped in migration 3. Block IDs are
`TEXT` rather than `UUID` because BlockNote block IDs are editor-native
strings.

## Data flows

### 1. Document sync (main editor)

The main workspace treats the client as the edit buffer and PUTs the full
block list on a 600ms debounce. Per-block optimistic concurrency lives in
the repository's sync routine.

```text
┌─────────────────┐         keystroke
│ BlockNoteEditor │─────────────────────────────────────┐
└─────────────────┘                                     │
        │ onChange(blocks)                              │
        ▼                                               │
┌────────────────────────┐                              │
│ DocumentWorkspace      │  debounce 600ms              │
│  (handleEditorChange)  │                              │
└────────────────────────┘                              │
        │ fetch PUT                                     │
        ▼                                               │
┌──────────────────────────────────────┐                │
│ PUT /api/documents/:id/blocks/sync   │                │
│   body: { blocks, expectedRevisions }│                │
└──────────────────────────────────────┘                │
        │                                               │
        ▼                                               │
  syncDocumentBlocks (document-service)                 │
        │ prepareBlock(...) per block                   │
        │   - normalizeBlock()  -> reject bad shapes    │
        │   - blockToPlainText  -> keep projection      │
        ▼                                               │
  syncDocumentBlockRecords (repository)                 │
        │ SELECT ... FOR UPDATE                         │
        │ per-block revision check; 409 on mismatch ────┤
        │ two-phase sort-index rewrite                  │
        │ INSERT new, UPDATE changed, DELETE dropped    │
        │ bump revision only when block_json differs    │
        ▼                                               │
  Postgres (documents, document_blocks)                 │
        │                                               │
        │ returns canonical blocks                      │
        ▼                                               │
  Client reseats local state + lastEditorSnapshot       │
  (used by the 2.5s background poll to decide whether   │
   to bump `editorVersion` and remount BlockNote)       │
                                                        │
                   conflict path ◄─────────────────────┘
        │
        ▼ refreshDocument() -> GET /api/documents/:id
        ▼ setEditorVersion++ if DB snapshot ≠ buffer
```

Background polling runs every 2.5s while no save is in flight. It exists so
agent-driven writes become visible even if the user never focuses the
editor. A bare-string `JSON.stringify` of the current blocks is used to
skip remounts when the server hasn't actually diverged from the buffer —
otherwise the poll would clobber the caret position.

Single-block edits (insert-after, move, delete, full replace) use the
`/blocks/:blockId` routes directly and do not go through sync. They return
the updated block(s), and the polling loop brings the rest of the client
back in line.

### 2. Main editor agent

The right-hand `AssistantPanel` is a pure consumer of the assistant-ui
runtime the workspace owns. The workspace owns the runtime so that it can
observe `thread.isRunning` and lock the editor while the agent writes.

```text
┌──────────────────┐ user text
│ AssistantPanel   │──────────────────────────────────────┐
└──────────────────┘                                      │
        │ assistant-ui runtime, AssistantChatTransport    │
        ▼                                                 │
┌──────────────────────────────────────────────┐          │
│ POST /api/chat?documentId=<id>               │          │
│   body: { messages: UIMessage[] }            │          │
└──────────────────────────────────────────────┘          │
        │ streamText(anthropic(...),                      │
        │   tools: createDocumentTools(<id>),             │
        │   stopWhen: stepCountIs(5))                     │
        │                                                 │
        │    ┌───────────────────────────────┐            │
        │    │ Tools (bound to documentId):  │            │
        │    │   getDocument                 │            │
        │    │   replaceBlockText            │            │
        │    │   insertBlockAfter            │            │
        │    │   deleteBlock                 │            │
        │    └───────────────────────────────┘            │
        │              │                                  │
        │              ▼                                  │
        │    document-service (same paths as HTTP)        │
        │              │                                  │
        │              ▼                                  │
        │    document-repository  -> Postgres             │
        │                                                 │
        ▼ SSE tokens + tool results                       │
   assistant-ui renders stream                            │
                                                          │
  useAuiState(thread.isRunning) ──────────────────────────┘
        ▼
  DocumentWorkspace side-effects:
    on start  -> flush pending autosave, setReadOnly(true)
    on finish -> refreshDocument() so the editor rehydrates
                 with the agent's final state before the
                 user can type again
```

The model never sees raw rows. `getDocumentTool` returns just `{ id, type,
text, revision, sortIndex }` per block — enough to reason and to thread
`expectedRevision` through subsequent edits. On conflict, tools return
`{ ok: false, reason, currentBlock }` rather than throwing, so the model
self-corrects by re-reading and retrying within the 5-step budget.

### 3. Workshop mode

The workshop is URL-routed
(`/documents/:documentId/workshop/:blockId`) so back-button / reload /
sharing all resolve from the URL. The session's contents (versions stack,
chat history, currently selected version) live only in client memory.

```text
Side-menu hammer on a paragraph ──► enterWorkshop(block)
                                    │
                                    ▼
               router.push("/documents/:id/workshop/:blockId?scrollY=...")
                                    │
                                    ▼
            page.tsx (server) validates doc + block exist
                                    │
                                    ▼
          DocumentWorkspace renders <WorkshopWorkspace>
          with the whole doc + target block + revision

  ┌────────────────────────────────────────────────────────────────────┐
  │                       WorkshopWorkspace                            │
  │                                                                    │
  │   state: { versions: Version[], currentVersionIndex, viewMode }    │
  │   versions[0] = clone(targetBlock) at entry                        │
  │                                                                    │
  │  ┌────────────────────────┐     ┌──────────────────────────────┐   │
  │  │ BlockNote editor       │     │ WorkshopAssistantPanel       │   │
  │  │  seeded with whole doc │     │  transport -> /api/workshop/ │   │
  │  │  locked to target id   │     │    chat                      │   │
  │  │  onChange -> mutate    │     │  body() reads contextRef on  │   │
  │  │  current version in    │     │    every send                │   │
  │  │  place                 │     │                              │   │
  │  └────────────────────────┘     └──────────────────────────────┘   │
  │                                              │                     │
  │                                              │ proposeRewrite tool │
  │                                              │ result arrives      │
  │                                              ▼                     │
  │                          append new Version { origin: "agent" }    │
  │                          advance currentVersionIndex, editorKey++  │
  │                          play ProposalFlash (word-diff overlay)    │
  └────────────────────────────────────────────────────────────────────┘

Cancel  ──► discard, router.push("/documents/:id?focus=:blockId&scrollY=...")
            (back-button guard uses a pushed sentinel + popstate listener
             so the browser back button is intercepted for the confirm
             dialog if there are unsaved changes)

Save    ──► one block in editor   -> PATCH /api/documents/:id/blocks/:blockId
                                      { blockJson, expectedRevision }
            multiple blocks       -> confirm dialog -> consolidate (join
                                      `content` arrays with " ", keep
                                      first block's type) then PATCH
            onSaved(updatedBlock) ──► parent merges into main doc state,
                                      router.push back to the main URL
                                      with focus + scrollY preserved
```

Workshop chat turn in detail:

```text
POST /api/workshop/chat
  body: {
    messages: UIMessage[],
    context: {
      documentBlocks: BlockNoteBlock[],     // full main doc for context
      targetBlockId: string,
      versions: InlineContent[][],          // V0..Vn
      currentVersionIndex: number,
    }
  }

server:
  composeWorkshopSystemPrompt(context)
    - renders each block as markdown-flavored text with ` **bold** `,
      ` _italic_ `, ` `code` `, ` ~~strike~~ `, ` [text](url) `
    - marks the target block with " <<< WORKSHOP"
    - prints version history labels (V0 (original), Vk (current — ...))
    - appends current version's raw InlineContent JSON verbatim so the
      model can copy the exact styles key shape

  streamText(anthropic, system, messages, tools: { proposeRewrite },
             stopWhen: stepCountIs(3))

  proposeRewrite({ content: InlineContent[] }):
    execute:
      try   -> normalizeInlineContentArray(content)
                  -> { ok: true, content: normalized }
      catch -> { ok: false, reason }

client:
  WorkshopToolUIRegistration registers a stable tool-UI renderer for
  `proposeRewrite`. On `status === "complete"` + `ok === true` it calls
  handleProposedRewrite(content) exactly once per tool invocation:
    - snapshot current live text as `from`
    - append a new Version { origin: "agent", blocks: [one paragraph with
      the target block's id and the normalized content] }
    - advance currentVersionIndex, bump editorKey (BlockNote remount),
      setViewMode("latest")
    - play the 900ms ProposalFlash overlay (word-level jsdiff against the
      previous text) unless prefers-reduced-motion
```

Key containment property: the workshop agent cannot touch the database. It
cannot see block IDs beyond what the client chose to put in the prompt, it
has no tools other than `proposeRewrite`, and `proposeRewrite` is a pure
validator that echoes normalized inline content back to the client. All
persistence happens through the normal `PATCH /api/documents/:id/blocks/
:blockId` endpoint at Save time.

While the workshop is mounted:

- The main doc is not loaded — `DocumentWorkspace` renders `WorkshopWorkspace`
  _instead of_ the main editor when the URL carries a `workshopBlockId`.
- The main-editor agent isn't running. The main-editor background poll isn't
  running. No concurrency guards are needed on save because no concurrent
  actor exists by construction (see `docs/workshop-feature.md`).
- The workshop editor shows the whole document for context, but a
  ProseMirror `filterTransaction` extension (`buildLockedBlockExtension`)
  rejects any doc-changing transaction whose steps touch positions outside
  the target block's range. Caret can move into neighbors; typing in them
  is a no-op.

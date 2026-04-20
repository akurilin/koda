# Agentic Editor Implementation Plan

## Purpose

This project is a web-based agentic prose editor for article writers. The first
implementation should focus on a single main screen with:

- A rich-text, block-based prose editor on the left.
- A chat-style assistant pane on the right.
- A backend agent that can inspect and edit article content without depending on
  the frontend being open.

The system should support local development exploration first. Authentication,
authorization, comments, collaboration, document-level version history, and
advanced synchronization are explicitly out of scope for the first
implementation.

## Current Technology Assumptions

- App framework: Next.js in `web/`.
- Language: TypeScript.
- Styling: Tailwind CSS.
- Package manager: npm.
- Runtime: Node.js version pinned in the root `.nvmrc`.
- Database: standard Supabase with local Supabase CLI support.
- Schema management: Supabase migrations in `supabase/migrations/`.
- Chat UI: `assistant-ui`.
- LLM vendor for the first pass: Anthropic.
- Editor candidates under consideration: BlockNote and open-source Tiptap.

Supabase's own migration tracking should be the source of truth for schema
changes. We should not introduce a separate migration tracker unless that is
explicitly revisited later.

## Product Shape

The first version should be one main application screen. The layout can be fixed
width for now:

- Left pane: rich text editor.
- Right pane: assistant chat.

The app should be able to open directly to a specific document from the URL. A
simple document ID parameter is good enough for the first pass, for example:

```text
/documents/:document_id
```

This supports manual development, pre-created database fixtures, and Playwright
QA scenarios that need to open a known document directly.

The editor should feel closer to Notion or Google Docs than to a markdown editor.
Writers should be able to use normal rich-text interactions and shortcuts for
paragraphs, headings, bold, italic, quotes, code formatting, and similar prose
editing primitives.

Images, audio notes, comments, collaboration, and more complex media blocks can
come later. The first pass should focus on text blocks and core editing
operations.

## First-Pass Scope

The first implementation should do only three product things:

1. Pass automated tests for the core backend document editing workflows through
   the shared document service.
2. Let a user see and manually edit a document in the left-pane editor.
3. Let a user chat with an agent in the right pane and ask it to read and edit
   the document through tools.

Anything beyond those three goals should be treated as second-pass work unless it
is required to make the first pass reliable.

## Editor Direction

### BlockNote

BlockNote is the leading candidate for the first implementation.

Reasons:

- Its native document model is already block-based.
- A document is represented as a list of blocks.
- Each block has an `id`, `type`, `props`, `content`, and `children`.
- Inline rich text is represented as structured JSON.
- Block IDs are stable for the lifetime of a block.
- It includes ready-made block editor UI behavior that is close to the desired
  Notion-like experience.
- Its block JSON maps naturally to a `document_blocks` database table.
- It provides server-side utilities for conversion/export use cases, though the
  core backend mutation path should not require a browser editor instance.

BlockNote's native block JSON should be treated as the persisted content format
if we choose it.

### Tiptap

Tiptap remains a viable alternative, especially if the editor eventually needs
lower-level ProseMirror control.

Tradeoffs:

- Tiptap stores content as a ProseMirror/Tiptap JSON document tree.
- Top-level nodes can be mapped to blocks, but stable application block IDs must
  be added explicitly.
- We would need more custom glue for block identity, split/merge handling,
  duplicate IDs on copy/paste, and reconstructing a full document from block
  rows.
- It gives more control, but more editor product work would be ours.

Tiptap is a better choice if we decide to invest heavily in custom editor
behavior early. BlockNote is the better first choice if we want to ship a usable
block editor and agent mutation model quickly.

## Core Architecture

The frontend editor and backend agent must not create separate document write
paths. They should both go through the same application-level document mutation
service.

```text
BlockNote UI
   |
   | HTTP route or server action
   v
document service
   |
   v
Supabase document tables

Agent tools
   |
   | in-process call or HTTP call
   v
document service
   |
   v
Supabase document tables
```

The frontend should not write directly to Supabase document tables. Supabase is
the database and migration system, not the public document mutation API.

The document service owns the write model:

- Validate block JSON.
- Normalize block JSON.
- Enforce stable block IDs.
- Extract and store plain text.
- Enforce ordering.
- Handle inserts, updates, deletes, and moves.
- Increment block revisions.
- Check optimistic concurrency.
- Write block revision rows once block history is enabled.
- Return structured results suitable for both UI and agent callers.

The UI and agent should differ only in transport:

- The browser calls HTTP routes or Next server actions.
- The backend agent calls the service directly if in-process, or through the same
  HTTP API if it runs separately.

## Canonical Content Model

The canonical persisted content should be one row per document block, not one
large document JSON blob.

However, each block's rich-text content should remain editor-native JSON. We
should not decompose inline formatting into relational rows in the first pass.
That would create unnecessary mapping complexity for bold, italic, code spans,
links, and future inline content.

The database should therefore be block-relational:

- Document metadata is relational.
- Block ordering and identity are relational.
- Each block's editor content is JSONB.
- Plain text is extracted and stored for search, previews, and agent context.

If using BlockNote, a persisted block maps closely to BlockNote's block shape:

```json
{
  "id": "block-id",
  "type": "paragraph",
  "props": {},
  "content": [
    {
      "type": "text",
      "text": "This is a paragraph.",
      "styles": {}
    }
  ],
  "children": []
}
```

For the first pass, nested blocks can be deferred by keeping `parent_block_id`
null and `children` empty. The schema should still leave room for nesting later.

## Initial Database Shape

The first useful schema can be small:

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL DEFAULT '',
  test_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_blocks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_block_id TEXT REFERENCES document_blocks(id) ON DELETE CASCADE,
  sort_index INTEGER NOT NULL,
  block_type TEXT NOT NULL,
  content_format TEXT NOT NULL DEFAULT 'blocknote_v1',
  block_json JSONB NOT NULL,
  plain_text TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (document_id, parent_block_id, sort_index)
);
```

`document_blocks.id` is text because BlockNote block IDs are editor-native
strings. Agent-created blocks can still use UUID strings, but the database should
not require every block ID to be a PostgreSQL UUID.

`block_json` is the canonical rich content for a block. `block_type`,
`plain_text`, `sort_index`, `content_format`, and `revision` are operational
fields that make ordering, querying, synchronization, and agent context easier.
`test_run_id` is nullable and should only be set by automated integration or QA
tests so test-created documents can be cleaned up without touching developer
documents.

Use PostgreSQL naming conventions consistently:

- Unquoted lower-case identifiers.
- Underscores between words.
- Upper-case SQL key words.
- No quoted mixed-case application identifiers.

## Future Block History

Document-level version history is out of scope for now, but block-level history
is an important product direction. The schema should be easy to extend with a
block revision table:

```sql
CREATE TABLE document_block_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_block_id UUID NOT NULL REFERENCES document_blocks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  block_json JSONB NOT NULL,
  plain_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (document_block_id, revision)
);
```

This would let the product show how an individual paragraph or block evolved
through user edits and agent edits without requiring whole-document history.

For the first implementation, the service should still maintain a `revision`
number on `document_blocks` so optimistic concurrency and later history are
straightforward.

## Agent Editing Model

The agent should not receive direct SQL access and should not interact with the
browser UI. It should call constrained document tools backed by the same document
service used by the UI.

Initial tool operations should include:

- `get_document(document_id)`
- `get_block(block_id)`
- `replace_block_text(block_id, text, expected_revision)`
- `replace_block(block_id, block_json, expected_revision)`
- `insert_block_after(reference_block_id, block_json)`
- `delete_block(block_id, expected_revision)`
- `move_block(block_id, after_block_id)`

For the first pass, `replace_block_text` is the most important operation. It
allows the agent to iterate on one paragraph or heading at a time while
preserving the block's identity, type, and ordering.

Example behavior:

```ts
await documentService.replaceBlockText({
  documentId,
  blockId,
  text,
  expectedRevision,
  source: "agent",
});
```

The service should reject stale writes when `expectedRevision` does not match the
current block revision.

## Frontend Synchronization

The frontend should load the ordered block rows for a document and reconstruct
the editor document from their `block_json` values.

When the user edits in BlockNote:

```text
BlockNote change
  -> translate changed block(s) into document operation(s)
  -> API route or server action
  -> document service
  -> Supabase
```

When the agent edits:

```text
Agent tool
  -> document service
  -> Supabase
  -> frontend observes update
  -> BlockNote editor updates visible block(s)
```

For the first pass, use the simplest workable synchronization model. The page can
load a document, save edits through the API/service path, and refresh its local
editor state after known writes. We should avoid building a cursor log, realtime
subscription, CRDT, or full collaborative editing model in v1.

If the agent writes while the page is open, the v1 UI can use a simple refresh
after agent responses, a coarse manual refresh, or a small focused polling loop
for the active document. This should be treated as a temporary product
implementation, not the long-term sync model.

Second-pass synchronization should introduce a small append-only cursor log:

```sql
CREATE TABLE document_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  block_id UUID,
  operation TEXT NOT NULL,
  source TEXT NOT NULL,
  block_revision INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The long-term client flow can then become:

```text
initial load:
  GET /api/documents/:id
  -> returns ordered blocks and latest change cursor

subsequent sync:
  GET /api/documents/:id/changes?after=<cursor>
  -> returns changed blocks, deleted block IDs, and latest cursor
```

Supabase Realtime can later become an invalidation signal on top of that cursor
log. The durable source of truth should remain the document API and database, not
the realtime event itself.

## Concurrency Model

The first implementation should avoid CRDT and operational transform complexity.
The system should instead use block-level optimistic concurrency.

Every block has a `revision`. Every update or delete operation must include an
`expectedRevision`. The service should only write when the expected revision
matches the current revision:

```sql
UPDATE document_blocks
SET
  block_json = $1,
  plain_text = $2,
  revision = revision + 1,
  updated_at = now()
WHERE id = $3
  AND revision = $4
RETURNING *;
```

If no row is returned, the write is stale and must be rejected. This prevents the
agent or UI from silently overwriting a block that changed after it was read.

This is intentionally block-level conflict detection, not character-level
collaboration. Concurrent edits to different blocks should succeed. Concurrent
edits to the same block should produce a visible conflict or failed write.

Second-pass options for improving the user experience:

- Advisory active-block state so the agent avoids blocks the user is currently
  editing.
- Conflict snapshots so rejected agent proposals can still be shown to the user.
- Agent retry behavior that rereads the current block and proposes a new edit
  after a conflict.
- Supabase Realtime or cursor-log invalidation so remote edits appear quickly in
  the UI.

## Test-First Development Plan

The architecture should support red-green-refactor development. The core
document behavior should be testable before wiring up BlockNote UI or Anthropic
tool calls.

Primary test target:

```text
tests
  -> document service
  -> repository / SQL
  -> local Supabase Postgres
```

Recommended test layers:

1. Pure block utility unit tests.
2. Document service integration tests against local Supabase/Postgres.
3. API route tests for the UI path.
4. Agent tool adapter tests with no real LLM call.
5. Playwright QA tests for the visible editor and agent experience.

Core operations to cover:

- Create document.
- Create block.
- Append block.
- Insert block before or after another block.
- Replace block text.
- Replace full block JSON.
- Delete block.
- Reorder block.
- Reconstruct ordered document JSON from block rows.
- Extract plain text.
- Preserve block IDs across edits.
- Increment revision on meaningful edits.
- Reject stale `expected_revision` writes.
- Reject invalid block types or malformed block content.
- Confirm UI-path calls and agent-tool calls produce the same database state.

The LLM itself should not be part of deterministic integration tests. Agent-path
tests should start at the tool boundary by passing explicit arguments into the
agent tool adapter and verifying that it delegates to the same document service.

Playwright QA tests should cover the two first-pass product scenarios:

1. Manual editor QA:
   - Open the app against a test document.
   - Type a short document with three or four blocks.
   - Validate through the UI that the expected blocks are visible after save or
     refresh.
   - Prefer a black-box assertion through the UI for this first pass. White-box
     database assertions can be added later if they are needed for debugging.
2. Agent QA:
   - Start from a carefully prepared test document.
   - Ask the agent to make one specific low-ambiguity edit, such as replacing a
     known paragraph with exact target text.
   - Wait for the agent/tool call to complete.
   - Validate through the UI that the expected document change is visible.

The agent QA test is allowed to call Anthropic and spend tokens. It should be
kept narrow, deterministic, and easy to diagnose. The main integration test suite
should still avoid real LLM calls.

Suggested test files:

```text
web/tests/unit/blocknote-blocks.test.ts
web/tests/integration/document-service.test.ts
web/tests/integration/document-tools.test.ts
web/tests/integration/document-api.test.ts
web/tests/e2e/manual-editor.spec.ts
web/tests/e2e/agent-edit.spec.ts
```

`document-service.test.ts` should cover:

- Creating a document.
- Appending blocks.
- Inserting a block before or after another block.
- Replacing block text.
- Replacing full block JSON.
- Deleting blocks.
- Moving/reordering blocks.
- Rebuilding ordered editor JSON from persisted block rows.
- Preserving block IDs across edits.
- Incrementing block revisions on meaningful edits.
- Rejecting stale `expected_revision` writes.
- Rejecting malformed or unsupported block content.

`document-tools.test.ts` should cover the agent path without making a real LLM
call. It should seed a test document, call agent tool functions directly, and
assert that the resulting document state matches the document service behavior.

`document-api.test.ts` should cover the UI path without rendering the browser. It
should hit the API routes that the frontend uses and verify that they call the
same document service behavior.

`manual-editor.spec.ts` should be a black-box Playwright test:

- Create a test document.
- Open the document URL directly.
- Type a short document with three or four blocks.
- Save or wait for autosave.
- Reload the page.
- Assert the expected block text is visible in the editor.
- Delete the test document.

`agent-edit.spec.ts` should be opt-in because it calls Anthropic. It should:

- Require `RUN_AGENT_QA=true`.
- Create a carefully prepared test document.
- Open the document URL directly.
- Ask the agent to make one exact edit to one known block.
- Assert the edited text is visible.
- Assert neighboring blocks remain unchanged.
- Delete the test document.

Suggested package scripts:

```json
{
  "test": "vitest run",
  "test:unit": "vitest run tests/unit",
  "test:integration": "vitest run tests/integration",
  "test:e2e": "next build && PLAYWRIGHT_PORT=$(node scripts/random-qa-port.mjs) playwright test tests/e2e/manual-editor.spec.ts",
  "test:e2e:agent": "next build && PLAYWRIGHT_PORT=$(node scripts/random-qa-port.mjs) RUN_AGENT_QA=true playwright test tests/e2e/agent-edit.spec.ts"
}
```

Playwright QA should write traces, screenshots, reports, and other test artifacts
outside the repository, under `/tmp/koda/playwright/...`. It should also run the
application on a randomly selected available high port, never on ports
`3000`-`3005`, so QA can run while local development copies of the app are
already running.

## Test Data Strategy

Do not reset or wipe the shared local Supabase database as part of normal test
runs. Tests should create their own documents and delete only those documents
after completion.

Test-created records should be identifiable:

- Set `documents.test_run_id` for every integration or QA-created document.
- Prefer deleting by document ID collected during the test.
- Use `test_run_id` as the cleanup fallback if a test fails before deleting its
  records.
- Title prefixes such as `qa_` or `test_` can still help with manual inspection,
  but they should not be the primary cleanup mechanism.

Integration and Playwright tests should not interact with developer-created
documents. If a test fails before cleanup, a follow-up cleanup helper can delete
documents with the test prefix or `test_run_id`.

This is less isolated than a dedicated test database, but it avoids the
complexity of managing a second Supabase database during the first pass.

## Suggested Code Organization

The exact paths can change, but the implementation should keep these boundaries:

```text
web/src/server/documents/
  document-service.ts
  document-repository.ts
  blocknote-blocks.ts
  types.ts

web/src/server/agent/
  document-tools.ts

web/app/api/documents/
  ...

web/tests/integration/
  document-service.test.ts
  document-api.test.ts
  document-tools.test.ts
```

`blocknote-blocks.ts` should hold pure functions such as:

```ts
blockToPlainText(block);
replaceBlockText(block, text);
validateBlock(block);
normalizeBlock(block);
buildDocumentFromRows(rows);
flattenDocumentBlocks(blocks);
```

These functions should be easy to unit test without a database.

## Initial Implementation Sequence

1. Add the first Supabase migration for `documents` and `document_blocks`.
2. Add TypeScript types for the supported block format.
3. Add pure block utilities and tests.
4. Add document repository functions using direct SQL or the chosen Supabase
   server client.
5. Add document service operations and integration tests.
6. Add API routes or server actions for UI callers.
7. Add agent tool adapters that call the document service.
8. Add BlockNote UI and wire editor changes through the API/service path.
9. Add assistant-ui chat shell.
10. Wire Anthropic tool calls to the agent tool adapter.
11. Add Playwright QA for manual editing.
12. Add Playwright QA for one deterministic real-agent edit.

## Open Review Points

- Confirm BlockNote as the first editor library, or choose Tiptap before writing
  the content schema and editor utilities.
- Decide whether the first pass should support only flat top-level blocks.
- Decide whether block revisions should be implemented immediately or only
  prepared for through the `revision` column.
- Decide whether frontend synchronization starts with polling or Supabase
  Realtime.
- Decide whether document writes should use API routes, server actions, or both.

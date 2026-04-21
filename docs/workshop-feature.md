# Workshop Mode — Feature Plan

A focused, modal editing session for refining a single paragraph with help
from an AI agent. Entered from the BlockNote side menu on a paragraph block,
exited with either Save (writes back to the main doc) or Cancel (discards).

## Why this exists

Writers often want to iterate intensively on one passage — trying wordings,
sharpening an argument, compressing, rewriting from a different angle —
without the surrounding document pulling their attention. The main-doc agent
is great for focused edits in context, but it mixes the "what does the doc
look like now" view with the "what does this one paragraph want to be" view.
Workshop mode separates those: the user gets a dedicated surface where the
paragraph is the whole world and the agent is a collaborator on that
paragraph only.

## Core design decisions

The decisions below are intentional scope constraints for the prototype.
Each is cheap to revisit later; several are deliberately the simplest
behavior that ships a useful v1.

### Modal, not tabbed

Entering workshop mode replaces the main workspace view entirely. There is
no "switch back to the doc while the workshop is open" affordance. The user
exits via Cancel or Save.

**Why:** removes concurrency entirely — the main doc cannot be edited while
a workshop is open, so we never need conflict-resolution UI, no version
races between workshop and main-doc agent, no stale revision handling.

### Ephemeral

Workshop state (versions, chat history) lives only in client memory. A page
reload or a Cancel discards everything. There is no `workshop_sessions`
table, no resume, no cross-session memory for the agent.

**Why:** matches the "scratch space" mental model and avoids the
migration/sync churn of persisting a speculative UI state.

### Version = `InlineContent[]`

A version is the paragraph's rich inline content (text runs, bold, italic,
links). Plain text is only derived for chat context, system prompts, and
diff rendering. Bold, italic, and links round-trip through agent proposals
and Save untouched.

**Why:** plain-text flattening would silently strip the user's formatting
choices, which is jarring. Working at the inline-content level keeps the
existing normalization/persistence pipeline unchanged.

### V0 is the original, agent proposals append

`versions[0]` is captured from the target paragraph at the moment the user
enters workshop mode. Each `proposeRewrite` tool call from the agent
appends a new entry. User navigation via arrow controls cycles through
`versions` in order.

### User edits mutate the current version in place

When the user is on V_k and hand-edits the paragraph, those edits update
`versions[k]` directly. They do not branch into a new version. Clicking
another version, then back to V_k, still shows the edited text.

**Why:** predictable mental model ("you are editing *this* version") and
avoids a combinatorial explosion of tiny hand-edit branches in the history.

### One agent tool only: `proposeRewrite`

The workshop agent's only capability outside of plain-text chat is to call
`proposeRewrite({ content: InlineContent[] })`. It cannot touch the
database, cannot edit any other block, cannot even see block IDs. The
server validates the content shape through the same `normalizeInlineContent`
path the main write surface uses, then returns it verbatim to the client.

**Why:** strongest possible containment — the workshop agent can only
affect the client's version stack, never the authoritative document.

### Full main doc is sent as context every turn

The client includes the full main document in the request payload on every
chat turn. The server renders it into the system prompt with the target
paragraph clearly marked, and appends the current version history.

**Why:** prose documents are tiny; it's far simpler than a stateful
server-side session, and it guarantees the agent always reasons against
the current doc.

### No concurrency guards

Save calls `replaceBlock` with no `expectedRevision`. If the target block
has been changed or deleted by another process between opening the
workshop and saving, the save either overwrites or throws. The workshop
may crash.

**Why:** no concurrent actor can exist by construction (main doc is frozen
while workshop is open, no background agent runs) except in extreme edge
cases. Building conflict UI for a case that can't happen isn't worth the
code.

### Save consolidates at the boundary, not during editing

BlockNote's Enter key is not intercepted. The workshop editor allows the
user to create multiple blocks freely. At Save time, we count the blocks:

- 1 block → save directly with the existing type preserved.
- \>1 blocks → confirm dialog ("save as single paragraph?"); if confirmed,
  join the blocks' `content` arrays with a single space separator, using
  the first block's type. Then save.

**Why:** never fight the editor. The constraint ("one block out") matters
only at commit time and is enforced there with a clear, cancellable UX.

### Block type is preserved from the workshop

If the user changes the block type inside the workshop (paragraph →
heading → quote, via BlockNote's slash menu), the saved block uses
whatever type the workshop ended with. We don't force it back to the
original type.

**Why:** the user may legitimately decide "this wants to be a quote" mid-
workshop; honoring that matches intent.

## UI shape

### Entry

BlockNote side menu (the six-dot drag handle dropdown). A new "Workshop"
item is injected at the top of the menu, shown only when the hovered
block is a paragraph. Clicking it fires `onWorkshop(block)` up to the
workspace.

### Workshop mode layout

Main workspace is swapped for a workshop view:

- **Top banner:** "Workshop mode" label, view-mode toggle, version
  navigation, Cancel button, Save button.
- **Left pane:** a scoped BlockNote editor seeded with the currently
  selected version. Edits update that version in place.
- **Right pane:** the existing AssistantPanel component, but the transport
  points to `/api/workshop/chat` and the runtime is a fresh instance per
  session.

### View modes

- **Latest** (default): render the currently selected version as regular
  inline content. Arrow controls move between versions.
- **Diff vs previous**: word-level diff between the selected version and
  the one immediately before it. Read-only.
- **Diff vs original (V0)**: same rendering, compared against V0.

Diffs are computed on the plain-text projection of each version using
`jsdiff`. The underlying rich content is preserved regardless of which
view mode is active; toggling modes never mutates a version.

### Cancel

Returns to the main document. For the prototype, no confirm dialog. The
user knows cancel discards — matches the ephemeral framing.

### Save

- 1 block in the editor: build the new `blockJson`, call
  `PATCH /api/documents/:docId/blocks/:blockId`, return to main doc.
- \>1 blocks: consolidation dialog; if confirmed, join `content` arrays
  with `" "`, save as one block of the first block's type.

## Data flow

### Chat turn payload

```ts
POST /api/workshop/chat
{
  messages: UIMessage[],               // full conversation, client-owned
  context: {
    documentBlocks: BlockNoteBlock[],  // full main doc for context
    targetBlockId: string,             // the paragraph being workshopped
    versions: InlineContent[][],       // v0 = original, v1..vN
    currentVersionIndex: number,       // focus version for the agent
  }
}
```

### Server prompt composition

The server renders `context` into the system prompt as:

- A short instruction frame ("You are helping the user workshop a single
  paragraph. Use `proposeRewrite` when you have a concrete rewrite.").
- The full main doc as markdown-ish text with the target paragraph
  marked.
- The version history: each version rendered as `V_k: "..."`, the current
  one flagged.

### Tool definition

```ts
proposeRewrite({
  content: InlineContent[]
})
```

Server-side `execute` calls `normalizeInlineContent` to validate the
array, then returns `{ ok: true, content: <normalized> }` or
`{ ok: false, reason: <message> }`. The client watches tool results and
appends the normalized content as a new version on success.

### Save path

Reuses the existing `PATCH /api/documents/:documentId/blocks/:blockId`
endpoint, which feeds `replaceBlock` in the document service. No new
server code.

## Out of scope for v1

Listed here so the scope stays honest:

- Stretch goal: vertically stacked versions visualization. Arrow nav is
  enough for v1.
- Multiple concurrent workshops. Modal design precludes this anyway.
- Sub-paragraph or multi-paragraph selection. Single paragraph block only.
- Non-paragraph block types as targets (headings, quotes, list items).
  Side-menu item is paragraph-gated.
- Persisted workshop sessions, resume, cross-reload state.
- Agent memory of prior workshops.
- Conflict UI if the main doc changes under a workshop. (Can't happen
  given the modal design; if it ever does, workshop crashes.)

## Implementation sequencing

1. **This plan doc.**
2. **Backend route + tool.** `/api/workshop/chat`, `proposeRewrite` tool
   with server-side validation.
3. **Side-menu "Workshop" item.** Injected into BlockNote, paragraph-only.
4. **Workshop mode shell.** Workspace swap, banner, cancel/save stubs,
   state for target block + versions + current index.
5. **Workshop editor ↔ version stack.** Seed editor, two-way bind to
   `versions[currentVersionIndex]`, version nav arrows.
6. **Workshop assistant panel.** Reuse AssistantPanel, point at new
   route, handle `proposeRewrite` tool results to append versions.
7. **Save path.** Block-count check, consolidation prompt, existing
   PATCH endpoint.
8. **Diff views.** `jsdiff`, view-mode toggle.
9. **End-to-end validation** with `npx agent-browser`.

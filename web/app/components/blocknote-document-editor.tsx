// BlockNote editor wrapper.
//
// Isolates the editor package behind a minimal prop surface so the parent
// workspace doesn't need to know about `useCreateBlockNote` or BlockNote's
// internal block types. Loaded via `next/dynamic` with `ssr: false` by the
// workspace because BlockNote touches `window` on import.
//
// Scope constraints intentional for this prototype:
//   - Selection formatting toolbar is disabled. Keyboard shortcuts still
//     apply bold/italic, and the workshop agent is the user's primary
//     rewriting affordance.
//   - The left-side "add block" plus icon is hidden. The editor's own
//     Enter-splits and slash menu cover the cases where a new block is
//     actually needed.
//   - The drag-handle menu is replaced by a single hammer button that
//     jumps directly into workshop mode on click. No delete / colors /
//     reorder affordances — those were never used and widened the
//     surface.
// All three are wired through BlockNote's official props (`formattingToolbar`,
// `sideMenu`) and `SideMenuController` slot, so the editor library itself
// is untouched — if we ever want these affordances back, we just flip the
// props or re-add the default components as SideMenu children.

"use client";

import {
  SideMenu,
  SideMenuController,
  useComponentsContext,
  useCreateBlockNote,
  useExtensionState,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey } from "prosemirror-state";
import { useMemo } from "react";
import { FaHammer } from "react-icons/fa";
import type { BlockNoteBlock } from "@/src/shared/documents";

type BlockNoteDocumentEditorProps = {
  initialBlocks: BlockNoteBlock[];
  onChange: (blocks: BlockNoteBlock[]) => void;
  // When true, the editor is frozen in read-only mode. Used by the workspace
  // to lock the editor while the assistant is writing so human and agent
  // edits can't interleave.
  readOnly?: boolean;
  // Fired from the hammer button next to a paragraph. Only supplied by
  // the main-document editor; the workshop-mode editor doesn't want a
  // nested "workshop this paragraph" affordance inside an existing
  // workshop.
  onWorkshopBlock?: (block: BlockNoteBlock) => void;
  // When set, only the block with this id is editable — every other block
  // in the editor is locked read-only. Used by workshop mode to keep the
  // surrounding document visible as context while the user refines a
  // single paragraph. Locking is enforced at the ProseMirror transaction
  // layer (see `buildLockedBlockExtension`) so typing in a locked block
  // simply produces no state change — no flicker, no revert.
  lockedToBlockId?: string;
};

export function BlockNoteDocumentEditor({
  initialBlocks,
  onChange,
  readOnly = false,
  onWorkshopBlock,
  lockedToBlockId,
}: BlockNoteDocumentEditorProps) {
  // BlockNote refuses to initialize with an empty block list — feed it a
  // single empty paragraph so a brand-new document still gives the user
  // somewhere to type immediately.
  const emptyDocument = useMemo<BlockNoteBlock[]>(
    () => [
      {
        id: crypto.randomUUID(),
        type: "paragraph",
        props: {},
        content: [],
        children: [],
      },
    ],
    [],
  );
  // Lazily build a per-mount lock extension. The extension is tied to a
  // specific block id at creation time, which is exactly the workshop
  // lifetime (one target per mount) — remounting on target change is
  // already what `editorKey` triggers in the parent.
  const lockExtensions = useMemo(
    () =>
      lockedToBlockId
        ? [buildLockedBlockExtension(lockedToBlockId)]
        : undefined,
    [lockedToBlockId],
  );
  // `as never` casts bridge our narrowed `BlockNoteBlock` type to the
  // editor's looser internal type without pulling the editor's full type
  // graph into the server-side domain.
  const editor = useCreateBlockNote({
    initialContent:
      initialBlocks.length > 0
        ? (initialBlocks as never)
        : (emptyDocument as never),
    extensions: lockExtensions,
  });

  return (
    <div
      className="mx-auto min-h-full max-w-3xl px-10 py-12"
      data-testid="editor"
      data-locked-block-id={lockedToBlockId}
    >
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme="light"
        onChange={() => onChange(editor.document as BlockNoteBlock[])}
        // Selection toolbar is noisy for prose editing; the agent covers
        // the cases it was useful for.
        formattingToolbar={false}
        // Disable the default side menu so we can inject the custom
        // hammer-only variant below.
        sideMenu={false}
      >
        {onWorkshopBlock ? (
          <SideMenuController
            sideMenu={() => (
              <SideMenu>
                <WorkshopSideMenuButton
                  onWorkshopBlock={onWorkshopBlock}
                  lockedToBlockId={lockedToBlockId}
                />
              </SideMenu>
            )}
          />
        ) : null}
      </BlockNoteView>
    </div>
  );
}

/**
 * Extension that pins editability to a single block id.
 *
 * Works by installing a ProseMirror `filterTransaction` that rejects any
 * doc-changing transaction whose steps touch positions outside the target
 * block's position range in the current doc. Selection moves, focus, and
 * other non-doc transactions pass through untouched so the caret can still
 * roam and the user can still select / copy from locked blocks.
 *
 * The target id is captured in this closure on mount. Workshop mode
 * remounts the editor whenever the target changes (via `editorKey`), so
 * a stale closure is not a concern here.
 *
 * Note: this does not prevent the caret from physically moving into a
 * locked block via arrow keys — we intentionally skip selection clamping
 * for v1. The caret may blink in a neighbor but no typing will take
 * effect there.
 */
function buildLockedBlockExtension(targetBlockId: string) {
  return createExtension({
    key: "workshop-lock",
    prosemirrorPlugins: [
      new Plugin({
        key: new PluginKey("workshopLock"),
        filterTransaction(tr, state) {
          if (!tr.docChanged) {
            return true;
          }

          // Locate the target block's range in the pre-transaction doc.
          // BlockNote's `blockContainer` node carries the `id` attr
          // (see UniqueID registration in BlockNote core); we compare
          // against that to decide what's in-bounds.
          let targetFrom = -1;
          let targetTo = -1;
          state.doc.descendants((node, pos) => {
            if (targetFrom !== -1) {
              return false;
            }
            if (node.attrs && node.attrs.id === targetBlockId) {
              targetFrom = pos;
              targetTo = pos + node.nodeSize;
              return false;
            }
            return true;
          });

          // Target missing from the doc (shouldn't happen — workshop
          // entry validates the block exists) — fail closed.
          if (targetFrom === -1) {
            return false;
          }

          for (const step of tr.steps) {
            let outside = false;
            step.getMap().forEach((oldStart, oldEnd) => {
              if (oldStart < targetFrom || oldEnd > targetTo) {
                outside = true;
              }
            });
            if (outside) {
              return false;
            }
          }
          return true;
        },
      }),
    ],
  });
}

/**
 * Single-click side-menu button that jumps straight into workshop mode.
 *
 * Replaces the stock add-block + drag-handle + drop-down combo with one
 * affordance, intentionally paragraph-only: non-paragraph blocks render
 * no side-menu at all, since workshop is the only affordance we surface
 * here today. If we later add actions for other block types, bring back
 * `<AddBlockButton />` / `<DragHandleButton>` with a custom menu.
 */
function WorkshopSideMenuButton({
  onWorkshopBlock,
  lockedToBlockId,
}: {
  onWorkshopBlock: (block: BlockNoteBlock) => void;
  lockedToBlockId?: string;
}) {
  const Components = useComponentsContext()!;
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  });

  if (block === undefined) {
    return null;
  }

  if (block.type !== "paragraph") {
    return null;
  }

  // When the editor is locked to a specific block, suppress the hammer
  // side menu for every other block — there is no sensible "workshop
  // this" action for a block the user can't even edit in the current
  // session.
  if (lockedToBlockId && block.id !== lockedToBlockId) {
    return null;
  }

  return (
    <Components.SideMenu.Button
      className="bn-button"
      icon={<FaHammer size={16} aria-hidden="true" />}
      label="Workshop this paragraph"
      onClick={() => onWorkshopBlock(block as unknown as BlockNoteBlock)}
    />
  );
}

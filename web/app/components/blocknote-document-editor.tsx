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
};

export function BlockNoteDocumentEditor({
  initialBlocks,
  onChange,
  readOnly = false,
  onWorkshopBlock,
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
  // `as never` casts bridge our narrowed `BlockNoteBlock` type to the
  // editor's looser internal type without pulling the editor's full type
  // graph into the server-side domain.
  const editor = useCreateBlockNote({
    initialContent:
      initialBlocks.length > 0
        ? (initialBlocks as never)
        : (emptyDocument as never),
  });

  return (
    <div
      className="mx-auto min-h-full max-w-3xl px-10 py-12"
      data-testid="editor"
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
                <WorkshopSideMenuButton onWorkshopBlock={onWorkshopBlock} />
              </SideMenu>
            )}
          />
        ) : null}
      </BlockNoteView>
    </div>
  );
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
}: {
  onWorkshopBlock: (block: BlockNoteBlock) => void;
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

  return (
    <Components.SideMenu.Button
      className="bn-button"
      icon={<FaHammer size={16} aria-hidden="true" />}
      label="Workshop this paragraph"
      onClick={() => onWorkshopBlock(block as unknown as BlockNoteBlock)}
    />
  );
}

// BlockNote editor wrapper.
//
// Isolates the editor package behind a minimal prop surface so the parent
// workspace doesn't need to know about `useCreateBlockNote` or BlockNote's
// internal block types. Loaded via `next/dynamic` with `ssr: false` by the
// workspace because BlockNote touches `window` on import.

"use client";

import {
  AddBlockButton,
  DragHandleButton,
  SideMenu,
  SideMenuController,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { useExtensionState } from "@blocknote/react";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { RemoveBlockItem } from "@blocknote/react";
import { BlockColorsItem } from "@blocknote/react";
import { useMemo } from "react";
import type { BlockNoteBlock } from "@/src/shared/documents";

type BlockNoteDocumentEditorProps = {
  initialBlocks: BlockNoteBlock[];
  onChange: (blocks: BlockNoteBlock[]) => void;
  // When true, the editor is frozen in read-only mode. Used by the workspace
  // to lock the editor while the assistant is writing so human and agent
  // edits can't interleave.
  readOnly?: boolean;
  // Fired from the drag-handle menu's "Workshop" item. Only supplied by the
  // main-document editor; the workshop-mode editor doesn't want a nested
  // "workshop this paragraph" affordance inside an existing workshop.
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
        // Disable the default side menu so we can inject a Workshop item at
        // the top of the drag-handle dropdown. We reproduce the default
        // layout (add-block button + drag-handle button) and just extend
        // the menu's children.
        sideMenu={false}
      >
        {onWorkshopBlock ? (
          <SideMenuController
            sideMenu={() => (
              <SideMenu>
                <AddBlockButton />
                <DragHandleButton>
                  <WorkshopMenuItem onWorkshopBlock={onWorkshopBlock} />
                  <RemoveBlockItem>Delete</RemoveBlockItem>
                  <BlockColorsItem>Colors</BlockColorsItem>
                </DragHandleButton>
              </SideMenu>
            )}
          />
        ) : null}
      </BlockNoteView>
    </div>
  );
}

/**
 * "Workshop" drag-handle menu item.
 *
 * Visible only when the hovered block is a paragraph — workshopping only
 * makes sense against a single prose paragraph today (see
 * `docs/workshop-feature.md`). Uses the same hooks as the built-in
 * `RemoveBlockItem` so it renders via BlockNote's theme primitives rather
 * than a one-off button.
 */
function WorkshopMenuItem({
  onWorkshopBlock,
}: {
  onWorkshopBlock: (block: BlockNoteBlock) => void;
}) {
  const Components = useComponentsContext()!;
  // Keep a handle to the editor so we can freeze the side menu while the
  // click closes the dropdown (not strictly required, but matches the
  // behavior of the default items).
  useBlockNoteEditor();

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
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => onWorkshopBlock(block as unknown as BlockNoteBlock)}
      data-testid="side-menu-workshop"
    >
      Workshop
    </Components.Generic.Menu.Item>
  );
}

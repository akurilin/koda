// BlockNote editor wrapper.
//
// Isolates the editor package behind a minimal prop surface so the parent
// workspace doesn't need to know about `useCreateBlockNote` or BlockNote's
// internal block types. Loaded via `next/dynamic` with `ssr: false` by the
// workspace because BlockNote touches `window` on import.

"use client";

import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { useMemo } from "react";
import type { BlockNoteBlock } from "@/src/shared/documents";

type BlockNoteDocumentEditorProps = {
  initialBlocks: BlockNoteBlock[];
  onChange: (blocks: BlockNoteBlock[]) => void;
};

export function BlockNoteDocumentEditor({
  initialBlocks,
  onChange,
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
        theme="light"
        onChange={() => onChange(editor.document as BlockNoteBlock[])}
      />
    </div>
  );
}

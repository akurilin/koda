"use client";

import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { useMemo } from "react";
import { BlockNoteBlock } from "@/src/server/documents/types";

type BlockNoteDocumentEditorProps = {
  initialBlocks: BlockNoteBlock[];
  onChange: (blocks: BlockNoteBlock[]) => void;
};

export function BlockNoteDocumentEditor({
  initialBlocks,
  onChange,
}: BlockNoteDocumentEditorProps) {
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

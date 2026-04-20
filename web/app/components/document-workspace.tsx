"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantPanel } from "./assistant-panel";
import {
  BlockNoteBlock,
  DocumentBlockRecord,
  DocumentWithBlocks,
} from "@/src/server/documents/types";

const BlockNoteDocumentEditor = dynamic(
  () =>
    import("./blocknote-document-editor").then(
      (module) => module.BlockNoteDocumentEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Loading editor...
      </div>
    ),
  },
);

type DocumentWorkspaceProps = {
  initialDocument: DocumentWithBlocks;
};

export function DocumentWorkspace({ initialDocument }: DocumentWorkspaceProps) {
  const [document, setDocument] = useState(initialDocument);
  const [editorVersion, setEditorVersion] = useState(0);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "conflict">(
    "saved",
  );
  const documentRef = useRef(initialDocument);
  const lastEditorSnapshot = useRef(
    JSON.stringify(initialDocument.blocks.map((block) => block.blockJson)),
  );
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  const editorBlocks = useMemo(
    () => document.blocks.map((block) => block.blockJson),
    [document.blocks],
  );

  const revisionMap = useMemo(
    () =>
      Object.fromEntries(
        document.blocks.map((block) => [block.id, block.revision]),
      ) as Record<string, number>,
    [document.blocks],
  );

  const refreshDocument = useCallback(async () => {
    const response = await fetch(`/api/documents/${documentRef.current.id}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return;
    }

    const nextDocument = (await response.json()) as DocumentWithBlocks;
    const nextSnapshot = JSON.stringify(
      nextDocument.blocks.map((block) => block.blockJson),
    );

    if (nextSnapshot !== lastEditorSnapshot.current) {
      lastEditorSnapshot.current = nextSnapshot;
      setEditorVersion((version) => version + 1);
    }

    setDocument(nextDocument);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (saveState !== "saving") {
        void refreshDocument();
      }
    }, 2_500);

    return () => window.clearInterval(interval);
  }, [refreshDocument, saveState]);

  const syncBlocks = useCallback(
    async (blocks: BlockNoteBlock[]) => {
      setSaveState("saving");

      const response = await fetch(
        `/api/documents/${documentRef.current.id}/blocks/sync`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            blocks,
            expectedRevisions: revisionMap,
          }),
        },
      );

      if (response.status === 409) {
        setSaveState("conflict");
        await refreshDocument();
        return;
      }

      if (!response.ok) {
        setSaveState("conflict");
        return;
      }

      const body = (await response.json()) as {
        blocks: DocumentBlockRecord[];
      };

      lastEditorSnapshot.current = JSON.stringify(
        body.blocks.map((block) => block.blockJson),
      );
      setDocument((currentDocument) => ({
        ...currentDocument,
        blocks: body.blocks,
      }));
      setSaveState("saved");
    },
    [refreshDocument, revisionMap],
  );

  const handleEditorChange = useCallback(
    (blocks: BlockNoteBlock[]) => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }

      saveTimer.current = window.setTimeout(() => {
        void syncBlocks(blocks);
      }, 600);
    },
    [syncBlocks],
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
    };
  }, []);

  return (
    <main className="flex h-screen min-h-0 bg-[#f6f5f2] text-zinc-950">
      <section className="flex min-w-0 flex-1 flex-col border-r border-zinc-200 bg-white">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-6">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-zinc-500">
              Draft
            </p>
            <h1 className="truncate text-base font-semibold">
              {document.title || "Untitled article"}
            </h1>
          </div>
          <div
            className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500"
            data-testid="save-state"
          >
            {saveState === "saving"
              ? "Saving"
              : saveState === "conflict"
                ? "Conflict"
                : "Saved"}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto" data-testid="editor-pane">
          <BlockNoteDocumentEditor
            key={editorVersion}
            initialBlocks={editorBlocks}
            onChange={handleEditorChange}
          />
        </div>
      </section>
      <aside className="flex w-[420px] shrink-0 flex-col bg-zinc-950 text-white">
        <AssistantPanel
          documentId={document.id}
          onRefreshDocument={refreshDocument}
        />
      </aside>
    </main>
  );
}

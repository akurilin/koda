// Top-level workspace shell: editor on the left, assistant panel on the right.
//
// This component owns the document state shared between the two panes and the
// autosave loop that keeps the server in sync. Responsibilities:
//
//   - Hold the authoritative `document` state on the client.
//   - Debounce edits from the editor and PUT the full block list to the
//     sync endpoint. The server is the source of truth for revisions and
//     returns the canonical blocks we then re-seat into local state.
//   - Poll for server-side changes so agent edits made while the user is
//     idle show up without manual refresh.
//   - Expose a "Demo text" escape hatch that fully replaces the document
//     with a preset article, confirmed via a modal because it destroys the
//     user's current content.
//
// The `editorVersion` counter is used as the BlockNote key so we can force
// the editor to remount when the server-side state diverges from what the
// user has in the buffer (e.g. agent rewrote a block, demo article applied).

"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantPanel } from "./assistant-panel";
import { buildDemoArticleBlocks } from "./demo-article";
import type {
  BlockNoteBlock,
  DocumentBlockRecord,
  DocumentWithBlocks,
} from "@/src/shared/documents";

// BlockNote is client-only (it pokes at `window` on import). `ssr: false`
// plus a loading placeholder keeps the server render lightweight and avoids
// hydration mismatches.
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
  const [demoDialogOpen, setDemoDialogOpen] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  // `documentRef` lets callbacks read the latest document id without
  // invalidating on every state change — the id is stable, but we still
  // need a handle that closures can reach without re-binding.
  const documentRef = useRef(initialDocument);
  // Snapshot of the last block JSON we saw from the server. Used to decide
  // whether background polling actually diverged from the editor buffer; if
  // it didn't, we avoid forcing a remount and losing the user's caret.
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

  // Flattened map of revisions so the sync endpoint can do per-block
  // optimistic-concurrency checks.
  const revisionMap = useMemo(
    () =>
      Object.fromEntries(
        document.blocks.map((block) => [block.id, block.revision]),
      ) as Record<string, number>,
    [document.blocks],
  );

  // Pull the freshest server copy. Called by the background poll and after
  // a conflict so the user sees the truth instead of their stale buffer.
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

    // Only remount the editor if something actually changed — otherwise a
    // harmless poll would clobber the user's current selection.
    if (nextSnapshot !== lastEditorSnapshot.current) {
      lastEditorSnapshot.current = nextSnapshot;
      setEditorVersion((version) => version + 1);
    }

    setDocument(nextDocument);
  }, []);

  // Background poll. Intentionally pauses while a save is in flight so we
  // don't overwrite our own optimistic state with a pre-save read.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (saveState !== "saving") {
        void refreshDocument();
      }
    }, 2_500);

    return () => window.clearInterval(interval);
  }, [refreshDocument, saveState]);

  // Commit the current editor buffer to the server. A 409 means another
  // actor (another tab, the agent) moved ahead of us; we pull their version
  // rather than try to merge client-side.
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

  // Editor edits come in bursts as the user types; debounce keeps us from
  // hammering the sync endpoint and lets us batch rapid changes into one
  // PUT. 600ms is short enough to feel live, long enough to batch a flurry.
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

  // One-shot "replace everything with the preset article" action. Used in
  // demos and as a quick way to reset the doc. Goes through the normal sync
  // endpoint so the server still enforces the schema and emits real row
  // ids/revisions.
  const applyDemoArticle = useCallback(async () => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    setDemoBusy(true);
    setSaveState("saving");

    const demoBlocks = buildDemoArticleBlocks();

    const response = await fetch(
      `/api/documents/${documentRef.current.id}/blocks/sync`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blocks: demoBlocks,
          expectedRevisions: revisionMap,
        }),
      },
    );

    if (!response.ok) {
      setSaveState("conflict");
      setDemoBusy(false);
      await refreshDocument();
      return;
    }

    const body = (await response.json()) as { blocks: DocumentBlockRecord[] };
    const nextSnapshot = JSON.stringify(
      body.blocks.map((block) => block.blockJson),
    );

    lastEditorSnapshot.current = nextSnapshot;
    setDocument((currentDocument) => ({
      ...currentDocument,
      blocks: body.blocks,
    }));
    // Force a remount so BlockNote picks up the entirely new block list
    // instead of diffing from its previous internal state.
    setEditorVersion((version) => version + 1);
    setSaveState("saved");
    setDemoBusy(false);
    setDemoDialogOpen(false);
  }, [refreshDocument, revisionMap]);

  // Drop any pending debounce on unmount so we don't fire a save into a
  // component that no longer exists.
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
          <button
            type="button"
            onClick={() => setDemoDialogOpen(true)}
            disabled={demoBusy}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="demo-text-button"
          >
            Demo text
          </button>
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
      {demoDialogOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="demo-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 px-4"
        >
          <div className="w-full max-w-md rounded-lg bg-white p-6 text-zinc-950 shadow-xl">
            <h2
              id="demo-dialog-title"
              className="text-base font-semibold"
              data-testid="demo-dialog-title"
            >
              Replace document with demo text?
            </h2>
            <p className="mt-2 text-sm text-zinc-600">
              This deletes every block in the current document and replaces it
              with a preset article. Your existing content will be lost.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDemoDialogOpen(false)}
                disabled={demoBusy}
                className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="demo-dialog-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void applyDemoArticle()}
                disabled={demoBusy}
                className="rounded bg-zinc-950 px-3 py-1.5 text-sm text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="demo-dialog-confirm"
              >
                {demoBusy ? "Replacing..." : "Replace"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

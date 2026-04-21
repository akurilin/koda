// Top-level workspace shell: editor on the left, assistant panel on the right.
//
// This component owns the document state shared between the two panes, the
// autosave loop that keeps the server in sync, and the assistant-ui runtime
// both panes read from. Responsibilities:
//
//   - Hold the authoritative `document` state on the client.
//   - Debounce edits from the editor and PUT the full block list to the
//     sync endpoint. The server is the source of truth for revisions and
//     returns the canonical blocks we then re-seat into local state.
//   - Poll for server-side changes so agent edits made while the user is
//     idle show up without manual refresh.
//   - Lock the editor while the agent is running. Having the runtime here
//     (instead of deeper in the assistant panel) is what makes the lock
//     possible — the editor side needs to read `thread.isRunning` to set
//     `readOnly`, flush any pending autosave before the agent starts, and
//     refresh the document once the agent finishes so the user sees the
//     final state before they can type again.
//   - Expose a "Demo text" escape hatch that fully replaces the document
//     with a preset article, confirmed via a modal because it destroys the
//     user's current content.
//
// The `editorVersion` counter is used as the BlockNote key so we can force
// the editor to remount when the server-side state diverges from what the
// user has in the buffer (e.g. agent rewrote a block, demo article applied).

"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { AssistantPanel } from "./assistant-panel";
import { buildDemoArticleBlocks } from "./demo-article";
import { WorkshopWorkspace } from "./workshop-workspace";
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
  // Present on the workshop route (`/documents/:id/workshop/:blockId`).
  // When set, this component renders `WorkshopWorkspace` instead of the
  // main editor — the URL is the source of truth for "is a workshop
  // open?", so back-button / reload / sharing all line up.
  workshopBlockId?: string;
};

/**
 * Outer shell that owns the assistant-ui runtime so both the editor side
 * (which needs `thread.isRunning` to drive the lock) and the assistant panel
 * (which needs the runtime for its chat UI) share one source of truth.
 *
 * Everything interactive lives in `DocumentWorkspaceInner` — it has to sit
 * under `AssistantRuntimeProvider` for `useAuiState` to resolve.
 */
export function DocumentWorkspace({
  initialDocument,
  workshopBlockId,
}: DocumentWorkspaceProps) {
  // `useMemo` keeps the transport instance stable across renders so the
  // runtime doesn't rebuild its internal state every time the parent
  // re-renders.
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: `/api/chat?documentId=${encodeURIComponent(initialDocument.id)}`,
      }),
    [initialDocument.id],
  );
  const runtime = useChatRuntime({ transport });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DocumentWorkspaceInner
        initialDocument={initialDocument}
        workshopBlockId={workshopBlockId}
      />
    </AssistantRuntimeProvider>
  );
}

function DocumentWorkspaceInner({
  initialDocument,
  workshopBlockId,
}: DocumentWorkspaceProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `?focus=<blockId>` is set when navigating back from a workshop (save
  // or cancel). We use it to scroll the editor to the workshopped block
  // so the user doesn't lose context — see the focus effect below.
  const focusBlockId = searchParams.get("focus");
  // `thread.isRunning` flips true the instant the user submits a chat and
  // stays true until the last stream token / tool call settles. We use it as
  // the single source of truth for "the agent is writing; humans stand down".
  // `?? false` covers the fleeting moment before the store is populated.
  const isAgentRunning =
    useAuiState((state) => state.thread.isRunning) ?? false;

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
  // Latest block buffer emitted by the editor, held in a ref so the
  // agent-start effect can flush whatever's pending without re-binding on
  // every keystroke.
  const pendingBlocks = useRef<BlockNoteBlock[] | null>(null);
  // Previous value of `isAgentRunning`, used to detect transitions in an
  // effect. React doesn't give us "previous props" natively.
  const wasAgentRunning = useRef(false);

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
      pendingBlocks.current = blocks;

      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }

      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        pendingBlocks.current = null;
        void syncBlocks(blocks);
      }, 600);
    },
    [syncBlocks],
  );

  // Editor-lock transitions around agent runs.
  //
  // Entering: the agent is about to read + edit the document server-side,
  // so if the user has unsaved keystrokes buffered in the debounce we flush
  // them immediately — otherwise the agent would reason about a stale
  // snapshot. The sync fetch races the agent's streaming request, but the
  // sync is a single short round-trip and the first tool call is hundreds
  // of ms into the stream, so in practice sync lands first.
  //
  // Leaving: pull the authoritative document so the editor rehydrates with
  // the agent's final state before we re-enable typing.
  useEffect(() => {
    const justStarted = !wasAgentRunning.current && isAgentRunning;
    const justFinished = wasAgentRunning.current && !isAgentRunning;
    wasAgentRunning.current = isAgentRunning;

    if (justStarted) {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (pendingBlocks.current) {
        const buffered = pendingBlocks.current;
        pendingBlocks.current = null;
        void syncBlocks(buffered);
      }
    }

    if (justFinished) {
      void refreshDocument();
    }
  }, [isAgentRunning, refreshDocument, syncBlocks]);

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

  // Side-menu entry point into workshop mode. Navigation goes through the
  // router so the workshop identity lives in the URL (see plan doc and
  // `workshop/[blockId]/page.tsx`). Internal state is not used — back /
  // reload / sharing all resolve from the URL alone.
  const enterWorkshop = useCallback(
    (block: BlockNoteBlock) => {
      // Commit any pending autosave so the block we're about to workshop
      // matches the server's view (and so we don't race a save into the
      // unmount that the workshop transition causes).
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      router.push(`/documents/${document.id}/workshop/${block.id}`);
    },
    [document.id, router],
  );

  const workshopTarget = useMemo(
    () =>
      workshopBlockId
        ? (document.blocks.find((block) => block.id === workshopBlockId) ??
          null)
        : null,
    [workshopBlockId, document.blocks],
  );

  // Both save and cancel return to the main doc URL and hand it a
  // `?focus=<blockId>` query param. The destination effect (below) picks
  // that up and scrolls the editor to the block so the user lands right
  // where they were, not at the top of the document.
  const returnToMainDoc = useCallback(
    (blockId: string) => {
      router.push(
        `/documents/${document.id}?focus=${encodeURIComponent(blockId)}`,
      );
    },
    [document.id, router],
  );

  // When the workshop saves, merge the updated block back into the main
  // doc state so the user returns to an already-fresh view without a poll.
  const handleWorkshopSaved = useCallback(
    (updatedBlock: DocumentBlockRecord) => {
      setDocument((current) => ({
        ...current,
        blocks: current.blocks.map((block) =>
          block.id === updatedBlock.id ? updatedBlock : block,
        ),
      }));
      // Make sure the next background poll sees the updated content as
      // "current" and doesn't trigger a spurious editor remount.
      lastEditorSnapshot.current = JSON.stringify(
        documentRef.current.blocks.map((block) =>
          block.id === updatedBlock.id
            ? updatedBlock.blockJson
            : block.blockJson,
        ),
      );
      // Bump editor version so BlockNote re-reads the updated block on
      // return to the main doc.
      setEditorVersion((version) => version + 1);
      returnToMainDoc(updatedBlock.id);
    },
    [returnToMainDoc],
  );

  // Scroll the focused block into view when the main doc re-mounts. We
  // poll briefly because the dynamic BlockNote editor mounts after the
  // Next.js shell renders — the element we're looking for may not exist
  // on the first tick. The retry loop bails quickly if the block never
  // shows up (stale `focus` param from a deleted block, for instance).
  useEffect(() => {
    if (workshopTarget || !focusBlockId) {
      return;
    }
    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      const element = window.document.querySelector(
        `[data-id="${cssEscape(focusBlockId)}"]`,
      );
      if (element) {
        window.clearInterval(interval);
        element.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (attempts > 20) {
        window.clearInterval(interval);
      }
    }, 100);
    return () => {
      window.clearInterval(interval);
    };
  }, [focusBlockId, workshopTarget, editorVersion]);

  if (workshopTarget) {
    return (
      <WorkshopWorkspace
        documentId={document.id}
        documentBlocks={document.blocks.map((block) => block.blockJson)}
        targetBlock={workshopTarget.blockJson}
        targetBlockRevision={workshopTarget.revision}
        onCancel={() => returnToMainDoc(workshopTarget.id)}
        onSaved={handleWorkshopSaved}
      />
    );
  }

  return (
    <main className="flex h-screen min-h-0 bg-[#f6f5f2] text-zinc-950">
      <section className="flex min-w-0 flex-1 flex-col border-r border-zinc-200 bg-white">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-6">
          <button
            type="button"
            onClick={() => setDemoDialogOpen(true)}
            disabled={demoBusy || isAgentRunning}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="demo-text-button"
          >
            Demo text
          </button>
          <div
            className={`rounded border px-2 py-1 text-xs ${
              isAgentRunning
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-zinc-200 text-zinc-500"
            }`}
            data-testid="save-state"
          >
            {isAgentRunning
              ? "Agent editing"
              : saveState === "saving"
                ? "Saving"
                : saveState === "conflict"
                  ? "Conflict"
                  : "Saved"}
          </div>
        </header>
        <div
          className={`min-h-0 flex-1 overflow-auto transition-opacity ${
            isAgentRunning ? "opacity-75" : ""
          }`}
          data-testid="editor-pane"
          data-editor-locked={isAgentRunning ? "true" : "false"}
        >
          <BlockNoteDocumentEditor
            key={editorVersion}
            initialBlocks={editorBlocks}
            onChange={handleEditorChange}
            readOnly={isAgentRunning}
            onWorkshopBlock={enterWorkshop}
          />
        </div>
      </section>
      <aside className="flex w-[420px] shrink-0 flex-col bg-zinc-950 text-white">
        <AssistantPanel onRefreshDocument={refreshDocument} />
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

// Defensive selector-escape for a block id when building the DOM query.
// Block ids are UUIDs today so escaping is mostly a no-op, but the
// fallback keeps us safe if the id format ever widens (e.g. agent-minted
// ids that include colons or dots, which would otherwise blow up an
// attribute-selector parser).
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

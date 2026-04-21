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
//   - Expose a "Replace with demo text" escape hatch that fully overwrites
//     the document with a preset article, confirmed via a modal because it
//     destroys the user's current content.
//
// The `editorVersion` counter is used as the BlockNote key so we can force
// the editor to remount when the server-side state diverges from what the
// user has in the buffer (e.g. agent rewrote a block, demo article applied).

"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FaHouse } from "react-icons/fa6";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  // or cancel). We use it to position the editor on the workshopped block
  // so the user doesn't lose context — see the focus effect below.
  const focusBlockId = searchParams.get("focus");
  // `?scrollY=<number>` is captured at workshop entry and carried on
  // every URL in the workshop round-trip so we can restore the exact
  // scroll position the user left, instead of snapping the block to the
  // top of the viewport. Preserving a precise number in the URL keeps
  // back-button navigation and reload on the workshop route producing
  // the same landing view.
  const scrollYParam = searchParams.get("scrollY");
  // `thread.isRunning` flips true the instant the user submits a chat and
  // stays true until the last stream token / tool call settles. We use it as
  // the single source of truth for "the agent is writing; humans stand down".
  // `?? false` covers the fleeting moment before the store is populated.
  const isAgentRunning =
    useAuiState((state) => state.thread.isRunning) ?? false;

  // Ref on the editor's scroll container. We need direct DOM access
  // because the scroll position we round-trip through the URL is this
  // element's `scrollTop`, not `window.scrollY` (the page itself never
  // scrolls — only the inner pane does).
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // When a scrollY is carried in the URL we keep the editor pane hidden
  // until we've mounted the target block and set `scrollTop`. Without
  // this, the user sees a one-frame flash of the editor at the top of
  // the document before the restoration fires — very noticeable when
  // returning from a workshop near the bottom of a long article. The
  // initial value is derived synchronously so the first paint already
  // has the pane hidden; we flip it back to visible at the same time
  // as the scrollTop assignment. The workshop entry/exit transitions
  // both cross a Next.js page boundary (`/documents/[id]` vs
  // `/documents/[id]/workshop/[blockId]`), so `DocumentWorkspace`
  // unmounts and remounts — the `useState` initializer alone covers
  // every case; no in-place rearm is needed.
  const [awaitingScrollRestore, setAwaitingScrollRestore] = useState(
    () => focusBlockId !== null && scrollYParam !== null,
  );

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

  // Map of block id → feedback text for blocks with an active reviewer
  // note. Threaded into the editor so the side-menu can (a) render the
  // hover popover showing the feedback text on the question-mark button
  // and (b) render the "Clear feedback" (X) button alongside. Empty
  // strings count as "no feedback" — matches the service-layer
  // normalization so the UI and DB stay in lock-step.
  const blockFeedback = useMemo(() => {
    const map = new Map<string, string>();
    for (const block of document.blocks) {
      if (block.feedback && block.feedback.length > 0) {
        map.set(block.id, block.feedback);
      }
    }
    return map;
  }, [document.blocks]);

  // X-button handler. The feedback endpoint returns the updated block
  // so we can merge it into state without a full refetch — keeps the
  // orange bar from flickering through a stale frame before the next
  // background poll lands.
  const clearBlockFeedback = useCallback(async (blockId: string) => {
    const response = await fetch(
      `/api/documents/${documentRef.current.id}/blocks/${blockId}/feedback`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      return;
    }
    const updatedBlock = (await response.json()) as DocumentBlockRecord;
    setDocument((currentDocument) => ({
      ...currentDocument,
      blocks: currentDocument.blocks.map((block) =>
        block.id === updatedBlock.id ? updatedBlock : block,
      ),
    }));
  }, []);

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
      // Capture the editor pane's scroll position so we can restore it
      // verbatim when the user returns from the workshop. Embedding this
      // in the URL (rather than stashing it in memory) means reload and
      // back-button navigation from the workshop both land the user on
      // exactly the scroll offset they left.
      //
      // We always emit `scrollY`, even when it's 0. Previously we
      // skipped it for a "cleaner URL" at the top of the doc, but that
      // dropped the return path into the `scrollIntoView` fallback,
      // which aligns the focused block to the top of the viewport and
      // pushes the article's hero above it — a visibly wrong result
      // when the user was already at `scrollTop=0`.
      const scrollTop = Math.round(scrollContainerRef.current?.scrollTop ?? 0);
      const scrollQuery = `&scrollY=${scrollTop}`;
      // Rewrite the current history entry to point at the block we're
      // about to workshop before pushing the workshop URL. That way the
      // browser back button from inside the workshop lands on a main-doc
      // URL whose `?focus=` is the block the user just clicked — not
      // whatever focus was encoded by a previous workshop session. Using
      // `window.history.replaceState` directly instead of
      // `router.replace` avoids an unnecessary render cycle, since the
      // very next action is a push away from this URL anyway.
      const backTargetUrl = `/documents/${document.id}?focus=${encodeURIComponent(block.id)}${scrollQuery}`;
      window.history.replaceState(null, "", backTargetUrl);
      // Carry `scrollY` on the workshop URL too (same reasoning as
      // above: emit 0 explicitly) so Save/Cancel, which read from
      // `searchParams`, can round-trip the number back onto the main-
      // doc URL without falling into the `scrollIntoView` fallback.
      router.push(
        `/documents/${document.id}/workshop/${block.id}?scrollY=${scrollTop}`,
      );
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
  // that up and positions the editor so the user lands right where they
  // were, not at the top of the document. We also forward the `scrollY`
  // captured at workshop entry (it rides on the workshop URL) so the
  // return restores the exact scroll offset, not just the block.
  const returnToMainDoc = useCallback(
    (blockId: string) => {
      const savedScrollY = searchParams.get("scrollY");
      const scrollQuery = savedScrollY ? `&scrollY=${savedScrollY}` : "";
      router.push(
        `/documents/${document.id}?focus=${encodeURIComponent(blockId)}${scrollQuery}`,
      );
    },
    [document.id, router, searchParams],
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

  // Restore the user's view when the main doc re-mounts after a
  // workshop round-trip. We watch the scroll container with a
  // `MutationObserver` so the restore fires on the same frame the
  // BlockNote editor inserts the target block — far faster than the
  // old 100ms polling loop, which left a visible flash at scrollTop=0.
  // Paired with `useLayoutEffect`, the scrollTop assignment and the
  // reveal (`setAwaitingScrollRestore(false)`) happen before the next
  // paint, so the user sees one frame with the editor already at the
  // saved offset rather than a snap from top.
  //
  // Behavior is intentionally non-animated: a smooth scroll after every
  // workshop save gets old fast. When a `scrollY` is carried in the
  // URL we restore it exactly; otherwise we fall back to snapping the
  // block into view (also instant) so the `?focus=` URL remains useful
  // when linked to directly without a scroll offset.
  useLayoutEffect(() => {
    if (workshopTarget || !focusBlockId) {
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const tryRestore = () => {
      const element = container.querySelector(
        `[data-id="${cssEscape(focusBlockId)}"]`,
      );
      if (!element) {
        return false;
      }
      const parsedScrollY =
        scrollYParam !== null ? Number.parseInt(scrollYParam, 10) : NaN;
      if (Number.isFinite(parsedScrollY)) {
        // Touching `scrollHeight` forces a synchronous layout so the
        // container knows its real scrollable size before we assign
        // `scrollTop`. Without this, an early assignment right after
        // DOM insertion can be clamped by a stale scrollHeight.
        void container.scrollHeight;
        container.scrollTop = parsedScrollY;
      } else {
        element.scrollIntoView({ block: "start" });
      }
      setAwaitingScrollRestore(false);
      return true;
    };

    if (tryRestore()) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (tryRestore()) {
        observer.disconnect();
      }
    });
    observer.observe(container, { childList: true, subtree: true });

    // Safety net: if the target block never appears (e.g. a stale
    // `focus` id pointing at a deleted block), reveal the pane anyway
    // so the user isn't stuck staring at a blank area. A short budget
    // keeps the worst-case hidden window tight.
    const revealTimeout = window.setTimeout(() => {
      observer.disconnect();
      setAwaitingScrollRestore(false);
    }, 1_000);

    return () => {
      observer.disconnect();
      window.clearTimeout(revealTimeout);
    };
  }, [focusBlockId, scrollYParam, workshopTarget, editorVersion]);

  if (workshopTarget) {
    return (
      <WorkshopWorkspace
        documentId={document.id}
        documentBlocks={document.blocks.map((block) => block.blockJson)}
        targetBlock={workshopTarget.blockJson}
        targetBlockRevision={workshopTarget.revision}
        targetBlockFeedback={workshopTarget.feedback}
        onCancel={() => returnToMainDoc(workshopTarget.id)}
        onSaved={handleWorkshopSaved}
      />
    );
  }

  return (
    <main className="flex h-screen min-h-0 bg-[#f6f5f2] text-zinc-950">
      <section className="flex min-w-0 flex-1 flex-col border-r border-zinc-200 bg-white">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-6">
          <div className="flex items-center gap-2">
            <Link
              href="/"
              aria-label="Go home"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 transition hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
              data-testid="home-button"
            >
              <FaHouse size={14} aria-hidden="true" />
            </Link>
            <button
              type="button"
              onClick={() => setDemoDialogOpen(true)}
              disabled={demoBusy || isAgentRunning}
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="demo-text-button"
            >
              Replace with demo text
            </button>
          </div>
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
          ref={scrollContainerRef}
          className={`relative min-h-0 flex-1 overflow-auto transition-opacity ${
            isAgentRunning ? "opacity-75" : ""
          }`}
          data-testid="editor-pane"
          data-editor-locked={isAgentRunning ? "true" : "false"}
          // Suppress the brief mount-at-top frame when restoring scroll
          // from the URL — the pane only becomes visible after the
          // layout effect has set `scrollTop`.
          style={awaitingScrollRestore ? { visibility: "hidden" } : undefined}
        >
          {/* Paint a faint amber background on every block that has
              reviewer feedback. We inject the rules as a <style> tag
              keyed on each block id so we don't need to touch
              BlockNote's DOM — the editor owns the blocks, we just
              decorate them. `blockOuter` is the stable wrapper that
              carries `data-id`; targeting it (rather than the inner
              `blockContent`) colors the full block including its side
              padding, which reads as "this whole paragraph has a
              comment on it". */}
          <FeedbackHighlightStyles blockIds={[...blockFeedback.keys()]} />
          <BlockNoteDocumentEditor
            key={editorVersion}
            initialBlocks={editorBlocks}
            onChange={handleEditorChange}
            readOnly={isAgentRunning}
            onWorkshopBlock={enterWorkshop}
            blockFeedback={blockFeedback}
            onClearBlockFeedback={clearBlockFeedback}
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

/**
 * Render a `<style>` element with one rule per feedback-annotated block
 * id, painting each block's `blockOuter` wrapper with a faint amber
 * background. Using CSS injection (instead of mutating block JSON or
 * wrapping blocks in a React overlay) keeps the integration one-way —
 * the editor owns the DOM, we only decorate it via attribute-selector
 * styling. An empty list renders nothing.
 */
function FeedbackHighlightStyles({ blockIds }: { blockIds: string[] }) {
  if (blockIds.length === 0) {
    return null;
  }
  // `.bn-block-content` is BlockNote's class on the inner content box
  // (the actual `<p>` / `<h1>` / list-item wrapper). Targeting that
  // rather than `blockOuter` keeps the highlight tight to the prose
  // instead of flooding the gutter where the side-menu lives.
  const selectors = blockIds
    .map(
      (id) =>
        `[data-node-type="blockOuter"][data-id="${cssEscape(id)}"] .bn-block-content`,
    )
    .join(",\n");
  return (
    <style>{`${selectors} { background-color: rgba(253, 224, 71, 0.22); border-radius: 4px; }`}</style>
  );
}

// Workshop mode: a modal editing session for refining a single paragraph.
//
// See `docs/workshop-feature.md` for the design rationale. In short:
//
//   - Replaces the main workspace while the user is focused on one block.
//   - Left pane: a BlockNote editor seeded with the selected version.
//     Edits mutate that version in place (no automatic branching).
//   - Right pane: a reused AssistantPanel chat, transport pointed at the
//     workshop route, with a `proposeRewrite` tool that appends new
//     versions as the agent emits them.
//   - Versions: client-only state, stored as `BlockNoteBlock[]` per slot
//     so the editor can round-trip rich inline content even if the user
//     temporarily splits the paragraph into multiple blocks.
//   - Save: PATCHes the main block via the existing replaceBlock endpoint;
//     if the editor contains more than one block, prompts to consolidate.
//   - Cancel: exits without saving. No concurrency guard — the main doc is
//     frozen while workshop mode is active.

"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffWordsWithSpace, type Change } from "diff";
import type {
  BlockNoteBlock,
  DocumentBlockRecord,
  InlineContent,
  SupportedBlockType,
} from "@/src/shared/documents";
import {
  WorkshopAssistantPanel,
  type WorkshopChatContext,
} from "./workshop-assistant-panel";

// BlockNote is client-only; dynamic import with ssr:false matches the main
// doc editor and keeps the server render light.
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

/**
 * One slot in the versions stack. Each slot is a list of blocks so the
 * editor's intermediate state (user pressed Enter and temporarily has two
 * paragraphs) round-trips without forcing a consolidation mid-session.
 */
type Version = {
  blocks: BlockNoteBlock[];
  origin: "original" | "agent" | "user";
};

type ViewMode = "latest" | "diffPrev" | "diffOriginal";

type WorkshopWorkspaceProps = {
  documentId: string;
  documentBlocks: BlockNoteBlock[];
  // The block that was clicked from the side menu. Used as V0 and as the
  // PATCH target on save.
  targetBlock: BlockNoteBlock;
  targetBlockRevision: number;
  // Called when the user hits Cancel. The workshop is destroyed; no state
  // is persisted.
  onCancel: () => void;
  // Called after a successful PATCH. Carries the updated block record so
  // the parent can merge it into the main-doc state without a full
  // refetch.
  onSaved: (updatedBlock: DocumentBlockRecord) => void;
};

export function WorkshopWorkspace({
  documentId,
  documentBlocks,
  targetBlock,
  targetBlockRevision,
  onCancel,
  onSaved,
}: WorkshopWorkspaceProps) {
  // Initial version is the block as it exists in the main doc right now.
  // Cloned so later edits don't mutate the original reference shared with
  // the parent workspace.
  const initialVersions = useMemo<Version[]>(
    () => [
      {
        blocks: [cloneBlock(targetBlock)],
        origin: "original" as const,
      },
    ],
    [targetBlock],
  );

  // Versions and the currently-selected index share a single state atom
  // so updates stay consistent when an agent proposal arrives: we need to
  // both append to `versions` and advance `currentVersionIndex` to the new
  // tail, and doing that from two separate setters risks reading a stale
  // length via closure.
  const [{ versions, currentVersionIndex }, setVersionState] = useState<{
    versions: Version[];
    currentVersionIndex: number;
  }>({ versions: initialVersions, currentVersionIndex: 0 });
  const [viewMode, setViewMode] = useState<ViewMode>("latest");
  const [consolidateDialogOpen, setConsolidateDialogOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Each editor remount needs a unique key so BlockNote picks up a new
  // initialContent. We bump this whenever we swap which version is
  // displayed or inject a new agent proposal.
  const [editorKey, setEditorKey] = useState(0);
  // Transient state for the agent-proposal flash animation. When non-null,
  // an overlay renders over the target block and word-diffs `from` against
  // `to` for a brief window before dissolving; see ProposalFlash below.
  const [pendingFlash, setPendingFlash] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) {
        clearTimeout(flashTimeoutRef.current);
      }
    };
  }, []);

  // Keep a ref to the latest context so the chat transport's body function
  // captures the freshest snapshot every send without re-binding.
  const contextRef = useRef<WorkshopChatContext>({
    documentBlocks,
    targetBlockId: targetBlock.id,
    versions: versions.map((version) => blocksToInlineContent(version.blocks)),
    currentVersionIndex,
  });

  useEffect(() => {
    contextRef.current = {
      documentBlocks,
      targetBlockId: targetBlock.id,
      versions: versions.map((version) =>
        blocksToInlineContent(version.blocks),
      ),
      currentVersionIndex,
    };
  }, [documentBlocks, targetBlock.id, versions, currentVersionIndex]);

  const currentVersion = versions[currentVersionIndex];

  // Ref handle onto the live editor contents. BlockNote fires onChange on
  // every keystroke; we stash the latest blocks here so Save/version-nav
  // can commit the in-editor state without a race with React state.
  // Sync in an effect (not during render) so React-18+ ref rules are
  // respected — the ref exists only so handlers running after render can
  // read the freshest blocks without needing a re-render.
  const liveEditorBlocksRef = useRef<BlockNoteBlock[]>(currentVersion.blocks);
  useEffect(() => {
    liveEditorBlocksRef.current = currentVersion.blocks;
  }, [currentVersion.blocks]);

  // Scroll so the workshopped paragraph sits roughly centered on entry
  // (and on version swap, since editorKey bumps change the DOM subtree
  // entirely). The browser clamps at the scroll top, so if the target is
  // the first paragraph it naturally lands as close to center as the
  // content allows — no special case needed.
  //
  // BlockNoteDocumentEditor is loaded via `next/dynamic` with `ssr:false`,
  // so on initial mount the editor DOM doesn't exist yet and a bare rAF
  // check would miss the target. A short-lived MutationObserver watches
  // the pane subtree until the block appears, then scrolls once. The
  // observer self-disconnects on success and on effect teardown, so it
  // can't outlive the current editor instance.
  const editorPaneRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (viewMode !== "latest") {
      return;
    }
    const pane = editorPaneRef.current;
    if (!pane) {
      return;
    }
    const escapedId =
      typeof CSS !== "undefined" && "escape" in CSS
        ? CSS.escape(targetBlock.id)
        : targetBlock.id;
    const selector = `[data-node-type="blockOuter"][data-id="${escapedId}"]`;

    const tryScroll = () => {
      const node = pane.querySelector<HTMLElement>(selector);
      if (!node) {
        return false;
      }
      node.scrollIntoView({ block: "center", behavior: "auto" });
      return true;
    };

    if (tryScroll()) {
      return;
    }
    const observer = new MutationObserver(() => {
      if (tryScroll()) {
        observer.disconnect();
      }
    });
    observer.observe(pane, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [editorKey, targetBlock.id, viewMode]);

  const handleEditorChange = useCallback(
    (blocks: BlockNoteBlock[]) => {
      // The editor now holds the full document (so surrounding paragraphs
      // render as read-only context). Versions only track the workshopped
      // block, so narrow the onChange payload to the target slot. The
      // filterTransaction lock guarantees non-target blocks never mutate,
      // but we filter by id here too so we don't accidentally capture
      // stale context if that ever slips.
      const targetBlocks = blocks.filter(
        (block) => block.id === targetBlock.id,
      );
      if (targetBlocks.length === 0) {
        return;
      }
      liveEditorBlocksRef.current = targetBlocks;
      // Mutate the current version in place. User edits do not branch —
      // see plan doc for the rationale.
      setVersionState((current) => {
        const next = [...current.versions];
        next[current.currentVersionIndex] = {
          ...next[current.currentVersionIndex],
          blocks: targetBlocks,
          origin:
            next[current.currentVersionIndex].origin === "original"
              ? "user"
              : next[current.currentVersionIndex].origin,
        };
        return { ...current, versions: next };
      });
    },
    [targetBlock.id],
  );

  const selectVersion = useCallback((index: number) => {
    let landed = false;
    setVersionState((current) => {
      if (index < 0 || index >= current.versions.length) {
        return current;
      }
      landed = true;
      // Commit the current in-editor state before swapping so no
      // keystrokes are lost to the remount.
      const next = [...current.versions];
      next[current.currentVersionIndex] = {
        ...next[current.currentVersionIndex],
        blocks: liveEditorBlocksRef.current,
      };
      return { versions: next, currentVersionIndex: index };
    });
    if (!landed) {
      return;
    }
    setEditorKey((key) => key + 1);
    // Diff modes are only valid when there's a version to compare
    // against. Navigating to V0 leaves "diff prev" with no base and
    // "diff V0" comparing V0 against itself, so we fall back to the
    // normal edit view — the toggle buttons reflect this automatically
    // via their `canDiffPrev` / `canDiffOriginal` gates.
    if (index === 0) {
      setViewMode("latest");
    }
  }, []);

  const handleProposedRewrite = useCallback(
    (content: InlineContent[]) => {
      // Snapshot the current version's plain text BEFORE we mutate state —
      // the flash overlay diffs "where we were" against "where we're going",
      // and reading live state from inside the updater would fight the ref-
      // driven edit pipeline. `liveEditorBlocksRef` carries any uncommitted
      // keystrokes the user made since the last onChange batch.
      const fromPlain = inlineContentToPlainText(
        blocksToInlineContent(liveEditorBlocksRef.current),
      );
      const toPlain = inlineContentToPlainText(content);

      setVersionState((current) => {
        const newVersion: Version = {
          blocks: [
            {
              // Every version's block carries the original target id so
              // the editor's lock extension (which matches on id) keeps
              // working after we remount onto this version. Also keeps
              // the eventual PATCH identity stable without a later
              // rewrite at save time.
              id: targetBlock.id,
              type: "paragraph",
              props: {},
              content,
              children: [],
            },
          ],
          origin: "agent",
        };
        return {
          versions: [...current.versions, newVersion],
          currentVersionIndex: current.versions.length,
        };
      });
      setViewMode("latest");
      setEditorKey((key) => key + 1);

      // Skip the flash when there's nothing to see (identical rewrite) or
      // when the user has asked the OS to reduce motion. In both cases the
      // editor remount above is the whole transition.
      const reducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reducedMotion || fromPlain === toPlain) {
        return;
      }
      if (flashTimeoutRef.current) {
        clearTimeout(flashTimeoutRef.current);
      }
      setPendingFlash({ from: fromPlain, to: toPlain });
      flashTimeoutRef.current = setTimeout(() => {
        setPendingFlash(null);
        flashTimeoutRef.current = null;
      }, 900);
    },
    [targetBlock.id],
  );

  // Swap out the editor contents for the currently selected version
  // whenever we explicitly change selection. Note we pass `initialBlocks`
  // to BlockNoteDocumentEditor and rely on `editorKey` to trigger a
  // remount — BlockNote doesn't pick up `initialContent` changes on
  // existing editor instances.
  //
  // The editor shows the whole document so the user can see the paragraph
  // being workshopped in its surrounding context. The target slot is
  // replaced with the selected version's block(s) so the in-progress edit
  // is what renders at that position. The lock extension keeps every
  // other slot read-only.
  const editorSeedBlocks = useMemo(() => {
    const targetIndex = documentBlocks.findIndex(
      (block) => block.id === targetBlock.id,
    );
    if (targetIndex === -1) {
      // The server validated the block exists at workshop entry, so this
      // only fires in pathological cases (e.g., a race where the parent
      // mutated documentBlocks). Fall back to target-only rendering —
      // worse visual, but the editor still works.
      return currentVersion.blocks;
    }
    const merged = [...documentBlocks];
    merged.splice(targetIndex, 1, ...currentVersion.blocks);
    return merged;
  }, [documentBlocks, targetBlock.id, currentVersion]);

  const doSave = useCallback(
    async (consolidate: boolean) => {
      setSaving(true);
      setSaveError(null);
      setConsolidateDialogOpen(false);

      // Commit the live editor state into the current version before
      // reading it out — handleEditorChange fires debounced, so there can
      // be a pending frame of edits in the ref but not yet in state.
      const liveBlocks = liveEditorBlocksRef.current;

      let blockJson: BlockNoteBlock;
      if (liveBlocks.length === 1) {
        blockJson = {
          ...liveBlocks[0],
          id: targetBlock.id,
        };
      } else if (consolidate) {
        blockJson = consolidateBlocks(liveBlocks, targetBlock.id);
      } else {
        setSaving(false);
        setConsolidateDialogOpen(true);
        return;
      }

      try {
        const response = await fetch(
          `/api/documents/${documentId}/blocks/${targetBlock.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              blockJson,
              expectedRevision: targetBlockRevision,
            }),
          },
        );

        if (!response.ok) {
          const payload = await response
            .json()
            .catch(() => ({ error: "Save failed." }));
          setSaveError(payload.error ?? "Save failed.");
          setSaving(false);
          return;
        }

        const saved = (await response.json()) as DocumentBlockRecord;
        onSaved(saved);
      } catch (error) {
        setSaveError(
          error instanceof Error
            ? error.message
            : "Unexpected error during save.",
        );
        setSaving(false);
      }
    },
    [documentId, onSaved, targetBlock.id, targetBlockRevision],
  );

  const handleSaveClick = useCallback(() => {
    const liveBlocks = liveEditorBlocksRef.current;
    if (liveBlocks.length > 1) {
      setConsolidateDialogOpen(true);
      return;
    }
    void doSave(false);
  }, [doSave]);

  // "Changes exist" = any agent proposal OR any user edit on V0. We use
  // this to decide whether Cancel / browser-back should ask for
  // confirmation or just exit silently. Kept in a ref so the popstate
  // listener (registered once on mount) reads the freshest value without
  // having to re-register.
  const hasWorkshopChanges =
    versions.length > 1 || versions[0].origin !== "original";
  const hasChangesRef = useRef(hasWorkshopChanges);
  useEffect(() => {
    hasChangesRef.current = hasWorkshopChanges;
  }, [hasWorkshopChanges]);

  const handleCancelClick = useCallback(() => {
    if (hasChangesRef.current) {
      setCancelConfirmOpen(true);
      return;
    }
    onCancel();
  }, [onCancel]);

  // Back-button guard. We push a duplicate of the current URL onto the
  // history stack when the workshop mounts so the first back press lands
  // on a sentinel entry with the same URL. The popstate listener then
  // either lets the user leave (no changes) or opens the confirm dialog
  // and re-seats the sentinel so the URL stays on the workshop route
  // while the user decides. When the confirm dialog is dismissed with
  // "Keep editing", we're already on the sentinel — nothing else to do.
  // When they pick "Discard", `onCancel` runs and router.pushes to the
  // main doc URL.
  useEffect(() => {
    window.history.pushState(null, "", window.location.href);

    const onPopState = () => {
      if (!hasChangesRef.current) {
        // No work to lose. Go back once more to actually leave (past the
        // sentinel that just got consumed).
        window.history.back();
        return;
      }
      // Re-seat the sentinel so the visible URL snaps back to the
      // workshop route, then open the confirm dialog.
      window.history.pushState(null, "", window.location.href);
      setCancelConfirmOpen(true);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
    // The listener is registered exactly once per workshop mount; state
    // it needs is read through `hasChangesRef`.
  }, []);

  return (
    <main
      className="flex h-screen min-h-0 bg-[#f6f5f2] text-zinc-950"
      data-testid="workshop-workspace"
    >
      <section className="flex min-w-0 flex-1 flex-col border-r border-zinc-200 bg-white">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-6">
          <div className="flex items-center gap-3">
            <span
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900"
              data-testid="workshop-banner"
            >
              Workshop mode
            </span>
            <VersionNav
              total={versions.length}
              currentIndex={currentVersionIndex}
              onSelect={selectVersion}
              isAgentVersion={currentVersion.origin === "agent"}
            />
            <ViewModeToggle
              mode={viewMode}
              onChange={setViewMode}
              canDiffPrev={currentVersionIndex > 0}
              canDiffOriginal={currentVersionIndex > 0}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCancelClick}
              disabled={saving}
              className="rounded border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="workshop-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveClick}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="workshop-save"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </header>
        <div
          ref={editorPaneRef}
          className="relative min-h-0 flex-1 overflow-auto"
          data-testid="workshop-editor-pane"
        >
          {viewMode === "latest" ? (
            <>
              <ContextLockStyles targetBlockId={targetBlock.id} />
              <BlockNoteDocumentEditor
                key={editorKey}
                initialBlocks={editorSeedBlocks}
                onChange={handleEditorChange}
                lockedToBlockId={targetBlock.id}
              />
              {pendingFlash ? (
                <ProposalFlash
                  paneRef={editorPaneRef}
                  targetBlockId={targetBlock.id}
                  fromPlain={pendingFlash.from}
                  toPlain={pendingFlash.to}
                />
              ) : null}
            </>
          ) : (
            <DiffView
              mode={viewMode}
              versions={versions}
              currentIndex={currentVersionIndex}
            />
          )}
        </div>
        {saveError ? (
          <div
            className="border-t border-rose-200 bg-rose-50 px-6 py-2 text-sm text-rose-900"
            data-testid="workshop-save-error"
          >
            {saveError}
          </div>
        ) : null}
      </section>
      <aside className="flex w-[420px] shrink-0 flex-col bg-zinc-950 text-white">
        <WorkshopAssistantPanel
          contextRef={contextRef}
          onProposedRewrite={handleProposedRewrite}
        />
      </aside>
      {consolidateDialogOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="workshop-consolidate-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 px-4"
        >
          <div className="w-full max-w-md rounded-lg bg-white p-6 text-zinc-950 shadow-xl">
            <h2
              id="workshop-consolidate-title"
              className="text-base font-semibold"
            >
              Save as a single paragraph?
            </h2>
            <p
              className="mt-2 text-sm text-zinc-600"
              data-testid="workshop-consolidate-body"
            >
              Your workshop currently contains {currentVersion.blocks.length}{" "}
              paragraphs. The main document only allows the workshopped block to
              stay one paragraph, so they will be joined into one on save.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConsolidateDialogOpen(false)}
                className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100"
                data-testid="workshop-consolidate-cancel"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => void doSave(true)}
                className="rounded bg-zinc-950 px-3 py-1.5 text-sm text-white transition hover:bg-zinc-800"
                data-testid="workshop-consolidate-confirm"
              >
                Join and save
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {cancelConfirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="workshop-cancel-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 px-4"
          data-testid="workshop-cancel-dialog"
        >
          <div className="w-full max-w-md rounded-lg bg-white p-6 text-zinc-950 shadow-xl">
            <h2 id="workshop-cancel-title" className="text-base font-semibold">
              Discard workshop?
            </h2>
            <p className="mt-2 text-sm text-zinc-600">
              {versions.length > 1
                ? `Your workshop has ${versions.length - 1} proposal${versions.length > 2 ? "s" : ""} that will be lost.`
                : "Your edits to the paragraph will be lost."}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancelConfirmOpen(false)}
                className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100"
                data-testid="workshop-cancel-dialog-keep"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  setCancelConfirmOpen(false);
                  onCancel();
                }}
                className="rounded bg-rose-600 px-3 py-1.5 text-sm text-white transition hover:bg-rose-700"
                data-testid="workshop-cancel-dialog-discard"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

/**
 * Arrow-based navigator between versions. Shows which slot is active and
 * whether the currently-displayed version was authored by the user, agent,
 * or is the original.
 */
function VersionNav({
  total,
  currentIndex,
  onSelect,
  isAgentVersion,
}: {
  total: number;
  currentIndex: number;
  onSelect: (index: number) => void;
  isAgentVersion: boolean;
}) {
  const label =
    currentIndex === 0
      ? "V0 (original)"
      : `V${currentIndex}${isAgentVersion ? " (agent)" : ""}`;

  return (
    <div className="flex items-center gap-1" data-testid="workshop-version-nav">
      <button
        type="button"
        onClick={() => onSelect(currentIndex - 1)}
        disabled={currentIndex === 0}
        className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="workshop-version-prev"
        aria-label="Previous version"
      >
        ←
      </button>
      <span
        className="min-w-[120px] text-center text-xs font-medium text-zinc-700"
        data-testid="workshop-version-label"
      >
        {label} · {currentIndex + 1} / {total}
      </span>
      <button
        type="button"
        onClick={() => onSelect(currentIndex + 1)}
        disabled={currentIndex === total - 1}
        className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="workshop-version-next"
        aria-label="Next version"
      >
        →
      </button>
    </div>
  );
}

/**
 * Three-state toggle for how the selected version renders in the left
 * pane. Diff modes are disabled when there's no comparison target.
 */
function ViewModeToggle({
  mode,
  onChange,
  canDiffPrev,
  canDiffOriginal,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  canDiffPrev: boolean;
  canDiffOriginal: boolean;
}) {
  return (
    <div
      className="flex items-center gap-1 rounded border border-zinc-200 p-0.5"
      data-testid="workshop-view-mode"
    >
      <ToggleButton
        active={mode === "latest"}
        onClick={() => onChange("latest")}
        testId="workshop-view-latest"
      >
        Edit
      </ToggleButton>
      <ToggleButton
        active={mode === "diffPrev"}
        onClick={() => onChange("diffPrev")}
        disabled={!canDiffPrev}
        testId="workshop-view-diff-prev"
      >
        Diff prev
      </ToggleButton>
      <ToggleButton
        active={mode === "diffOriginal"}
        onClick={() => onChange("diffOriginal")}
        disabled={!canDiffOriginal}
        testId="workshop-view-diff-original"
      >
        Diff V0
      </ToggleButton>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  disabled,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`rounded px-2 py-1 text-xs transition ${
        active
          ? "bg-zinc-900 text-white"
          : "text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Read-only diff rendering for the two diff view modes. Uses `jsdiff`'s
 * word-level diff over the plain-text projection of each version; inline
 * styling is not preserved in the diff view (it's still in the underlying
 * data and will be preserved on Save).
 */
function DiffView({
  mode,
  versions,
  currentIndex,
}: {
  mode: Exclude<ViewMode, "latest">;
  versions: Version[];
  currentIndex: number;
}) {
  const baseIndex = mode === "diffPrev" ? currentIndex - 1 : 0;
  const currentVersion = versions[currentIndex];
  const baseVersion = versions[baseIndex];

  // Safety net for stale diff mode: the toggle buttons gate these modes
  // on `canDiffPrev` / `canDiffOriginal`, and `selectVersion` resets to
  // the edit view on nav to V0 — but a defensive guard here keeps the
  // whole workspace from crashing if those gates ever get out of sync.
  if (!currentVersion || !baseVersion) {
    return (
      <div
        className="mx-auto min-h-full max-w-3xl px-10 py-12 text-sm text-zinc-500"
        data-testid="workshop-diff"
      >
        No previous version to compare against.
      </div>
    );
  }

  const currentText = versionToPlainText(currentVersion);
  const baseText = versionToPlainText(baseVersion);

  const changes: Change[] = diffWordsWithSpace(baseText, currentText);

  return (
    <div
      className="mx-auto min-h-full max-w-3xl px-10 py-12"
      data-testid="workshop-diff"
    >
      <p className="mb-3 text-xs uppercase tracking-wide text-zinc-500">
        {mode === "diffPrev"
          ? `V${baseIndex} → V${currentIndex}`
          : `V0 → V${currentIndex}`}
      </p>
      <p className="whitespace-pre-wrap text-base leading-7 text-zinc-900">
        {changes.map((change, index) => {
          if (change.added) {
            return (
              <span
                key={index}
                className="rounded bg-emerald-100 text-emerald-900"
                data-testid="workshop-diff-added"
              >
                {change.value}
              </span>
            );
          }
          if (change.removed) {
            return (
              <span
                key={index}
                className="rounded bg-rose-100 text-rose-900 line-through"
                data-testid="workshop-diff-removed"
              >
                {change.value}
              </span>
            );
          }
          return <span key={index}>{change.value}</span>;
        })}
      </p>
    </div>
  );
}

// Deep clone a block. Versions are mutated in place as the user edits, so
// the initial snapshot must not share references with the caller's copy
// of the same block.
function cloneBlock(block: BlockNoteBlock): BlockNoteBlock {
  return JSON.parse(JSON.stringify(block)) as BlockNoteBlock;
}

/**
 * Flatten a multi-block version into a single inline-content array — the
 * shape the server prompt expects for version history rendering and the
 * shape the agent proposes in. Between-block joins use a single space,
 * matching the consolidation behavior at save time.
 */
function blocksToInlineContent(blocks: BlockNoteBlock[]): InlineContent[] {
  const joined: InlineContent[] = [];
  blocks.forEach((block, index) => {
    const content = block.content;
    if (Array.isArray(content)) {
      if (index > 0) {
        joined.push({ type: "text", text: " ", styles: {} });
      }
      for (const item of content) {
        joined.push(item);
      }
    } else if (typeof content === "string" && content.length > 0) {
      if (index > 0) {
        joined.push({ type: "text", text: " ", styles: {} });
      }
      joined.push({ type: "text", text: content, styles: {} });
    }
  });
  return joined;
}

/**
 * Consolidate multiple workshop blocks into one block for save. Preserves
 * the first block's id (so the PATCH targets the original row) and type,
 * and joins inline content with a single space between blocks.
 */
function consolidateBlocks(
  blocks: BlockNoteBlock[],
  targetId: string,
): BlockNoteBlock {
  const first = blocks[0];
  const content = blocksToInlineContent(blocks);
  return {
    id: targetId,
    type: (first.type as SupportedBlockType) ?? "paragraph",
    props: first.props ?? {},
    content,
    children: [],
  };
}

function versionToPlainText(version: Version): string {
  return version.blocks
    .map((block) => inlineContentToPlainText(block.content))
    .filter(Boolean)
    .join(" ");
}

/**
 * Scoped style tag that greys out every block in the workshop editor pane
 * except the one being workshopped.
 *
 * Rendered inline because the target id is only known at runtime — a
 * static stylesheet can't do "not equal to this specific UUID". Escaping
 * defends against ids that ever stop being plain alphanumeric (DB ids
 * today are UUIDs, but the extra line is cheap). The workshop route is
 * client-only (`ssr: false`), so CSS.escape is available when this
 * renders.
 */
function ContextLockStyles({ targetBlockId }: { targetBlockId: string }) {
  const escapedId =
    typeof CSS !== "undefined" && "escape" in CSS
      ? CSS.escape(targetBlockId)
      : targetBlockId;
  const css = `
    [data-testid="workshop-editor-pane"] [data-node-type="blockOuter"]:not([data-id="${escapedId}"]) {
      opacity: 0.35;
      transition: opacity 120ms ease;
    }
    [data-testid="workshop-editor-pane"] [data-node-type="blockOuter"]:not([data-id="${escapedId}"]) * {
      cursor: default;
    }
    [data-testid="workshop-editor-pane"] [data-node-type="blockOuter"][data-id="${escapedId}"] {
      position: relative;
    }
    [data-testid="workshop-editor-pane"] [data-node-type="blockOuter"][data-id="${escapedId}"]::before {
      content: "";
      position: absolute;
      left: -14px;
      top: 6px;
      bottom: 6px;
      width: 2px;
      background: rgb(217 119 6);
      border-radius: 1px;
    }
  `;
  return <style data-testid="workshop-context-lock-styles">{css}</style>;
}

function inlineContentToPlainText(content: BlockNoteBlock["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "link") {
        return inlineContentToPlainText(item.content);
      }
      return "";
    })
    .join("");
}

/**
 * Transient overlay shown the moment an agent proposal arrives. Covers the
 * target paragraph for ~900ms and plays a word-level diff: removed words
 * fade out with a strikethrough, added words fade in under a soft green
 * highlight that then settles. Purely visual — the real version swap has
 * already happened behind the overlay, so when this component unmounts the
 * editor underneath is already showing the final content.
 *
 * To keep the animation legible the overlay targets BlockNote's
 * `.bn-inline-content` element (where the actual text sits) and copies its
 * computed font, spacing, and padding onto the overlay's text node. That
 * way line wrapping, vertical rhythm, and indentation match the underlying
 * paragraph — words flash in and out at exactly the positions they'll
 * occupy once the editor re-renders. Inline styling (bold/italic/links)
 * is intentionally flattened to plain text during the flash: the trade-off
 * is that a bolded word won't animate bold, but the 900ms window ends with
 * the real rich-content editor taking over, so the rich style returns on
 * handoff.
 */
function ProposalFlash({
  paneRef,
  targetBlockId,
  fromPlain,
  toPlain,
}: {
  paneRef: React.RefObject<HTMLDivElement | null>;
  targetBlockId: string;
  fromPlain: string;
  toPlain: string;
}) {
  const [layout, setLayout] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    textStyle: React.CSSProperties;
  } | null>(null);

  // The editor remount (new editorKey) happens in the same render cycle
  // that mounts this overlay, so the block DOM may not exist yet on first
  // effect tick. A short MutationObserver mirrors the scroll-to-center
  // strategy used for the main editor: try once, then watch for the block
  // to appear and try again. Measured geometry is captured once — for a
  // 900ms flash, chasing live layout changes isn't worth the complexity.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) {
      return;
    }
    const escapedId =
      typeof CSS !== "undefined" && "escape" in CSS
        ? CSS.escape(targetBlockId)
        : targetBlockId;
    // `.bn-inline-content` is BlockNote's internal wrapper around the
    // actual text runs. Measuring it (instead of the blockOuter) gives us
    // the correct text box — the blockOuter includes side-menu gutter
    // space that would shift the overlay a few px to the left of the text.
    const selector = `[data-node-type="blockOuter"][data-id="${escapedId}"] .bn-inline-content`;

    const measure = (): boolean => {
      const el = pane.querySelector<HTMLElement>(selector);
      if (!el) {
        return false;
      }
      const paneRect = pane.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      // Zero width almost certainly means the element is still laying out
      // (BlockNote's react-renderer mounts in a couple of phases). Defer
      // until the MutationObserver fires us again with real dimensions.
      if (rect.width === 0 || rect.height === 0) {
        return false;
      }
      const computed = window.getComputedStyle(el);
      setLayout({
        top: rect.top - paneRect.top + pane.scrollTop,
        left: rect.left - paneRect.left + pane.scrollLeft,
        width: rect.width,
        height: rect.height,
        textStyle: {
          fontFamily: computed.fontFamily,
          fontSize: computed.fontSize,
          fontWeight: computed.fontWeight as React.CSSProperties["fontWeight"],
          fontStyle: computed.fontStyle,
          lineHeight: computed.lineHeight,
          letterSpacing: computed.letterSpacing,
          color: computed.color,
          textAlign: computed.textAlign as React.CSSProperties["textAlign"],
          textIndent: computed.textIndent,
          textTransform:
            computed.textTransform as React.CSSProperties["textTransform"],
          paddingTop: computed.paddingTop,
          paddingRight: computed.paddingRight,
          paddingBottom: computed.paddingBottom,
          paddingLeft: computed.paddingLeft,
          // Preserve wrap behavior (BlockNote sometimes sets pre-wrap),
          // otherwise the diffed spaces could collapse differently from
          // the editor.
          whiteSpace: computed.whiteSpace as React.CSSProperties["whiteSpace"],
          wordSpacing: computed.wordSpacing,
          margin: 0,
        },
      });
      return true;
    };

    if (measure()) {
      return;
    }
    const observer = new MutationObserver(() => {
      if (measure()) {
        observer.disconnect();
      }
    });
    observer.observe(pane, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [paneRef, targetBlockId]);

  const changes = useMemo(
    () => diffWordsWithSpace(fromPlain, toPlain),
    [fromPlain, toPlain],
  );

  if (!layout) {
    return null;
  }

  return (
    <>
      <style data-testid="workshop-flash-styles">{FLASH_KEYFRAMES}</style>
      <div
        className="pointer-events-none absolute z-10 overflow-hidden bg-white"
        style={{
          top: layout.top,
          left: layout.left,
          width: layout.width,
          minHeight: layout.height,
        }}
        data-testid="workshop-proposal-flash"
      >
        <div style={layout.textStyle}>
          {changes.map((change, index) => {
            if (change.added) {
              return (
                <span
                  key={index}
                  className="workshop-flash-added"
                  data-testid="workshop-flash-added"
                >
                  {change.value}
                </span>
              );
            }
            if (change.removed) {
              return (
                <span
                  key={index}
                  className="workshop-flash-removed"
                  data-testid="workshop-flash-removed"
                >
                  {change.value}
                </span>
              );
            }
            return <span key={index}>{change.value}</span>;
          })}
        </div>
      </div>
    </>
  );
}

// Keyframes are colocated with ProposalFlash because the component is the
// only consumer — keeping them inline avoids pulling another global CSS
// entry point into the workshop module. Timings are tuned against the
// 900ms setTimeout in handleProposedRewrite: the green highlight is
// already fading by the time the overlay unmounts, so the handoff to the
// underlying editor looks continuous.
const FLASH_KEYFRAMES = `
  @keyframes workshop-flash-remove {
    0%   { opacity: 1; }
    40%  { opacity: 0.55; }
    100% { opacity: 0; }
  }
  @keyframes workshop-flash-add {
    0%   { opacity: 0.35; background-color: rgba(16, 185, 129, 0.18); }
    45%  { opacity: 1; background-color: rgba(16, 185, 129, 0.42); }
    75%  { opacity: 1; background-color: rgba(16, 185, 129, 0.42); }
    100% { opacity: 1; background-color: rgba(16, 185, 129, 0); }
  }
  .workshop-flash-removed {
    text-decoration: line-through;
    color: rgb(190, 24, 93);
    animation: workshop-flash-remove 550ms ease-in forwards;
  }
  .workshop-flash-added {
    padding: 0 2px;
    border-radius: 2px;
    animation: workshop-flash-add 900ms ease-out both;
  }
`;

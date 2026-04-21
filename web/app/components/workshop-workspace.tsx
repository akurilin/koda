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

  const handleEditorChange = useCallback((blocks: BlockNoteBlock[]) => {
    liveEditorBlocksRef.current = blocks;
    // Mutate the current version in place. User edits do not branch —
    // see plan doc for the rationale.
    setVersionState((current) => {
      const next = [...current.versions];
      next[current.currentVersionIndex] = {
        ...next[current.currentVersionIndex],
        blocks,
        origin:
          next[current.currentVersionIndex].origin === "original"
            ? "user"
            : next[current.currentVersionIndex].origin,
      };
      return { ...current, versions: next };
    });
  }, []);

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

  const handleProposedRewrite = useCallback((content: InlineContent[]) => {
    setVersionState((current) => {
      const newVersion: Version = {
        blocks: [
          {
            id:
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `prop-${Date.now()}`,
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
  }, []);

  // Swap out the editor contents for the currently selected version
  // whenever we explicitly change selection. Note we pass `initialBlocks`
  // to BlockNoteDocumentEditor and rely on `editorKey` to trigger a
  // remount — BlockNote doesn't pick up `initialContent` changes on
  // existing editor instances.
  const editorSeedBlocks = useMemo(
    () => currentVersion.blocks,
    [currentVersion],
  );

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
          className="min-h-0 flex-1 overflow-auto"
          data-testid="workshop-editor-pane"
        >
          {viewMode === "latest" ? (
            <BlockNoteDocumentEditor
              key={editorKey}
              initialBlocks={editorSeedBlocks}
              onChange={handleEditorChange}
            />
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

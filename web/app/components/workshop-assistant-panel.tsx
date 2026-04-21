// Assistant panel variant used in workshop mode.
//
// Mirrors the main AssistantPanel UX so the user sees the same chat surface,
// but points the transport at `/api/workshop/chat` and sends the workshop
// snapshot (document, target block, versions, current index) with every
// turn via the transport `body` callback.
//
// The agent's only write-side capability is the `proposeRewrite` tool. A
// tool-UI renderer registered here watches for successful tool results and
// hands the normalized inline content back to the parent, which appends it
// as a new entry in the versions stack.
//
// The tool renderer is split into a module-level component and uses React
// context to reach the parent's callback. This stability matters: if the
// render function were a fresh closure per parent render, assistant-ui's
// `useAssistantToolUI` would re-register it on every render, remount the
// tool part, and the per-instance "already notified" ref would reset,
// causing the same proposal to fire its callback dozens of times.

"use client";

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantToolUI,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { BlockNoteBlock, InlineContent } from "@/src/shared/documents";

export type WorkshopChatContext = {
  documentBlocks: BlockNoteBlock[];
  targetBlockId: string;
  versions: InlineContent[][];
  currentVersionIndex: number;
};

type WorkshopAssistantPanelProps = {
  // Read through a ref so the transport picks up the freshest workshop
  // snapshot on each request without our having to rebuild the transport
  // when versions change.
  contextRef: React.RefObject<WorkshopChatContext>;
  onProposedRewrite: (content: InlineContent[]) => void;
};

// Context used by the module-level tool UI renderer to reach the current
// panel's callback. A ref is passed (rather than the callback directly) so
// the renderer always sees the freshest function without causing the
// context consumer to re-render when the callback identity changes.
const ProposedRewriteContext = createContext<{
  current: (content: InlineContent[]) => void;
}>({
  current: () => {},
});

export function WorkshopAssistantPanel({
  contextRef,
  onProposedRewrite,
}: WorkshopAssistantPanelProps) {
  // `body` accepts a function so the transport re-reads the workshop state
  // at request time; it sends alongside `messages` on every turn. The ref
  // read happens at request time (well after render), so the lint rule
  // that flags render-time ref access does not apply here.
  /* eslint-disable react-hooks/refs */
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: `/api/workshop/chat`,
        body: () => ({ context: contextRef.current }),
      }),
    [contextRef],
  );
  /* eslint-enable react-hooks/refs */
  const runtime = useChatRuntime({ transport });

  const callbackRef = useRef(onProposedRewrite);
  useEffect(() => {
    callbackRef.current = onProposedRewrite;
  }, [onProposedRewrite]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ProposedRewriteContext.Provider value={callbackRef}>
        <WorkshopToolUIRegistration />
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-testid="workshop-agent-pane"
        >
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-5">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-zinc-400">
                Workshop
              </p>
              <h2 className="text-base font-semibold">
                Paragraph collaborator
              </h2>
            </div>
          </header>
          <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-auto px-4 py-5">
              <ThreadPrimitive.Empty>
                <div className="rounded border border-white/10 bg-white/[0.03] p-4 text-sm leading-6 text-zinc-300">
                  Ask the agent to critique, tighten, rewrite, or brainstorm
                  alternatives. Each proposal lands as a new version in the
                  stack — you decide which one to save.
                </div>
              </ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages
                components={{
                  UserMessage,
                  AssistantMessage,
                }}
              />
            </ThreadPrimitive.Viewport>
            <ComposerPrimitive.Root className="border-t border-white/10 p-4">
              <div className="flex gap-2">
                <ComposerPrimitive.Input
                  className="max-h-36 min-h-12 flex-1 resize-none rounded border border-white/15 bg-white px-3 py-2 text-sm leading-5 text-zinc-950 outline-none focus:border-white"
                  placeholder="Ask for a rewrite, critique, or tips..."
                  data-testid="workshop-agent-input"
                />
                <ComposerPrimitive.Send
                  className="h-12 rounded bg-white px-4 text-sm font-medium text-zinc-950 hover:bg-zinc-200"
                  data-testid="workshop-agent-send"
                >
                  Send
                </ComposerPrimitive.Send>
              </div>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.Root>
        </div>
      </ProposedRewriteContext.Provider>
    </AssistantRuntimeProvider>
  );
}

/**
 * Register the `proposeRewrite` tool UI exactly once. The config object and
 * the render component are both module-level constants so assistant-ui's
 * `setToolUI(toolName, render)` sees stable identities and does not
 * re-register (and thus re-mount) on every parent render.
 */
function WorkshopToolUIRegistration() {
  useAssistantToolUI(PROPOSE_REWRITE_TOOL_UI);
  return null;
}

const PROPOSE_REWRITE_TOOL_UI = {
  toolName: "proposeRewrite",
  render: ProposeRewriteRender,
} as const;

type ProposeRewriteResult =
  | { ok: true; content: InlineContent[] }
  | { ok: false; reason: string };

function ProposeRewriteRender(props: {
  result?: unknown;
  status: { type: string };
}) {
  const callbackRef = useContext(ProposedRewriteContext);
  const notified = useRef(false);
  const { result, status } = props;

  useEffect(() => {
    if (notified.current) {
      return;
    }
    if (status.type !== "complete") {
      return;
    }
    const parsed = parseProposeRewriteResult(result);
    if (parsed && parsed.ok) {
      notified.current = true;
      callbackRef.current(parsed.content);
    }
  }, [status.type, result, callbackRef]);

  const parsed = parseProposeRewriteResult(result);
  const ok = status.type === "complete" && parsed && parsed.ok === true;

  return (
    <div
      className="mb-2 rounded border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
      data-testid="workshop-tool-propose-rewrite"
    >
      {status.type === "running"
        ? "Proposing a rewrite…"
        : ok
          ? "Proposed a new version."
          : "Proposal rejected."}
    </div>
  );
}

function parseProposeRewriteResult(
  value: unknown,
): ProposeRewriteResult | null {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true && Array.isArray(record.content)) {
    return {
      ok: true,
      content: record.content as InlineContent[],
    };
  }
  if (record.ok === false) {
    return {
      ok: false,
      reason: typeof record.reason === "string" ? record.reason : "Unknown",
    };
  }
  return null;
}

// Bubble styling lifted from AssistantPanel so the two surfaces feel
// identical. Kept copy-pasted rather than extracted since the file count
// is small and the shared abstraction would obscure what each panel does.
function UserMessage() {
  return (
    <MessagePrimitive.Root className="mb-4 ml-auto max-w-[85%] rounded bg-white px-3 py-2 text-sm leading-6 text-zinc-950">
      <MessagePrimitive.Content />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mb-4 max-w-[92%] rounded border border-white/10 bg-white/[0.04] px-3 py-2 text-sm leading-6 text-zinc-100">
      <MessagePrimitive.Content
        components={{
          Text: MessageText,
        }}
      />
    </MessagePrimitive.Root>
  );
}

function MessageText() {
  return (
    <div className="whitespace-pre-wrap">
      <MessagePartPrimitive.Text />
    </div>
  );
}

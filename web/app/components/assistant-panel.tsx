// Right-hand editorial assistant panel.
//
// Pure consumer of the assistant-ui runtime context. The parent workspace
// owns the runtime (so it can read `isRunning` to lock the editor while the
// agent writes) and wraps this panel with `AssistantRuntimeProvider`.
//
// The "Refresh" button calls back into the workspace as an escape hatch so
// the editor can pull the freshest server state outside the normal
// agent-finished transition refresh.

"use client";

import {
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";

type AssistantPanelProps = {
  onRefreshDocument: () => Promise<void>;
};

export function AssistantPanel({ onRefreshDocument }: AssistantPanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-pane">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-zinc-400">
            Agent
          </p>
          <h2 className="text-base font-semibold">Editorial assistant</h2>
        </div>
        <button
          type="button"
          className="rounded border border-white/15 px-2 py-1 text-xs text-zinc-300 hover:border-white/30 hover:text-white"
          onClick={() => void onRefreshDocument()}
        >
          Refresh
        </button>
      </header>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-auto px-4 py-5">
          <ThreadPrimitive.Empty>
            <div className="rounded border border-white/10 bg-white/[0.03] p-4 text-sm leading-6 text-zinc-300">
              Ask for focused edits to the current draft. Or ask for feedback on
              the text. The agent can inspect the document and update individual
              blocks through tools.
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
              placeholder="Ask the agent to revise the draft..."
              data-testid="agent-input"
            />
            <ComposerPrimitive.Send
              className="h-12 rounded bg-white px-4 text-sm font-medium text-zinc-950 hover:bg-zinc-200"
              data-testid="agent-send"
            >
              Send
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </div>
  );
}

// Chat bubble styling split out so the runtime's default renderer uses our
// look instead of the package defaults. Kept intentionally stateless.
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

// `whitespace-pre-wrap` so model output that uses newlines renders the way
// the model wrote it, instead of collapsing into one paragraph.
function MessageText() {
  return (
    <div className="whitespace-pre-wrap">
      <MessagePartPrimitive.Text />
    </div>
  );
}

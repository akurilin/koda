// Per-block feedback markers rendered over the main-editor pane.
//
// For every block whose `feedback` is non-null, we render a thin orange
// bar along the block's left edge. Hovering the bar reveals a popover
// with the feedback text. This is the only affordance a user has for
// seeing what the reviewer agent suggested without entering workshop
// mode.
//
// Why an overlay instead of styling BlockNote's own DOM: BlockNote's
// block wrappers aren't React components we own, so we can't attach
// props or event handlers to them directly. Rendering a sibling overlay
// that measures against the block's `[data-id]` attribute keeps the
// integration one-way — we observe BlockNote's DOM, never mutate it.
//
// Position bookkeeping: each bar is absolutely positioned inside the
// scroll container (which is declared `relative` in the parent). We
// measure the block's geometry on mount, on ResizeObserver fires, and
// whenever the blocks list changes. We don't listen for scroll events
// because both the bar and the block are children of the same scroll
// container — they scroll together, so relative coordinates stay
// stable.

"use client";

import { useLayoutEffect, useState } from "react";
import type { DocumentBlockRecord } from "@/src/shared/documents";

type FeedbackOverlaysProps = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  blocks: DocumentBlockRecord[];
};

/**
 * Render one `<FeedbackBar />` per block with non-null feedback.
 *
 * Accepts the full block list (rather than pre-filtering) so the parent
 * can stay blissfully unaware of the filter rule — everyone who touches
 * feedback uses the same "non-null, non-empty string" predicate.
 */
export function FeedbackOverlays({
  containerRef,
  blocks,
}: FeedbackOverlaysProps) {
  return (
    <>
      {blocks
        .filter((block) => block.feedback && block.feedback.length > 0)
        .map((block) => (
          <FeedbackBar
            key={block.id}
            blockId={block.id}
            feedback={block.feedback as string}
            containerRef={containerRef}
          />
        ))}
    </>
  );
}

/**
 * One feedback bar. Measures the block's position via its `[data-id]`
 * DOM marker and paints a vertical orange strip along its left edge;
 * hovering the strip opens the popover with the feedback prose.
 */
function FeedbackBar({
  blockId,
  feedback,
  containerRef,
}: {
  blockId: string;
  feedback: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [metrics, setMetrics] = useState<{
    top: number;
    height: number;
  } | null>(null);
  const [hovered, setHovered] = useState(false);

  // Measure position against the scroll container's content coordinates.
  // Recomputed on mount, on any ResizeObserver fire from the block DOM,
  // and whenever the block id / document changes. We also retry through
  // a MutationObserver because BlockNote mounts asynchronously — the
  // target node may not exist on the first effect tick right after a
  // doc remount.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const measure = () => {
      const element = container.querySelector<HTMLElement>(
        `[data-id="${cssEscape(blockId)}"]`,
      );
      if (!element) {
        return false;
      }
      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const top = elementRect.top - containerRect.top + container.scrollTop;
      setMetrics({ top, height: elementRect.height });
      return element;
    };

    const tracked = measure();
    let resizeObserver: ResizeObserver | null = null;
    if (tracked) {
      resizeObserver = new ResizeObserver(() => {
        measure();
      });
      resizeObserver.observe(tracked);
    }

    // If the block isn't in the DOM yet, watch for it to appear.
    let mutationObserver: MutationObserver | null = null;
    if (!tracked) {
      mutationObserver = new MutationObserver(() => {
        const element = measure();
        if (element && mutationObserver) {
          mutationObserver.disconnect();
          mutationObserver = null;
          resizeObserver = new ResizeObserver(() => {
            measure();
          });
          resizeObserver.observe(element);
        }
      });
      mutationObserver.observe(container, { childList: true, subtree: true });
    }

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [blockId, containerRef]);

  if (!metrics) {
    return null;
  }

  return (
    <div
      className="absolute left-0 w-1.5 cursor-help rounded-r bg-amber-400 hover:bg-amber-500"
      style={{ top: metrics.top, height: metrics.height }}
      data-testid="feedback-bar"
      data-feedback-block-id={blockId}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {hovered ? <FeedbackPopover feedback={feedback} /> : null}
    </div>
  );
}

/**
 * The hover popover. Positioned absolutely to the right of the bar so
 * long feedback has room without hitting the editor gutter. Kept inside
 * the bar element so `onMouseLeave` on the bar closes it — we don't
 * need a separate dismissal path.
 */
function FeedbackPopover({ feedback }: { feedback: string }) {
  return (
    <div
      className="absolute left-4 top-0 z-20 w-72 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950 shadow-md"
      role="tooltip"
      data-testid="feedback-popover"
    >
      <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-amber-700">
        Reviewer note
      </p>
      <p className="whitespace-pre-wrap">{feedback}</p>
    </div>
  );
}

// Defensive selector-escape mirroring the pattern in `document-workspace.tsx`.
// Block ids are UUIDs, so this is a no-op today, but formatting-sensitive
// ids would otherwise blow up the attribute selector.
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

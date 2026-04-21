// Tool definitions exposed to the AI SDK for the editorial assistant.
//
// Every tool here is a thin adapter: it binds a specific `documentId` into
// the closure, calls the document-service, and reshapes the result into the
// minimal payload the model needs to reason about its next step. The service
// layer still owns validation and conflict semantics — these functions exist
// so the model never gets raw DB shapes or serializer internals.
//
// Revision discipline is critical: the model must always read before it
// writes (via `getDocument`) and pass the latest `revision` back when
// editing. Returning `ok: false` lets the model self-correct by re-fetching,
// which keeps human/agent coexistence safe without requiring a server-side
// retry loop.

import { tool } from "ai";
import { z } from "zod";
import {
  deleteBlock,
  getDocument,
  insertBlockAfter,
  replaceBlockText,
  setBlockFeedback,
} from "@/src/server/documents/document-service";
import { createTextBlock } from "@/src/server/documents/blocknote-blocks";

/**
 * Read-only snapshot the model uses to pick the next action.
 *
 * Returns the plain-text projection (not the rich JSON) so the model can
 * reason about prose without drowning in inline-style noise, plus the
 * revision each block was observed at so subsequent edits can pass the
 * correct `expectedRevision`.
 */
export async function getDocumentTool(input: { documentId: string }) {
  const document = await getDocument(input.documentId);

  if (!document) {
    throw new Error("Document not found.");
  }

  return {
    id: document.id,
    blocks: document.blocks.map((block) => ({
      id: block.id,
      type: block.blockType,
      text: block.plainText,
      revision: block.revision,
      sortIndex: block.sortIndex,
    })),
  };
}

/**
 * Agent's primary editing verb. Returns a `{ ok, ... }` union instead of
 * throwing on conflict so the model can recover by re-reading the document
 * and retrying.
 */
export async function replaceBlockTextTool(input: {
  documentId: string;
  blockId: string;
  text: string;
  expectedRevision: number;
}) {
  const result = await replaceBlockText({
    documentId: input.documentId,
    blockId: input.blockId,
    text: input.text,
    expectedRevision: input.expectedRevision,
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      currentBlock: result.currentBlock,
    };
  }

  return {
    ok: true,
    block: {
      id: result.value.id,
      text: result.value.plainText,
      revision: result.value.revision,
    },
  };
}

/**
 * Insert a new paragraph at a given position. No `expectedRevision` because
 * inserts don't target an existing block's content — ordering races are
 * resolved by the repository's transactional sort-index shift.
 */
export async function insertBlockAfterTool(input: {
  documentId: string;
  referenceBlockId: string | null;
  text: string;
}) {
  const block = await insertBlockAfter({
    documentId: input.documentId,
    referenceBlockId: input.referenceBlockId,
    blockJson: createTextBlock(input.text),
  });

  return {
    ok: true,
    block: {
      id: block.id,
      text: block.plainText,
      revision: block.revision,
    },
  };
}

/**
 * Attach (or clear) a reviewer note on one block.
 *
 * The model uses this for any request shaped like "read the article and
 * tell me where I could tighten / cut / rework" — it writes its critique
 * next to each relevant block instead of dumping a wall of text into
 * chat. The user sees a marker beside the block and can open workshop
 * mode to address the note, at which point it is automatically cleared.
 * Passing null / empty clears the feedback in place (used rarely — the
 * user's X button is the normal clear path).
 */
export async function setBlockFeedbackTool(input: {
  documentId: string;
  blockId: string;
  feedback: string | null;
}) {
  const block = await setBlockFeedback({
    documentId: input.documentId,
    blockId: input.blockId,
    feedback: input.feedback,
  });

  if (!block) {
    return { ok: false as const, reason: "not-found" as const };
  }

  return {
    ok: true as const,
    block: {
      id: block.id,
      feedback: block.feedback,
    },
  };
}

export async function deleteBlockTool(input: {
  documentId: string;
  blockId: string;
  expectedRevision: number;
}) {
  const result = await deleteBlock({
    documentId: input.documentId,
    blockId: input.blockId,
    expectedRevision: input.expectedRevision,
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      currentBlock: result.currentBlock,
    };
  }

  return {
    ok: true,
    deletedBlockId: result.value.id,
  };
}

/**
 * Build the per-request toolset bound to a specific document.
 *
 * We construct a fresh object per chat turn so the model can't address
 * other documents by slipping an id into its tool arguments — the id is
 * closed over rather than being part of the tool's input schema. The
 * descriptions are written for the model, not for humans, so they read like
 * usage instructions (including the "always pass the latest revision" rule
 * that keeps concurrent edits safe).
 */
export function createDocumentTools(documentId: string) {
  return {
    getDocument: tool({
      description:
        "Read the current document blocks, including block IDs, text, order, and revisions.",
      inputSchema: z.object({}),
      execute: async () => getDocumentTool({ documentId }),
    }),
    replaceBlockText: tool({
      description:
        "Replace the plain text of one block. Always use the latest revision from getDocument.",
      inputSchema: z.object({
        blockId: z.string().describe("The ID of the block to edit."),
        text: z.string().describe("The exact replacement text for the block."),
        expectedRevision: z
          .number()
          .int()
          .positive()
          .describe("The latest revision observed for the block."),
      }),
      execute: async ({ blockId, text, expectedRevision }) =>
        replaceBlockTextTool({
          documentId,
          blockId,
          text,
          expectedRevision,
        }),
    }),
    insertBlockAfter: tool({
      description:
        "Insert a new paragraph block after the given block. Use null to insert at the top.",
      inputSchema: z.object({
        referenceBlockId: z
          .string()
          .nullable()
          .describe("The block ID to insert after, or null for the top."),
        text: z.string().describe("The text for the new paragraph block."),
      }),
      execute: async ({ referenceBlockId, text }) =>
        insertBlockAfterTool({
          documentId,
          referenceBlockId,
          text,
        }),
    }),
    deleteBlock: tool({
      description:
        "Delete one block. Always use the latest revision from getDocument.",
      inputSchema: z.object({
        blockId: z.string().describe("The ID of the block to delete."),
        expectedRevision: z
          .number()
          .int()
          .positive()
          .describe("The latest revision observed for the block."),
      }),
      execute: async ({ blockId, expectedRevision }) =>
        deleteBlockTool({
          documentId,
          blockId,
          expectedRevision,
        }),
    }),
    setBlockFeedback: tool({
      description: [
        "Attach a short reviewer note to a single block without editing its content.",
        "This is the right tool — not a chat reply — any time the user asks for",
        "feedback, critique, review, comments, suggestions, or for you to find",
        "opportunities to tighten, shorten, cut, sharpen, or rework parts of the",
        "article. Call it once per block that needs attention; skip blocks that",
        "are already fine. Feedback is open-ended prose directed at the writer",
        '("this paragraph repeats the previous one", "these six questions in a',
        'row are exhausting", "this could lose half its length") — not a',
        "proposed rewrite. When the user opens workshop mode on a block that has",
        "feedback, the note is injected as the workshop assistant's opening",
        "message, so write it the way you would address the writer directly.",
        "Pass null or an empty string to clear an existing note; generally prefer",
        "leaving clears to the user.",
      ].join(" "),
      inputSchema: z.object({
        blockId: z.string().describe("The ID of the block to annotate."),
        feedback: z
          .string()
          .nullable()
          .describe(
            "Freeform feedback addressed to the writer; null or empty to clear.",
          ),
      }),
      execute: async ({ blockId, feedback }) =>
        setBlockFeedbackTool({
          documentId,
          blockId,
          feedback,
        }),
    }),
  };
}

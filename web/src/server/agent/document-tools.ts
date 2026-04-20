import { tool } from "ai";
import { z } from "zod";
import {
  deleteBlock,
  getDocument,
  insertBlockAfter,
  replaceBlockText,
} from "@/src/server/documents/document-service";
import { createTextBlock } from "@/src/server/documents/blocknote-blocks";

export async function getDocumentTool(input: { documentId: string }) {
  const document = await getDocument(input.documentId);

  if (!document) {
    throw new Error("Document not found.");
  }

  return {
    id: document.id,
    title: document.title,
    blocks: document.blocks.map((block) => ({
      id: block.id,
      type: block.blockType,
      text: block.plainText,
      revision: block.revision,
      sortIndex: block.sortIndex,
    })),
  };
}

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
    source: "agent",
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

export async function insertBlockAfterTool(input: {
  documentId: string;
  referenceBlockId: string | null;
  text: string;
}) {
  const block = await insertBlockAfter({
    documentId: input.documentId,
    referenceBlockId: input.referenceBlockId,
    blockJson: createTextBlock(input.text),
    source: "agent",
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

export async function deleteBlockTool(input: {
  documentId: string;
  blockId: string;
  expectedRevision: number;
}) {
  const result = await deleteBlock({
    documentId: input.documentId,
    blockId: input.blockId,
    expectedRevision: input.expectedRevision,
    source: "agent",
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
  };
}

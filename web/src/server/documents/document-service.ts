// Application-level document operations.
//
// This is the layer the HTTP routes and the agent tools go through. It sits
// between inbound JSON (which we don't trust) and the repository (which
// assumes pre-validated inputs). The responsibilities are:
//
//   - run every incoming block through `normalizeBlock` so we fail fast on
//     malformed payloads and never pass raw user data to SQL
//   - keep the `plain_text` projection in sync with `block_json` on every
//     write, since the repository doesn't derive one from the other
//   - turn repository-level "returned null" conflict signals into the
//     explicit `MutationResult<T>` union that callers can branch on
//   - expose a single entry point per logical operation so routes and agent
//     tools share identical semantics

import {
  blockToPlainText,
  createTextBlock,
  normalizeBlock,
  replaceBlockText as replaceBlockTextJson,
} from "./blocknote-blocks";
import {
  appendBlockRecord,
  createDocumentRecord,
  deleteBlockRecord,
  deleteDocumentRecord,
  getBlockRecord,
  getDocumentRecord,
  getOrCreatePrimaryDocumentRecord,
  insertBlockAfterRecord,
  listBlockRecords,
  syncDocumentBlockRecords,
  updateBlockOrder,
  updateBlockRecord,
} from "./document-repository";
import {
  BlockNoteBlock,
  DocumentBlockRecord,
  DocumentWithBlocks,
  MutationResult,
  MutationSource,
  SupportedBlockType,
} from "./types";

export async function createDocument(input: {
  testRunId?: string | null;
}): Promise<DocumentWithBlocks> {
  const document = await createDocumentRecord({
    testRunId: input.testRunId ?? null,
  });

  return {
    ...document,
    blocks: [],
  };
}

export async function getDocument(
  documentId: string,
): Promise<DocumentWithBlocks | null> {
  const document = await getDocumentRecord(documentId);

  if (!document) {
    return null;
  }

  return {
    ...document,
    blocks: await listBlockRecords(documentId),
  };
}

/**
 * Resolve the singleton primary document used by the homepage.
 *
 * See `getOrCreatePrimaryDocumentRecord` for why we guarantee a single row
 * instead of building a full document-list UI.
 */
export async function getOrCreatePrimaryDocument(): Promise<DocumentWithBlocks> {
  const document = await getOrCreatePrimaryDocumentRecord();

  return {
    ...document,
    blocks: await listBlockRecords(document.id),
  };
}

export async function deleteDocument(documentId: string): Promise<void> {
  await deleteDocumentRecord(documentId);
}

/**
 * Convenience wrapper for the common "add a paragraph of plain text" case.
 *
 * Kept separate from `appendBlock` so agent-authored inserts can stick to a
 * string API without fabricating a BlockNote JSON payload themselves.
 */
export async function appendTextBlock(input: {
  documentId: string;
  text: string;
  type?: SupportedBlockType;
  source?: MutationSource;
}): Promise<DocumentBlockRecord> {
  return appendBlock({
    documentId: input.documentId,
    blockJson: createTextBlock(input.text, input.type),
    source: input.source,
  });
}

export async function appendBlock(input: {
  documentId: string;
  blockJson: unknown;
  source?: MutationSource;
}): Promise<DocumentBlockRecord> {
  const block = prepareBlock(input.blockJson);

  return appendBlockRecord({
    documentId: input.documentId,
    block,
  });
}

export async function insertBlockAfter(input: {
  documentId: string;
  referenceBlockId: string | null;
  blockJson: unknown;
  source?: MutationSource;
}): Promise<DocumentBlockRecord> {
  const block = prepareBlock(input.blockJson);

  return insertBlockAfterRecord({
    documentId: input.documentId,
    referenceBlockId: input.referenceBlockId,
    block,
  });
}

/**
 * Replace a block's contents with a plain-text string. This is the agent's
 * primary editing verb — it intentionally strips any inline styling on the
 * block because the agent reasons about blocks as plain text and we don't
 * want it to inadvertently preserve marks it can't see.
 *
 * Fails with a conflict if the block is gone, moved to a different
 * document, or its revision doesn't match.
 */
export async function replaceBlockText(input: {
  documentId: string;
  blockId: string;
  text: string;
  expectedRevision: number;
  source?: MutationSource;
}): Promise<MutationResult<DocumentBlockRecord>> {
  const currentBlock = await getBlockRecord(input.blockId);

  if (!currentBlock || currentBlock.documentId !== input.documentId) {
    return {
      ok: false,
      reason: "conflict",
      currentBlock: null,
    };
  }

  const blockJson = replaceBlockTextJson(currentBlock.blockJson, input.text);
  return replaceBlock({
    documentId: input.documentId,
    blockId: input.blockId,
    blockJson,
    expectedRevision: input.expectedRevision,
    source: input.source,
  });
}

/**
 * Full-block replacement path used by the editor's PATCH endpoint. The
 * `blockId` from the URL wins over any id in the payload (see `prepareBlock`
 * -> `normalizeBlock`) so a client can't rename a block via an update.
 */
export async function replaceBlock(input: {
  documentId: string;
  blockId: string;
  blockJson: unknown;
  expectedRevision: number;
  source?: MutationSource;
}): Promise<MutationResult<DocumentBlockRecord>> {
  const block = prepareBlock(input.blockJson, input.blockId);
  const updatedBlock = await updateBlockRecord({
    documentId: input.documentId,
    blockId: input.blockId,
    expectedRevision: input.expectedRevision,
    block,
  });

  if (!updatedBlock) {
    return {
      ok: false,
      reason: "conflict",
      currentBlock: await getBlockRecord(input.blockId),
    };
  }

  return {
    ok: true,
    value: updatedBlock,
  };
}

export async function deleteBlock(input: {
  documentId: string;
  blockId: string;
  expectedRevision: number;
  source?: MutationSource;
}): Promise<MutationResult<DocumentBlockRecord>> {
  const deletedBlock = await deleteBlockRecord({
    documentId: input.documentId,
    blockId: input.blockId,
    expectedRevision: input.expectedRevision,
  });

  if (!deletedBlock) {
    return {
      ok: false,
      reason: "conflict",
      currentBlock: await getBlockRecord(input.blockId),
    };
  }

  return {
    ok: true,
    value: deletedBlock,
  };
}

/**
 * Reorder: move a single block to a new position.
 *
 * `expectedRevision` is optional here because reordering doesn't change
 * block content. The caller may still pass one when they want to guard
 * against moving a block that's been concurrently edited.
 *
 * We do the reordering in-memory first (array splice), then hand a full
 * ordered id list to the repository so it can commit one consistent order
 * — the repository's two-phase write is what actually makes this safe.
 */
export async function moveBlock(input: {
  documentId: string;
  blockId: string;
  afterBlockId: string | null;
  expectedRevision?: number;
  source?: MutationSource;
}): Promise<MutationResult<DocumentBlockRecord[]>> {
  const currentBlocks = await listBlockRecords(input.documentId);
  const movedBlock = currentBlocks.find((block) => block.id === input.blockId);

  if (
    !movedBlock ||
    (input.expectedRevision !== undefined &&
      movedBlock.revision !== input.expectedRevision)
  ) {
    return {
      ok: false,
      reason: "conflict",
      currentBlock: await getBlockRecord(input.blockId),
    };
  }

  const remainingBlocks = currentBlocks.filter(
    (block) => block.id !== input.blockId,
  );

  const insertIndex =
    input.afterBlockId === null
      ? 0
      : remainingBlocks.findIndex((block) => block.id === input.afterBlockId) +
        1;

  if (input.afterBlockId !== null && insertIndex === 0) {
    throw new Error("Reference block not found.");
  }

  const nextBlocks = [...remainingBlocks];
  nextBlocks.splice(insertIndex, 0, movedBlock);

  return {
    ok: true,
    value: await updateBlockOrder({
      documentId: input.documentId,
      orderedBlockIds: nextBlocks.map((block) => block.id),
    }),
  };
}

/**
 * Whole-document save used by the editor's debounced autosave loop.
 *
 * The client submits the full current block list plus the revisions it
 * thought it was editing on top of. The repository's sync routine is what
 * enforces per-block optimistic concurrency; this function just handles
 * input normalization and conflict shaping.
 */
export async function syncDocumentBlocks(input: {
  documentId: string;
  blocks: unknown[];
  expectedRevisions: Record<string, number | undefined>;
  source?: MutationSource;
}): Promise<MutationResult<DocumentBlockRecord[]>> {
  const blocks = input.blocks.map((block) => prepareBlock(block));
  const result = await syncDocumentBlockRecords({
    documentId: input.documentId,
    blocks,
    expectedRevisions: input.expectedRevisions,
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: "conflict",
      currentBlock: result.conflict.currentBlock,
    };
  }

  return {
    ok: true,
    value: result.blocks,
  };
}

// Shared normalization step for every write path: validates the block shape
// and attaches an up-to-date plain-text projection. Centralized so the rules
// can't diverge between the REST surface and the agent tools.
function prepareBlock(blockJson: unknown, forcedId?: string) {
  const block = normalizeBlock(blockJson, forcedId);

  return {
    blockJson: block,
    plainText: blockToPlainText(block),
  };
}

/**
 * Project stored blocks into the shape the BlockNote editor expects.
 *
 * Trivial today because our persisted JSON matches the editor's format
 * verbatim, but keeping the function around gives us a single place to add
 * a migration/shim if the editor schema ever drifts.
 */
export function documentBlocksToEditorBlocks(
  blocks: DocumentBlockRecord[],
): BlockNoteBlock[] {
  return blocks.map((block) => block.blockJson);
}

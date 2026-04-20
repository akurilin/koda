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
  insertBlockAfterRecord,
  listBlockRecords,
  syncTopLevelBlockRecords,
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
  title?: string;
  testRunId?: string | null;
}): Promise<DocumentWithBlocks> {
  const document = await createDocumentRecord({
    title: input.title ?? "",
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

export async function deleteDocument(documentId: string): Promise<void> {
  await deleteDocumentRecord(documentId);
}

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

export async function syncDocumentBlocks(input: {
  documentId: string;
  blocks: unknown[];
  expectedRevisions: Record<string, number | undefined>;
  source?: MutationSource;
}): Promise<MutationResult<DocumentBlockRecord[]>> {
  const blocks = input.blocks.map((block) => prepareBlock(block));
  const result = await syncTopLevelBlockRecords({
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

function prepareBlock(blockJson: unknown, forcedId?: string) {
  const block = normalizeBlock(blockJson, forcedId);

  return {
    blockJson: block,
    plainText: blockToPlainText(block),
  };
}

export function documentBlocksToEditorBlocks(
  blocks: DocumentBlockRecord[],
): BlockNoteBlock[] {
  return blocks.map((block) => block.blockJson);
}

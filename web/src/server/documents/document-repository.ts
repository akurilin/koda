import { sql } from "@/src/server/db/postgres";
import {
  BlockNoteBlock,
  DocumentBlockRecord,
  DocumentRecord,
  SupportedBlockType,
} from "./types";

type RawDocumentRow = {
  id: string;
  title: string;
  test_run_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type RawBlockRow = {
  id: string;
  document_id: string;
  parent_block_id: string | null;
  sort_index: number;
  block_type: SupportedBlockType;
  content_format: "blocknote_v1";
  block_json: BlockNoteBlock;
  plain_text: string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

export type PersistedBlockInput = {
  blockJson: BlockNoteBlock;
  plainText: string;
};

export type SyncConflict = {
  blockId: string;
  currentBlock: DocumentBlockRecord | null;
};

export async function createDocumentRecord(input: {
  title: string;
  testRunId?: string | null;
}): Promise<DocumentRecord> {
  const [row] = await sql<RawDocumentRow[]>`
    INSERT INTO documents (title, test_run_id)
    VALUES (${input.title}, ${input.testRunId ?? null})
    RETURNING *
  `;

  return mapDocumentRow(row);
}

export async function getDocumentRecord(
  documentId: string,
): Promise<DocumentRecord | null> {
  const [row] = await sql<RawDocumentRow[]>`
    SELECT *
    FROM documents
    WHERE id = ${documentId}
  `;

  return row ? mapDocumentRow(row) : null;
}

export async function deleteDocumentRecord(documentId: string): Promise<void> {
  await sql`
    DELETE FROM documents
    WHERE id = ${documentId}
  `;
}

export async function listBlockRecords(
  documentId: string,
): Promise<DocumentBlockRecord[]> {
  const rows = await sql<RawBlockRow[]>`
    SELECT *
    FROM document_blocks
    WHERE document_id = ${documentId}
      AND parent_block_id IS NULL
    ORDER BY sort_index ASC
  `;

  return rows.map(mapBlockRow);
}

export async function getBlockRecord(
  blockId: string,
): Promise<DocumentBlockRecord | null> {
  const [row] = await sql<RawBlockRow[]>`
    SELECT *
    FROM document_blocks
    WHERE id = ${blockId}
  `;

  return row ? mapBlockRow(row) : null;
}

export async function appendBlockRecord(input: {
  documentId: string;
  block: PersistedBlockInput;
}): Promise<DocumentBlockRecord> {
  return sql.begin(async (tx) => {
    const [{ next_sort_index }] = await tx<{ next_sort_index: number }[]>`
      SELECT COALESCE(MAX(sort_index) + 1, 0) AS next_sort_index
      FROM document_blocks
      WHERE document_id = ${input.documentId}
        AND parent_block_id IS NULL
    `;

    const [row] = await tx<RawBlockRow[]>`
      INSERT INTO document_blocks (
        id,
        document_id,
        sort_index,
        block_type,
        block_json,
        plain_text
      )
      VALUES (
        ${input.block.blockJson.id},
        ${input.documentId},
        ${next_sort_index},
        ${input.block.blockJson.type},
        ${tx.json(asJson(input.block.blockJson))},
        ${input.block.plainText}
      )
      RETURNING *
    `;

    return mapBlockRow(row);
  });
}

export async function insertBlockAfterRecord(input: {
  documentId: string;
  referenceBlockId: string | null;
  block: PersistedBlockInput;
}): Promise<DocumentBlockRecord> {
  return sql.begin(async (tx) => {
    let sortIndex = 0;
    if (input.referenceBlockId !== null) {
      const [referenceBlock] = await tx<{ sort_index: number }[]>`
        SELECT sort_index
        FROM document_blocks
        WHERE id = ${input.referenceBlockId}
          AND document_id = ${input.documentId}
      `;

      if (!referenceBlock) {
        throw new Error("Reference block not found.");
      }

      sortIndex = referenceBlock.sort_index + 1;
    }

    await tx`
      UPDATE document_blocks
      SET sort_index = sort_index + 1
      WHERE document_id = ${input.documentId}
        AND parent_block_id IS NULL
        AND sort_index >= ${sortIndex}
    `;

    const [row] = await tx<RawBlockRow[]>`
      INSERT INTO document_blocks (
        id,
        document_id,
        sort_index,
        block_type,
        block_json,
        plain_text
      )
      VALUES (
        ${input.block.blockJson.id},
        ${input.documentId},
        ${sortIndex},
        ${input.block.blockJson.type},
        ${tx.json(asJson(input.block.blockJson))},
        ${input.block.plainText}
      )
      RETURNING *
    `;

    return mapBlockRow(row);
  });
}

export async function updateBlockRecord(input: {
  documentId: string;
  blockId: string;
  expectedRevision: number;
  block: PersistedBlockInput;
}): Promise<DocumentBlockRecord | null> {
  const [row] = await sql<RawBlockRow[]>`
    UPDATE document_blocks
    SET
      block_type = ${input.block.blockJson.type},
      block_json = ${sql.json(asJson(input.block.blockJson))},
      plain_text = ${input.block.plainText},
      revision = revision + 1
    WHERE id = ${input.blockId}
      AND document_id = ${input.documentId}
      AND revision = ${input.expectedRevision}
    RETURNING *
  `;

  return row ? mapBlockRow(row) : null;
}

export async function deleteBlockRecord(input: {
  documentId: string;
  blockId: string;
  expectedRevision: number;
}): Promise<DocumentBlockRecord | null> {
  return sql.begin(async (tx) => {
    const [deleted] = await tx<RawBlockRow[]>`
      DELETE FROM document_blocks
      WHERE id = ${input.blockId}
        AND document_id = ${input.documentId}
        AND revision = ${input.expectedRevision}
      RETURNING *
    `;

    if (!deleted) {
      return null;
    }

    await tx`
      UPDATE document_blocks
      SET sort_index = sort_index - 1
      WHERE document_id = ${input.documentId}
        AND parent_block_id IS NULL
        AND sort_index > ${deleted.sort_index}
    `;

    return mapBlockRow(deleted);
  });
}

export async function updateBlockOrder(input: {
  documentId: string;
  orderedBlockIds: string[];
}): Promise<DocumentBlockRecord[]> {
  return sql.begin(async (tx) => {
    for (const [index, blockId] of input.orderedBlockIds.entries()) {
      await tx`
        UPDATE document_blocks
        SET sort_index = ${temporarySortIndex(index)}
        WHERE id = ${blockId}
          AND document_id = ${input.documentId}
      `;
    }

    for (const [index, blockId] of input.orderedBlockIds.entries()) {
      await tx`
        UPDATE document_blocks
        SET sort_index = ${index}
        WHERE id = ${blockId}
          AND document_id = ${input.documentId}
      `;
    }

    const rows = await tx<RawBlockRow[]>`
      SELECT *
      FROM document_blocks
      WHERE document_id = ${input.documentId}
        AND parent_block_id IS NULL
      ORDER BY sort_index ASC
    `;

    return rows.map(mapBlockRow);
  });
}

export async function syncTopLevelBlockRecords(input: {
  documentId: string;
  blocks: PersistedBlockInput[];
  expectedRevisions: Record<string, number | undefined>;
}): Promise<
  | { ok: true; blocks: DocumentBlockRecord[] }
  | { ok: false; conflict: SyncConflict }
> {
  return sql.begin(async (tx) => {
    const existingRows = await tx<RawBlockRow[]>`
      SELECT *
      FROM document_blocks
      WHERE document_id = ${input.documentId}
        AND parent_block_id IS NULL
      ORDER BY sort_index ASC
      FOR UPDATE
    `;
    const existingBlocks = existingRows.map(mapBlockRow);
    const existingById = new Map(
      existingBlocks.map((block) => [block.id, block]),
    );
    const submittedIds = new Set(
      input.blocks.map((block) => block.blockJson.id),
    );

    for (const currentBlock of existingBlocks) {
      if (!submittedIds.has(currentBlock.id)) {
        const expectedRevision = input.expectedRevisions[currentBlock.id];

        if (expectedRevision !== currentBlock.revision) {
          return {
            ok: false,
            conflict: {
              blockId: currentBlock.id,
              currentBlock,
            },
          };
        }
      }
    }

    for (const block of input.blocks) {
      const currentBlock = existingById.get(block.blockJson.id);

      if (!currentBlock) {
        continue;
      }

      const expectedRevision = input.expectedRevisions[currentBlock.id];
      if (expectedRevision !== currentBlock.revision) {
        return {
          ok: false,
          conflict: {
            blockId: currentBlock.id,
            currentBlock,
          },
        };
      }
    }

    for (const [index, block] of existingBlocks.entries()) {
      await tx`
        UPDATE document_blocks
        SET sort_index = ${temporarySortIndex(index)}
        WHERE id = ${block.id}
      `;
    }

    for (const currentBlock of existingBlocks) {
      if (!submittedIds.has(currentBlock.id)) {
        await tx`
          DELETE FROM document_blocks
          WHERE id = ${currentBlock.id}
        `;
      }
    }

    for (const [index, block] of input.blocks.entries()) {
      const currentBlock = existingById.get(block.blockJson.id);

      if (!currentBlock) {
        await tx`
          INSERT INTO document_blocks (
            id,
            document_id,
            sort_index,
            block_type,
            block_json,
            plain_text
          )
          VALUES (
            ${block.blockJson.id},
            ${input.documentId},
            ${index},
            ${block.blockJson.type},
            ${tx.json(asJson(block.blockJson))},
            ${block.plainText}
          )
        `;
        continue;
      }

      const blockChanged =
        JSON.stringify(currentBlock.blockJson) !==
        JSON.stringify(block.blockJson);

      await tx`
        UPDATE document_blocks
        SET
          sort_index = ${index},
          block_type = ${block.blockJson.type},
          block_json = ${tx.json(asJson(block.blockJson))},
          plain_text = ${block.plainText},
          revision = CASE
            WHEN ${blockChanged} THEN revision + 1
            ELSE revision
          END
        WHERE id = ${block.blockJson.id}
      `;
    }

    const rows = await tx<RawBlockRow[]>`
      SELECT *
      FROM document_blocks
      WHERE document_id = ${input.documentId}
        AND parent_block_id IS NULL
      ORDER BY sort_index ASC
    `;

    return {
      ok: true,
      blocks: rows.map(mapBlockRow),
    };
  });
}

function mapDocumentRow(row: RawDocumentRow): DocumentRecord {
  return {
    id: row.id,
    title: row.title,
    testRunId: row.test_run_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapBlockRow(row: RawBlockRow): DocumentBlockRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    parentBlockId: row.parent_block_id,
    sortIndex: row.sort_index,
    blockType: row.block_type,
    contentFormat: row.content_format,
    blockJson: row.block_json,
    plainText: row.plain_text,
    revision: row.revision,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function temporarySortIndex(index: number): number {
  return 1_000_000 + index;
}

function asJson(value: unknown): Parameters<typeof sql.json>[0] {
  return value as Parameters<typeof sql.json>[0];
}

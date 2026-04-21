// Thin persistence layer for documents and blocks.
//
// Everything in this file is "row in / row out" — it owns the SQL, nothing
// else does. Higher-level invariants (source tagging, input normalization,
// conflict shaping) live in document-service.ts. Keeping SQL isolated here
// means the rest of the codebase can remain database-agnostic and lets us
// audit all queries in one place.

import { sql } from "@/src/server/db/postgres";
import {
  BlockNoteBlock,
  DocumentBlockRecord,
  DocumentRecord,
  SupportedBlockType,
} from "./types";

// Mirror of the `documents` table column names, used only for mapping.
type RawDocumentRow = {
  id: string;
  test_run_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

// Mirror of the `document_blocks` table column names, used only for mapping.
type RawBlockRow = {
  id: string;
  document_id: string;
  sort_index: number;
  block_type: SupportedBlockType;
  content_format: "blocknote_v1";
  block_json: BlockNoteBlock;
  plain_text: string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

/**
 * Pre-normalized payload the repository needs to write a block.
 *
 * Service-layer callers are responsible for producing both the JSON and its
 * plain-text projection so that they stay in sync; the repository never
 * derives one from the other.
 */
export type PersistedBlockInput = {
  blockJson: BlockNoteBlock;
  plainText: string;
};

/**
 * Surfaced by the sync path when a submitted block's revision doesn't match
 * the current row. Callers use it to tell the editor exactly which block
 * diverged.
 */
export type SyncConflict = {
  blockId: string;
  currentBlock: DocumentBlockRecord | null;
};

export async function createDocumentRecord(input: {
  testRunId?: string | null;
}): Promise<DocumentRecord> {
  const [row] = await sql<RawDocumentRow[]>`
    INSERT INTO documents (test_run_id)
    VALUES (${input.testRunId ?? null})
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

/**
 * Fetch-or-create the singleton primary document (the one backing the
 * homepage).
 *
 * The app treats the "real" user document as a single row with a null
 * `test_run_id`; test runs use their own rows tagged with an id. The
 * advisory lock serializes concurrent first-render requests so we don't race
 * and create two primary rows — the race window is tiny but real under cold
 * start, and a duplicated primary document is far worse than a few ms of
 * contention.
 */
export async function getOrCreatePrimaryDocumentRecord(): Promise<DocumentRecord> {
  return sql.begin(async (tx) => {
    await tx`
      SELECT pg_advisory_xact_lock(hashtext('documents_primary_singleton'))
    `;

    const [existing] = await tx<RawDocumentRow[]>`
      SELECT *
      FROM documents
      WHERE test_run_id IS NULL
      ORDER BY created_at ASC
      LIMIT 1
    `;

    if (existing) {
      return mapDocumentRow(existing);
    }

    const [created] = await tx<RawDocumentRow[]>`
      INSERT INTO documents (test_run_id)
      VALUES (NULL)
      RETURNING *
    `;

    return mapDocumentRow(created);
  });
}

export async function deleteDocumentRecord(documentId: string): Promise<void> {
  await sql`
    DELETE FROM documents
    WHERE id = ${documentId}
  `;
}

/**
 * Load the blocks of a document in authoring order.
 */
export async function listBlockRecords(
  documentId: string,
): Promise<DocumentBlockRecord[]> {
  const rows = await sql<RawBlockRow[]>`
    SELECT *
    FROM document_blocks
    WHERE document_id = ${documentId}
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

/**
 * Add a block at the end of the document.
 *
 * Wrapped in a transaction because the `MAX(sort_index) + 1` read-then-write
 * would otherwise race with a concurrent append and assign the same index to
 * two blocks.
 */
export async function appendBlockRecord(input: {
  documentId: string;
  block: PersistedBlockInput;
}): Promise<DocumentBlockRecord> {
  return sql.begin(async (tx) => {
    const [{ next_sort_index }] = await tx<{ next_sort_index: number }[]>`
      SELECT COALESCE(MAX(sort_index) + 1, 0) AS next_sort_index
      FROM document_blocks
      WHERE document_id = ${input.documentId}
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

/**
 * Insert a block immediately after a given reference (or at the very top
 * when `referenceBlockId` is null).
 *
 * We shift the sort indices of everything below the insertion point by one
 * in a single UPDATE, which is fine because the block ordering column has a
 * deferred uniqueness constraint — otherwise we'd need the two-pass
 * temporary-index dance used by `updateBlockOrder`.
 */
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

/**
 * Optimistic update.
 *
 * Returns `null` if `expectedRevision` no longer matches — the caller is
 * expected to turn that into a `ConflictResult` so the client can reconcile.
 * The `revision` column is incremented here so readers can tell they saw a
 * stale copy.
 */
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

/**
 * Optimistic delete. Also compacts the sort indices of everything after the
 * deleted block so that indices stay contiguous — the editor and the agent
 * both rely on "index is the authoring position, with no gaps".
 */
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
        AND sort_index > ${deleted.sort_index}
    `;

    return mapBlockRow(deleted);
  });
}

/**
 * Apply a new ordering to the blocks of a document.
 *
 * The two-pass write is deliberate: `document_blocks(document_id, sort_index)`
 * is unique, so we first shove every row into a temporary index range
 * (`temporarySortIndex`) to avoid transient duplicates, then write the final
 * indices. Doing this as a single UPDATE would hit the unique constraint
 * mid-flight.
 */
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
      ORDER BY sort_index ASC
    `;

    return rows.map(mapBlockRow);
  });
}

/**
 * Reconcile a document's blocks with a full set submitted by the editor.
 *
 * This is the hot path for the client's debounced "save everything" flow:
 * the editor sends the entire current state plus the revisions it believed
 * it was editing on top of. We:
 *
 *   1. SELECT ... FOR UPDATE so nobody else can mutate the same document
 *      while we compare.
 *   2. Fail fast with a conflict if any block the client knew about has
 *      been changed out from under them (either by another tab or by the
 *      agent).
 *   3. Otherwise delete blocks the client no longer has, insert new ones,
 *      update changed ones, and reindex everything to match the submitted
 *      order.
 *
 * The block-level revision check is what lets a human edit and an agent
 * edit coexist without clobbering each other — see `document-service.ts`
 * for the higher-level contract.
 */
export async function syncDocumentBlockRecords(input: {
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

    // Deletions: a block the client dropped is only safe to drop if they
    // were editing on top of the revision that still exists in the DB.
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

    // Updates: same revision check for blocks that survived the client's
    // submission, so we don't overwrite a fresher agent edit.
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

    // Park existing rows in the temporary-index range so the final write
    // phase can freely reuse low indices without tripping the unique
    // constraint (same trick as `updateBlockOrder`).
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

      // Only bump `revision` if the JSON actually changed — reordering
      // without edits shouldn't invalidate any concurrent agent's view of
      // the block's content.
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
      ORDER BY sort_index ASC
    `;

    return {
      ok: true,
      blocks: rows.map(mapBlockRow),
    };
  });
}

// Snake-case row -> camelCase domain mapping. Isolated so the rest of the
// code never has to know what the underlying columns are named.
function mapDocumentRow(row: RawDocumentRow): DocumentRecord {
  return {
    id: row.id,
    testRunId: row.test_run_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapBlockRow(row: RawBlockRow): DocumentBlockRecord {
  return {
    id: row.id,
    documentId: row.document_id,
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

// postgres.js returns timestamps as Date when type-aware, as strings
// otherwise. Normalize both to ISO strings at the boundary.
function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

// Sort indices used only while a reorder is mid-flight. Picked well above any
// plausible real index so the two write phases can coexist without collisions.
function temporarySortIndex(index: number): number {
  return 1_000_000 + index;
}

// postgres.js's `sql.json` helper expects a JSON-serializable value; the
// compiler otherwise complains about unknown shapes. This is the single
// place we accept that type fudge.
function asJson(value: unknown): Parameters<typeof sql.json>[0] {
  return value as Parameters<typeof sql.json>[0];
}

// Shared domain primitives for the document model.
//
// BlockNote is the source-of-truth schema for rendered blocks, but we keep our
// own narrowed type definitions here so that server code doesn't depend on the
// editor package and so we can constrain which block shapes the backend will
// accept from untrusted JSON payloads.

/**
 * The block types the backend is willing to persist.
 *
 * Keeping this set small and explicit is deliberate: BlockNote allows arbitrary
 * custom blocks, but every extra type we admit widens our validation surface
 * and migration burden. Add to this list only after confirming the editor
 * emits the shape we expect and the DB storage format can round-trip it.
 */
export const supportedBlockTypes = [
  "paragraph",
  "heading",
  "quote",
  "codeBlock",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
] as const;

export type SupportedBlockType = (typeof supportedBlockTypes)[number];

/** A plain run of styled text within a block (BlockNote inline content). */
export type InlineText = {
  type: "text";
  text: string;
  styles?: Record<string, unknown>;
};

/** An inline hyperlink wrapping further inline content (BlockNote inline content). */
export type InlineLink = {
  type: "link";
  href: string;
  content: InlineContent[];
};

export type InlineContent = InlineText | InlineLink;

/**
 * The canonical JSON shape stored alongside each block row.
 *
 * We persist the full BlockNote JSON so the editor can be re-hydrated without
 * a lossy transform, while `plain_text` in the row acts as a searchable /
 * agent-facing projection of the same content.
 */
export type BlockNoteBlock = {
  id: string;
  type: SupportedBlockType;
  props: Record<string, unknown>;
  content?: string | InlineContent[];
  children: BlockNoteBlock[];
};

/**
 * Row-level metadata for a document.
 *
 * `testRunId` partitions e2e/integration fixtures from the real user document.
 * The primary document is the singleton row with `testRunId === null`; see
 * `getOrCreatePrimaryDocumentRecord` in the repository for why that shape.
 */
export type DocumentRecord = {
  id: string;
  testRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * One stored block, with the bookkeeping we need for optimistic concurrency.
 *
 * `revision` is bumped on every content-changing update and is the basis of
 * the conflict checks surfaced through the mutation API. `sortIndex` orders
 * siblings within the same `parentBlockId` level.
 */
export type DocumentBlockRecord = {
  id: string;
  documentId: string;
  parentBlockId: string | null;
  sortIndex: number;
  blockType: SupportedBlockType;
  contentFormat: "blocknote_v1";
  blockJson: BlockNoteBlock;
  plainText: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentWithBlocks = DocumentRecord & {
  blocks: DocumentBlockRecord[];
};

/**
 * Origin of a mutation, so we can later distinguish user edits from agent
 * edits in logs or audit trails without coupling the service layer to a
 * transport-specific concept.
 */
export type MutationSource = "user" | "agent" | "test";

/**
 * Returned when optimistic concurrency fails.
 *
 * `currentBlock` is the freshest row we could read (or null if the block is
 * gone). Callers are expected to reconcile their state before retrying.
 */
export type ConflictResult = {
  ok: false;
  reason: "conflict";
  currentBlock: DocumentBlockRecord | null;
};

export type SuccessResult<T> = {
  ok: true;
  value: T;
};

/**
 * Every write on the document surface returns this union so that callers
 * handle conflicts with an explicit branch rather than an exception.
 */
export type MutationResult<T> = SuccessResult<T> | ConflictResult;

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

export type InlineText = {
  type: "text";
  text: string;
  styles?: Record<string, unknown>;
};

export type InlineLink = {
  type: "link";
  href: string;
  content: InlineContent[];
};

export type InlineContent = InlineText | InlineLink;

export type BlockNoteBlock = {
  id: string;
  type: SupportedBlockType;
  props: Record<string, unknown>;
  content?: string | InlineContent[];
  children: BlockNoteBlock[];
};

export type DocumentRecord = {
  id: string;
  title: string;
  testRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

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

export type MutationSource = "user" | "agent" | "test";

export type ConflictResult = {
  ok: false;
  reason: "conflict";
  currentBlock: DocumentBlockRecord | null;
};

export type SuccessResult<T> = {
  ok: true;
  value: T;
};

export type MutationResult<T> = SuccessResult<T> | ConflictResult;

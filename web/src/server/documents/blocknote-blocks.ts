import { randomUUID } from "node:crypto";
import {
  BlockNoteBlock,
  InlineContent,
  SupportedBlockType,
  supportedBlockTypes,
} from "./types";

const supportedBlockTypeSet = new Set<string>(supportedBlockTypes);

export function isSupportedBlockType(type: string): type is SupportedBlockType {
  return supportedBlockTypeSet.has(type);
}

export function createTextBlock(
  text: string,
  type: SupportedBlockType = "paragraph",
  id = randomUUID(),
): BlockNoteBlock {
  return {
    id,
    type,
    props: {},
    content: text ? [{ type: "text", text, styles: {} }] : [],
    children: [],
  };
}

export function replaceBlockText(
  block: BlockNoteBlock,
  text: string,
): BlockNoteBlock {
  return {
    ...block,
    content: text ? [{ type: "text", text, styles: {} }] : [],
  };
}

export function blockToPlainText(block: BlockNoteBlock): string {
  const ownText = inlineContentToPlainText(block.content);
  const childText = block.children
    .map((child) => blockToPlainText(child))
    .filter(Boolean)
    .join("\n");

  return [ownText, childText].filter(Boolean).join("\n");
}

export function normalizeBlock(
  value: unknown,
  forcedId?: string,
): BlockNoteBlock {
  if (!isRecord(value)) {
    throw new Error("Block must be an object.");
  }

  const id = forcedId ?? value.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Block must have a non-empty string id.");
  }

  const type = value.type;
  if (typeof type !== "string" || !isSupportedBlockType(type)) {
    throw new Error(`Unsupported block type: ${String(type)}`);
  }

  const props = isRecord(value.props) ? value.props : {};
  const content = normalizeInlineContent(value.content);
  const children = Array.isArray(value.children)
    ? value.children.map((child) => normalizeBlock(child))
    : [];

  return {
    id,
    type,
    props,
    content,
    children,
  };
}

export function validateBlock(block: unknown): asserts block is BlockNoteBlock {
  normalizeBlock(block);
}

export function buildDocumentFromRows<T extends { sortIndex: number }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => a.sortIndex - b.sortIndex);
}

export function flattenDocumentBlocks(
  blocks: BlockNoteBlock[],
): BlockNoteBlock[] {
  return blocks.flatMap((block) => [
    block,
    ...flattenDocumentBlocks(block.children),
  ]);
}

function inlineContentToPlainText(content: BlockNoteBlock["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }

      if (item.type === "link") {
        return inlineContentToPlainText(item.content);
      }

      return "";
    })
    .join("");
}

function normalizeInlineContent(content: unknown): string | InlineContent[] {
  if (content === undefined || content === null) {
    return [];
  }

  if (typeof content === "string") {
    return content ? [{ type: "text", text: content, styles: {} }] : [];
  }

  if (!Array.isArray(content)) {
    throw new Error("Block content must be a string or an array.");
  }

  return content.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Inline content must be an object.");
    }

    if (item.type === "text") {
      if (typeof item.text !== "string") {
        throw new Error("Text inline content must include text.");
      }

      return {
        type: "text",
        text: item.text,
        styles: isRecord(item.styles) ? item.styles : {},
      };
    }

    if (item.type === "link") {
      if (typeof item.href !== "string") {
        throw new Error("Link inline content must include href.");
      }

      return {
        type: "link",
        href: item.href,
        content: normalizeInlineContent(item.content) as InlineContent[],
      };
    }

    throw new Error(`Unsupported inline content type: ${String(item.type)}`);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

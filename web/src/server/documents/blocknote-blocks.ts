// Block-shape utilities for the narrow subset of BlockNote JSON we persist.
//
// The point of this module is to keep all knowledge of the editor's JSON
// format in one place: the repository reads/writes rows, the service layer
// orchestrates mutations, and everything that needs to poke at the innards of
// a block (normalization, plain-text projection, creating a fresh block) goes
// through here. If BlockNote's schema ever shifts, this is the single file
// that should need to change.

import { randomUUID } from "node:crypto";
import {
  BlockNoteBlock,
  InlineContent,
  SupportedBlockType,
  supportedBlockTypes,
} from "@/src/shared/documents";

const supportedBlockTypeSet = new Set<string>(supportedBlockTypes);

export function isSupportedBlockType(type: string): type is SupportedBlockType {
  return supportedBlockTypeSet.has(type);
}

/**
 * Factory for a minimal BlockNote block, used when the server originates a
 * block (e.g. the agent inserting a new paragraph). The client-authored path
 * generates its own IDs inside BlockNote, so this is server-side only.
 */
export function createTextBlock(
  text: string,
  type: SupportedBlockType = "paragraph",
  // Typed `string` rather than inheriting `randomUUID`'s template-literal
  // type so callers can pass any stable id — the function doesn't actually
  // require a UUID-shaped value, only the default happens to be one.
  id: string = randomUUID(),
): BlockNoteBlock {
  return {
    id,
    type,
    props: {},
    content: text ? [{ type: "text", text, styles: {} }] : [],
    children: [],
  };
}

/**
 * Overwrite a block's inline content with a single plain-text run.
 *
 * Used by the agent `replaceBlockText` path, which intentionally throws away
 * any prior styling because the agent reasons in plain text and we don't want
 * it to silently preserve formatting it can't see.
 */
export function replaceBlockText(
  block: BlockNoteBlock,
  text: string,
): BlockNoteBlock {
  return {
    ...block,
    content: text ? [{ type: "text", text, styles: {} }] : [],
  };
}

/**
 * Flatten a block to plain text.
 *
 * Persisted alongside each block so that search and the agent's view of the
 * document have a cheap, pre-rendered representation without re-walking the
 * inline-content tree on every read.
 */
export function blockToPlainText(block: BlockNoteBlock): string {
  return inlineContentToPlainText(block.content);
}

/**
 * Coerce an untrusted JSON value into a valid `BlockNoteBlock` or throw.
 *
 * This is the single choke point between inbound JSON (HTTP bodies, agent
 * tool arguments) and anything that writes to the database. We reject
 * unknown block types, unknown inline shapes, and missing IDs so that the
 * on-disk blocks are guaranteed to match the schema the editor expects when
 * we rehydrate the document.
 *
 * `forcedId` is used by the update path so that the caller's URL-bound
 * `blockId` wins over whatever the payload carries — prevents a client from
 * renaming a block via a PATCH.
 */
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

  // The editor treats the document as a flat list of blocks. Accept the field
  // because BlockNote always emits it, but refuse any nested children so we
  // never persist a tree we don't know how to address elsewhere in the app.
  if (value.children !== undefined && !Array.isArray(value.children)) {
    throw new Error("Block children must be an array.");
  }
  if (Array.isArray(value.children) && value.children.length > 0) {
    throw new Error("Nested block children are not supported.");
  }

  return {
    id,
    type,
    props,
    content,
    children: [],
  };
}

/**
 * Assertion-style wrapper around `normalizeBlock` for places that only need
 * to validate without keeping the normalized result.
 */
export function validateBlock(block: unknown): asserts block is BlockNoteBlock {
  normalizeBlock(block);
}

/**
 * Stable-sort helper for rows that come out of the DB in arbitrary order.
 * Exported as a utility for tests and any ad-hoc tooling that reconstructs a
 * document from raw rows.
 */
export function buildDocumentFromRows<T extends { sortIndex: number }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => a.sortIndex - b.sortIndex);
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

// Accepts both the string form ("legacy" BlockNote shorthand) and the
// structured array form, then always emits the array form. Storing one shape
// simplifies every downstream consumer.
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

import { describe, expect, it } from "vitest";
import {
  blockToPlainText,
  buildDocumentFromRows,
  createTextBlock,
  normalizeBlock,
  replaceBlockText,
} from "@/src/server/documents/blocknote-blocks";

describe("blocknote block utilities", () => {
  it("creates text blocks with stable IDs and inline content", () => {
    const block = createTextBlock("Draft paragraph.", "paragraph", "block-a");

    expect(block).toEqual({
      id: "block-a",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "Draft paragraph.", styles: {} }],
      children: [],
    });
  });

  it("extracts plain text from styled spans and links", () => {
    const block = normalizeBlock({
      id: "block-a",
      type: "paragraph",
      props: {},
      content: [
        { type: "text", text: "Hello ", styles: { bold: true } },
        {
          type: "link",
          href: "https://example.com",
          content: [{ type: "text", text: "world", styles: {} }],
        },
      ],
      children: [],
    });

    expect(blockToPlainText(block)).toBe("Hello world");
  });

  it("replaces block text without changing identity or type", () => {
    const block = createTextBlock("Before", "quote", "block-a");
    const nextBlock = replaceBlockText(block, "After");

    expect(nextBlock.id).toBe("block-a");
    expect(nextBlock.type).toBe("quote");
    expect(blockToPlainText(nextBlock)).toBe("After");
  });

  it("normalizes missing props and children", () => {
    const block = normalizeBlock({
      id: "block-a",
      type: "heading",
      content: "Title",
    });

    expect(block.props).toEqual({});
    expect(block.children).toEqual([]);
    expect(blockToPlainText(block)).toBe("Title");
  });

  it("rejects unsupported block types", () => {
    expect(() =>
      normalizeBlock({
        id: "block-a",
        type: "image",
        props: {},
        children: [],
      }),
    ).toThrow("Unsupported block type");
  });

  it("rejects blocks with nested children", () => {
    expect(() =>
      normalizeBlock({
        id: "block-a",
        type: "bulletListItem",
        props: {},
        content: "parent",
        children: [
          {
            id: "block-b",
            type: "bulletListItem",
            props: {},
            content: "child",
            children: [],
          },
        ],
      }),
    ).toThrow("Nested block children are not supported.");
  });

  it("sorts document rows by sort index", () => {
    expect(
      buildDocumentFromRows([
        { id: "b", sortIndex: 1 },
        { id: "a", sortIndex: 0 },
      ]),
    ).toEqual([
      { id: "a", sortIndex: 0 },
      { id: "b", sortIndex: 1 },
    ]);
  });
});

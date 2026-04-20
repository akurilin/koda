import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTextBlock,
  createDocument,
  deleteBlock,
  getDocument,
  insertBlockAfter,
  moveBlock,
  replaceBlock,
  replaceBlockText,
  syncDocumentBlocks,
} from "@/src/server/documents/document-service";
import { createTextBlock } from "@/src/server/documents/blocknote-blocks";
import { cleanupTestRun, createTestRunId } from "./helpers";

describe("document service", () => {
  let testRunId: string;

  beforeEach(() => {
    testRunId = createTestRunId();
  });

  afterEach(async () => {
    await cleanupTestRun(testRunId);
  });

  it("creates a document", async () => {
    const document = await createDocument({
      title: "test_document_service_create",
      testRunId,
    });

    expect(document.id).toEqual(expect.any(String));
    expect(document.testRunId).toBe(testRunId);
    expect(document.blocks).toEqual([]);
  });

  it("appends and reloads ordered blocks", async () => {
    const document = await createDocument({ title: "test_blocks", testRunId });

    await appendTextBlock({ documentId: document.id, text: "First" });
    await appendTextBlock({ documentId: document.id, text: "Second" });
    await appendTextBlock({ documentId: document.id, text: "Third" });

    const reloaded = await getDocument(document.id);

    expect(reloaded?.blocks.map((block) => block.plainText)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(reloaded?.blocks.map((block) => block.sortIndex)).toEqual([0, 1, 2]);
  });

  it("inserts a block after another block", async () => {
    const document = await createDocument({ title: "test_insert", testRunId });
    const first = await appendTextBlock({ documentId: document.id, text: "A" });
    await appendTextBlock({ documentId: document.id, text: "B" });

    await insertBlockAfter({
      documentId: document.id,
      referenceBlockId: first.id,
      blockJson: createTextBlock("C"),
    });

    const reloaded = await getDocument(document.id);

    expect(reloaded?.blocks.map((block) => block.plainText)).toEqual([
      "A",
      "C",
      "B",
    ]);
  });

  it("replaces block text and increments revision", async () => {
    const document = await createDocument({ title: "test_replace", testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Before",
    });

    const result = await replaceBlockText({
      documentId: document.id,
      blockId: block.id,
      text: "After",
      expectedRevision: block.revision,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBe(block.id);
    expect(result.value.plainText).toBe("After");
    expect(result.value.revision).toBe(block.revision + 1);
  });

  it("replaces full block JSON", async () => {
    const document = await createDocument({
      title: "test_replace_json",
      testRunId,
    });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Paragraph",
    });

    const result = await replaceBlock({
      documentId: document.id,
      blockId: block.id,
      expectedRevision: block.revision,
      blockJson: createTextBlock("Heading", "heading", block.id),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.blockType).toBe("heading");
    expect(result.value.plainText).toBe("Heading");
  });

  it("deletes a block and compacts order", async () => {
    const document = await createDocument({ title: "test_delete", testRunId });
    await appendTextBlock({ documentId: document.id, text: "A" });
    const deleted = await appendTextBlock({
      documentId: document.id,
      text: "B",
    });
    await appendTextBlock({ documentId: document.id, text: "C" });

    const result = await deleteBlock({
      documentId: document.id,
      blockId: deleted.id,
      expectedRevision: deleted.revision,
    });

    expect(result.ok).toBe(true);

    const reloaded = await getDocument(document.id);
    expect(reloaded?.blocks.map((block) => block.plainText)).toEqual([
      "A",
      "C",
    ]);
    expect(reloaded?.blocks.map((block) => block.sortIndex)).toEqual([0, 1]);
  });

  it("moves a block", async () => {
    const document = await createDocument({ title: "test_move", testRunId });
    const a = await appendTextBlock({ documentId: document.id, text: "A" });
    const b = await appendTextBlock({ documentId: document.id, text: "B" });
    const c = await appendTextBlock({ documentId: document.id, text: "C" });

    const result = await moveBlock({
      documentId: document.id,
      blockId: c.id,
      afterBlockId: a.id,
      expectedRevision: c.revision,
    });

    expect(result.ok).toBe(true);
    expect(b.plainText).toBe("B");

    const reloaded = await getDocument(document.id);
    expect(reloaded?.blocks.map((block) => block.plainText)).toEqual([
      "A",
      "C",
      "B",
    ]);
  });

  it("rejects stale writes", async () => {
    const document = await createDocument({ title: "test_stale", testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Before",
    });

    await replaceBlockText({
      documentId: document.id,
      blockId: block.id,
      text: "First update",
      expectedRevision: block.revision,
    });

    const result = await replaceBlockText({
      documentId: document.id,
      blockId: block.id,
      text: "Stale update",
      expectedRevision: block.revision,
    });

    expect(result.ok).toBe(false);

    const reloaded = await getDocument(document.id);
    expect(reloaded?.blocks[0]?.plainText).toBe("First update");
  });

  it("syncs editor blocks with revision checks", async () => {
    const document = await createDocument({ title: "test_sync", testRunId });
    const a = await appendTextBlock({ documentId: document.id, text: "A" });
    const b = await appendTextBlock({ documentId: document.id, text: "B" });

    const result = await syncDocumentBlocks({
      documentId: document.id,
      blocks: [
        createTextBlock("B edited", "paragraph", b.id),
        createTextBlock("C", "paragraph", "client-created-block"),
      ],
      expectedRevisions: {
        [a.id]: a.revision,
        [b.id]: b.revision,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.map((block) => block.plainText)).toEqual([
      "B edited",
      "C",
    ]);
  });
});

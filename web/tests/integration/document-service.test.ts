import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTextBlock,
  createDocument,
  deleteBlock,
  getDocument,
  getOrCreatePrimaryDocument,
  insertBlockAfter,
  moveBlock,
  replaceBlock,
  replaceBlockText,
  setBlockFeedback,
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
    const document = await createDocument({ testRunId });

    expect(document.id).toEqual(expect.any(String));
    expect(document.testRunId).toBe(testRunId);
    expect(document.blocks).toEqual([]);
  });

  it("appends and reloads ordered blocks", async () => {
    const document = await createDocument({ testRunId });

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
    const document = await createDocument({ testRunId });
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
    const document = await createDocument({ testRunId });
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
    const document = await createDocument({ testRunId });
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
    const document = await createDocument({ testRunId });
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
    const document = await createDocument({ testRunId });
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
    const document = await createDocument({ testRunId });
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

  it("returns the same singleton primary document on repeated calls", async () => {
    const first = await getOrCreatePrimaryDocument();
    const second = await getOrCreatePrimaryDocument();

    expect(first.testRunId).toBeNull();
    expect(second.id).toBe(first.id);
    expect(second.testRunId).toBeNull();
  });

  // --- Agent feedback lifecycle ---
  //
  // The invariants the UI relies on:
  //   1. `setBlockFeedback` writes open-ended prose without bumping the
  //      content revision (otherwise concurrent user edits would race it).
  //   2. Empty / whitespace payloads collapse to null so "clear" has one
  //      canonical shape in the DB.
  //   3. Any content-changing update (workshop save or agent edit) clears
  //      the stored feedback — a rewrite of the block invalidates the
  //      reviewer's note.
  //   4. The whole-document sync path (autosave from main-editor typing)
  //      must NOT touch feedback; otherwise a keystroke would clobber an
  //      agent-authored note the user hasn't addressed yet.

  it("sets block feedback without bumping the content revision", async () => {
    const document = await createDocument({ testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Paragraph",
    });

    const updated = await setBlockFeedback({
      documentId: document.id,
      blockId: block.id,
      feedback: "This paragraph repeats the previous one.",
    });

    expect(updated?.feedback).toBe("This paragraph repeats the previous one.");
    expect(updated?.revision).toBe(block.revision);
  });

  it("collapses empty and whitespace feedback to null", async () => {
    const document = await createDocument({ testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Paragraph",
    });

    await setBlockFeedback({
      documentId: document.id,
      blockId: block.id,
      feedback: "a note",
    });

    const clearedViaEmpty = await setBlockFeedback({
      documentId: document.id,
      blockId: block.id,
      feedback: "   ",
    });
    expect(clearedViaEmpty?.feedback).toBeNull();

    await setBlockFeedback({
      documentId: document.id,
      blockId: block.id,
      feedback: "another note",
    });

    const clearedViaNull = await setBlockFeedback({
      documentId: document.id,
      blockId: block.id,
      feedback: null,
    });
    expect(clearedViaNull?.feedback).toBeNull();
  });

  it("returns null when setting feedback on a missing block", async () => {
    const document = await createDocument({ testRunId });

    const updated = await setBlockFeedback({
      documentId: document.id,
      blockId: "00000000-0000-0000-0000-000000000000",
      feedback: "anything",
    });

    expect(updated).toBeNull();
  });

  it("clears feedback when the block is saved out of workshop mode", async () => {
    const document = await createDocument({ testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Before",
    });

    await setBlockFeedback({
      documentId: document.id,
      blockId: block.id,
      feedback: "tighten this",
    });

    const result = await replaceBlock({
      documentId: document.id,
      blockId: block.id,
      expectedRevision: block.revision,
      blockJson: createTextBlock("After", "paragraph", block.id),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.feedback).toBeNull();

    const reloaded = await getDocument(document.id);
    expect(reloaded?.blocks[0]?.feedback).toBeNull();
  });

  it("clears feedback when the agent edits block text", async () => {
    const document = await createDocument({ testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Before",
    });

    await setBlockFeedback({
      documentId: document.id,
      blockId: block.id,
      feedback: "tighten this",
    });

    const result = await replaceBlockText({
      documentId: document.id,
      blockId: block.id,
      text: "After",
      expectedRevision: block.revision,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.feedback).toBeNull();
  });

  it("preserves feedback across the whole-document sync path", async () => {
    const document = await createDocument({ testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Paragraph",
    });

    const annotated = await setBlockFeedback({
      documentId: document.id,
      blockId: block.id,
      feedback: "keep me",
    });

    const result = await syncDocumentBlocks({
      documentId: document.id,
      blocks: [
        createTextBlock("Paragraph with a typo fix", "paragraph", block.id),
      ],
      expectedRevisions: {
        [block.id]: annotated?.revision ?? block.revision,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.feedback).toBe("keep me");
  });

  it("syncs editor blocks with revision checks", async () => {
    const document = await createDocument({ testRunId });
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

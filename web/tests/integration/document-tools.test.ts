import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDocumentTool,
  replaceBlockTextTool,
  setBlockFeedbackTool,
} from "@/src/server/agent/document-tools";
import {
  appendTextBlock,
  createDocument,
  getDocument,
  setBlockFeedback,
} from "@/src/server/documents/document-service";
import { cleanupTestRun, createTestRunId } from "./helpers";

describe("document agent tools", () => {
  let testRunId: string;

  beforeEach(() => {
    testRunId = createTestRunId();
  });

  afterEach(async () => {
    await cleanupTestRun(testRunId);
  });

  it("reads and edits through the same document service path", async () => {
    const document = await createDocument({ testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Replace me",
    });

    const snapshot = await getDocumentTool({ documentId: document.id });
    expect(snapshot.blocks).toEqual([
      expect.objectContaining({
        id: block.id,
        text: "Replace me",
        revision: 1,
      }),
    ]);

    const result = await replaceBlockTextTool({
      documentId: document.id,
      blockId: block.id,
      text: "Tool replacement",
      expectedRevision: block.revision,
    });

    expect(result.ok).toBe(true);

    const reloaded = await getDocument(document.id);
    expect(reloaded?.blocks[0]?.plainText).toBe("Tool replacement");
  });

  // --- setBlockFeedback tool ---
  //
  // Exercises the tool shape the model sees (ok flag + block payload),
  // and confirms that clears route through the same tool. The service-
  // level lifecycle (clear on save, preserve on sync) is covered in
  // `document-service.test.ts`; this file just checks the tool adapter.

  it("attaches feedback via the setBlockFeedback tool", async () => {
    const document = await createDocument({ testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Original",
    });

    const result = await setBlockFeedbackTool({
      documentId: document.id,
      blockId: block.id,
      feedback: "This paragraph has six questions in a row.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.id).toBe(block.id);
    expect(result.block.feedback).toBe(
      "This paragraph has six questions in a row.",
    );

    const reloaded = await getDocument(document.id);
    expect(reloaded?.blocks[0]?.feedback).toBe(
      "This paragraph has six questions in a row.",
    );
  });

  it("clears feedback when the tool is called with null", async () => {
    const document = await createDocument({ testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Original",
    });

    await setBlockFeedback({
      documentId: document.id,
      blockId: block.id,
      feedback: "seed",
    });

    const result = await setBlockFeedbackTool({
      documentId: document.id,
      blockId: block.id,
      feedback: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.feedback).toBeNull();
  });

  it("reports not-found when the tool targets a missing block", async () => {
    const document = await createDocument({ testRunId });

    const result = await setBlockFeedbackTool({
      documentId: document.id,
      blockId: "00000000-0000-0000-0000-000000000000",
      feedback: "anything",
    });

    expect(result.ok).toBe(false);
  });

  it("returns conflict data for stale revisions", async () => {
    const document = await createDocument({ testRunId });
    const block = await appendTextBlock({
      documentId: document.id,
      text: "Original",
    });

    await replaceBlockTextTool({
      documentId: document.id,
      blockId: block.id,
      text: "First",
      expectedRevision: block.revision,
    });

    const staleResult = await replaceBlockTextTool({
      documentId: document.id,
      blockId: block.id,
      text: "Second",
      expectedRevision: block.revision,
    });

    expect(staleResult.ok).toBe(false);
    expect(staleResult.currentBlock?.plainText).toBe("First");
  });
});

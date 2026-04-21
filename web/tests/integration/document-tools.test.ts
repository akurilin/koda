import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDocumentTool,
  replaceBlockTextTool,
} from "@/src/server/agent/document-tools";
import {
  appendTextBlock,
  createDocument,
  getDocument,
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

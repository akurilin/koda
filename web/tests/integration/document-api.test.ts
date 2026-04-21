import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createDocumentRoute } from "@/app/api/documents/route";
import { GET as getDocumentRoute } from "@/app/api/documents/[documentId]/route";
import { POST as appendBlockRoute } from "@/app/api/documents/[documentId]/blocks/route";
import { PATCH as updateBlockRoute } from "@/app/api/documents/[documentId]/blocks/[blockId]/route";
import { createTextBlock } from "@/src/server/documents/blocknote-blocks";
import { cleanupTestRun, createTestRunId } from "./helpers";

describe("document API routes", () => {
  let testRunId: string;

  beforeEach(() => {
    testRunId = createTestRunId();
  });

  afterEach(async () => {
    await cleanupTestRun(testRunId);
  });

  it("rejects document creation without a testRunId", async () => {
    const response = await createDocumentRoute(
      jsonRequest("http://localhost/api/documents", {
        title: "no_test_run_id",
      }),
    );

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toMatch(/testRunId/);
  });

  it("creates, appends, updates, and reloads a document", async () => {
    const createResponse = await createDocumentRoute(
      jsonRequest("http://localhost/api/documents", {
        title: "test_api",
        testRunId,
      }),
    );
    const document = await createResponse.json();

    expect(createResponse.status).toBe(201);

    const appendResponse = await appendBlockRoute(
      jsonRequest(`http://localhost/api/documents/${document.id}/blocks`, {
        blockJson: createTextBlock("API paragraph"),
      }),
      {
        params: Promise.resolve({ documentId: document.id }),
      },
    );
    const block = await appendResponse.json();

    expect(appendResponse.status).toBe(201);
    expect(block.plainText).toBe("API paragraph");

    const updateResponse = await updateBlockRoute(
      jsonRequest(
        `http://localhost/api/documents/${document.id}/blocks/${block.id}`,
        {
          text: "API replacement",
          expectedRevision: block.revision,
        },
        "PATCH",
      ),
      {
        params: Promise.resolve({
          documentId: document.id,
          blockId: block.id,
        }),
      },
    );

    expect(updateResponse.status).toBe(200);

    const getResponse = await getDocumentRoute(
      new Request(`http://localhost/api/documents/${document.id}`),
      {
        params: Promise.resolve({ documentId: document.id }),
      },
    );
    const reloaded = await getResponse.json();

    expect(reloaded.blocks).toEqual([
      expect.objectContaining({
        id: block.id,
        plainText: "API replacement",
      }),
    ]);
  });
});

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

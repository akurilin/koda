import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as chatRoute } from "@/app/api/chat/route";
import { POST as createDocumentRoute } from "@/app/api/documents/route";
import { GET as getDocumentRoute } from "@/app/api/documents/[documentId]/route";
import { POST as appendBlockRoute } from "@/app/api/documents/[documentId]/blocks/route";
import { PUT as syncBlocksRoute } from "@/app/api/documents/[documentId]/blocks/sync/route";
import { PATCH as updateBlockRoute } from "@/app/api/documents/[documentId]/blocks/[blockId]/route";
import {
  DELETE as deleteFeedbackRoute,
  PATCH as patchFeedbackRoute,
} from "@/app/api/documents/[documentId]/blocks/[blockId]/feedback/route";
import { POST as moveBlockRoute } from "@/app/api/documents/[documentId]/blocks/[blockId]/move/route";
import { POST as workshopChatRoute } from "@/app/api/workshop/chat/route";
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
      jsonRequest("http://localhost/api/documents", {}),
    );

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.issues).toEqual([
      expect.objectContaining({ path: "testRunId" }),
    ]);
  });

  it("rejects document creation with a non-UUID testRunId", async () => {
    const response = await createDocumentRoute(
      jsonRequest("http://localhost/api/documents", {
        testRunId: "not-a-uuid",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("creates, appends, updates, and reloads a document", async () => {
    const createResponse = await createDocumentRoute(
      jsonRequest("http://localhost/api/documents", { testRunId }),
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

  it("rejects malformed block creation payloads before service code", async () => {
    const documentId = crypto.randomUUID();
    const response = await appendBlockRoute(
      jsonRequest(`http://localhost/api/documents/${documentId}/blocks`, {
        blockJson: {
          id: "block-a",
          type: "image",
          props: {},
          children: [],
        },
      }),
      {
        params: Promise.resolve({ documentId }),
      },
    );

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.issues).toEqual([
      expect.objectContaining({ path: "blockJson.type" }),
    ]);
  });

  it("rejects revision coercion on block updates", async () => {
    const documentId = crypto.randomUUID();
    const blockId = "block-a";
    const response = await updateBlockRoute(
      jsonRequest(
        `http://localhost/api/documents/${documentId}/blocks/${blockId}`,
        {
          text: "Replacement",
          expectedRevision: true,
        },
        "PATCH",
      ),
      {
        params: Promise.resolve({ documentId, blockId }),
      },
    );

    expect(response.status).toBe(400);
  });

  it("rejects malformed move payloads instead of defaulting to top", async () => {
    const documentId = crypto.randomUUID();
    const blockId = "block-a";
    const response = await moveBlockRoute(
      jsonRequest(
        `http://localhost/api/documents/${documentId}/blocks/${blockId}/move`,
        {
          afterBlockId: 123,
        },
      ),
      {
        params: Promise.resolve({ documentId, blockId }),
      },
    );

    expect(response.status).toBe(400);
  });

  it("rejects duplicate block ids in whole-document sync", async () => {
    const documentId = crypto.randomUUID();
    const response = await syncBlocksRoute(
      jsonRequest(
        `http://localhost/api/documents/${documentId}/blocks/sync`,
        {
          blocks: [
            createTextBlock("A", "paragraph", "block-a"),
            createTextBlock("B", "paragraph", "block-a"),
          ],
          expectedRevisions: {},
        },
        "PUT",
      ),
      {
        params: Promise.resolve({ documentId }),
      },
    );

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.issues).toEqual([
      expect.objectContaining({
        message: "Block ids must be unique within a document sync.",
      }),
    ]);
  });

  it("validates chat UI messages before model streaming", async () => {
    const response = await chatRoute(
      jsonRequest(
        `http://localhost/api/chat?documentId=${crypto.randomUUID()}`,
        {
          messages: [],
        },
      ),
    );

    expect(response.status).toBe(400);
  });

  it("validates workshop context before model streaming", async () => {
    const response = await workshopChatRoute(
      jsonRequest("http://localhost/api/workshop/chat", {
        messages: [
          {
            id: "message-a",
            role: "user",
            parts: [{ type: "text", text: "Try a sharper version." }],
          },
        ],
        context: {
          documentBlocks: [
            createTextBlock("Paragraph", "paragraph", "block-a"),
          ],
          targetBlockId: "missing-block",
          versions: [[{ type: "text", text: "Paragraph", styles: {} }]],
          currentVersionIndex: 0,
          feedback: null,
        },
      }),
    );

    expect(response.status).toBe(400);
  });

  // --- Feedback endpoint ---
  //
  // Covers the verb shape the UI relies on: PATCH sets a new note, DELETE
  // clears it, and validation rejects payloads that aren't either a string
  // or null. Live-database tests (not route-level) cover the content
  // lifecycle — see `document-service.test.ts`.

  it("sets and clears block feedback through the feedback endpoint", async () => {
    const document = await createDocumentRoute(
      jsonRequest("http://localhost/api/documents", { testRunId }),
    ).then((response) => response.json());

    const block = await appendBlockRoute(
      jsonRequest(`http://localhost/api/documents/${document.id}/blocks`, {
        blockJson: createTextBlock("Feedback target"),
      }),
      { params: Promise.resolve({ documentId: document.id }) },
    ).then((response) => response.json());

    const setResponse = await patchFeedbackRoute(
      jsonRequest(
        `http://localhost/api/documents/${document.id}/blocks/${block.id}/feedback`,
        { feedback: "This paragraph could lose half its length." },
        "PATCH",
      ),
      {
        params: Promise.resolve({
          documentId: document.id,
          blockId: block.id,
        }),
      },
    );
    expect(setResponse.status).toBe(200);
    const afterSet = await setResponse.json();
    expect(afterSet.feedback).toBe(
      "This paragraph could lose half its length.",
    );

    const clearResponse = await deleteFeedbackRoute(
      new Request(
        `http://localhost/api/documents/${document.id}/blocks/${block.id}/feedback`,
        { method: "DELETE" },
      ),
      {
        params: Promise.resolve({
          documentId: document.id,
          blockId: block.id,
        }),
      },
    );
    expect(clearResponse.status).toBe(200);
    const afterClear = await clearResponse.json();
    expect(afterClear.feedback).toBeNull();
  });

  it("rejects a feedback payload that isn't a string or null", async () => {
    const document = await createDocumentRoute(
      jsonRequest("http://localhost/api/documents", { testRunId }),
    ).then((response) => response.json());

    const block = await appendBlockRoute(
      jsonRequest(`http://localhost/api/documents/${document.id}/blocks`, {
        blockJson: createTextBlock("Feedback target"),
      }),
      { params: Promise.resolve({ documentId: document.id }) },
    ).then((response) => response.json());

    const response = await patchFeedbackRoute(
      jsonRequest(
        `http://localhost/api/documents/${document.id}/blocks/${block.id}/feedback`,
        { feedback: 42 },
        "PATCH",
      ),
      {
        params: Promise.resolve({
          documentId: document.id,
          blockId: block.id,
        }),
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.issues).toEqual([
      expect.objectContaining({ path: "feedback" }),
    ]);
  });

  it("returns 404 when setting feedback on a missing block", async () => {
    const document = await createDocumentRoute(
      jsonRequest("http://localhost/api/documents", { testRunId }),
    ).then((response) => response.json());

    const response = await patchFeedbackRoute(
      jsonRequest(
        `http://localhost/api/documents/${document.id}/blocks/00000000-0000-0000-0000-000000000000/feedback`,
        { feedback: "anything" },
        "PATCH",
      ),
      {
        params: Promise.resolve({
          documentId: document.id,
          blockId: "00000000-0000-0000-0000-000000000000",
        }),
      },
    );

    expect(response.status).toBe(404);
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

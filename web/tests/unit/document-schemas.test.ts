import { describe, expect, it } from "vitest";
import {
  chatBodySchema,
  workshopChatBodySchema,
} from "@/src/server/documents/document-schemas";

// Mirrors the keys `AssistantChatTransport` attaches around our body
// callback's return value. If the schema ever regresses to strictObject,
// these keys would trip an `unrecognized_keys` error and the chat endpoints
// would start returning 400.
const transportExtras = {
  id: "thread-1",
  trigger: "submit-user-message",
  messageId: "msg-1",
  metadata: { clientVersion: "test" },
  tools: {},
  callSettings: {},
  system: "ignored by handler",
  config: {},
};

describe("chat body schemas accept transport bookkeeping", () => {
  it("chatBodySchema does not reject transport-level extras", () => {
    const result = chatBodySchema.safeParse({
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      ...transportExtras,
    });

    expect(result.success).toBe(true);
  });

  it("workshopChatBodySchema does not reject transport-level extras", () => {
    const result = workshopChatBodySchema.safeParse({
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      context: {
        documentBlocks: [{ id: "block-a", type: "paragraph" }],
        targetBlockId: "block-a",
        versions: [[]],
        currentVersionIndex: 0,
        feedback: null,
      },
      ...transportExtras,
    });

    expect(result.success).toBe(true);
  });
});

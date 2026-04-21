// Chat endpoint powering the right-hand editorial assistant panel.
//
// The UI sends `documentId` in the query string so the server can bind the
// tool set to exactly one document — the model shouldn't be able to edit a
// different document by slipping an id into its tool arguments. See
// `createDocumentTools` for how that binding works.

import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { createDocumentTools } from "@/src/server/agent/document-tools";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const documentId = url.searchParams.get("documentId");

  if (!documentId) {
    return Response.json({ error: "documentId is required." }, { status: 400 });
  }

  const { messages }: { messages: UIMessage[] } = await request.json();

  // `stepCountIs(5)` caps tool-call recursion so a confused model can't
  // runaway-loop on conflicts. The system prompt steers the model toward
  // the revision-check contract the tools require.
  const result = streamText({
    model: anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"),
    system: [
      "You are an assistant helping an author revise a prose document.",
      "Use tools to inspect and edit the document. Do not claim an edit was made unless a tool call succeeded.",
      "Before editing a block, call getDocument and use the latest block revision as expectedRevision.",
      "Make the smallest edit that satisfies the user. Do not edit unrelated blocks.",
    ].join("\n"),
    messages: await convertToModelMessages(messages),
    tools: createDocumentTools(documentId),
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}

// Chat endpoint powering the right-hand editorial assistant panel.
//
// The UI sends `documentId` in the query string so the server can bind the
// tool set to exactly one document — the model shouldn't be able to edit a
// different document by slipping an id into its tool arguments. See
// `createDocumentTools` for how that binding works.

import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { parseJsonBody, parseUnknown } from "@/src/server/api/validation";
import { createDocumentTools } from "@/src/server/agent/document-tools";
import {
  chatBodySchema,
  chatQuerySchema,
} from "@/src/server/documents/document-schemas";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const query = parseUnknown(
    { documentId: url.searchParams.get("documentId") },
    chatQuerySchema,
  );

  if (!query.ok) {
    return query.response;
  }

  const body = await parseJsonBody(request, chatBodySchema);

  if (!body.ok) {
    return body.response;
  }

  const tools = createDocumentTools(query.data.documentId);
  const messages = await safeValidateUIMessages<UIMessage>({
    messages: body.data.messages,
    tools: tools as Parameters<
      typeof safeValidateUIMessages<UIMessage>
    >[0]["tools"],
  });

  if (!messages.success) {
    return Response.json(
      {
        error: "Invalid request.",
        issues: [
          {
            path: "messages",
            message: messages.error.message,
            code: "invalid_ui_messages",
          },
        ],
      },
      { status: 400 },
    );
  }

  // `stepCountIs(12)` caps tool-call recursion so a confused model can't
  // runaway-loop on conflicts, while still leaving headroom for a whole-
  // article review that fans out one `setBlockFeedback` call per paragraph
  // plus a surrounding `getDocument`. The system prompt steers the model
  // toward the revision-check contract and the feedback-vs-chat rule.
  const result = streamText({
    model: anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"),
    system: [
      "You are an assistant helping an author revise a prose document.",
      "Use tools to inspect and edit the document. Do not claim an edit was made unless a tool call succeeded.",
      "Before editing a block, call getDocument and use the latest block revision as expectedRevision.",
      "Make the smallest edit that satisfies the user. Do not edit unrelated blocks.",
      "When the user asks for feedback, critique, review, comments, or opportunities to tighten / cut / rework the piece, use the setBlockFeedback tool to attach a note to each relevant block. Do not paste a block-by-block critique into chat — the user reads your notes through the per-block UI, not in the chat log. A short chat summary afterward is fine.",
      "Skip blocks that don't need attention. Feedback should be the short prompt the writer needs to act, not a line-by-line rewrite.",
    ].join("\n"),
    messages: await convertToModelMessages(messages.data),
    tools,
    stopWhen: stepCountIs(12),
  });

  return result.toUIMessageStreamResponse();
}

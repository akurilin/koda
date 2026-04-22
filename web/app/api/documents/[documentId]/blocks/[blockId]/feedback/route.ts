// Per-block agent feedback read/write endpoint.
//
// Feedback is the main-editor agent's freeform critique of a single block
// (see the `setBlockFeedback` tool and the `agent_feedback` column). This
// route exists so clients can also set / clear it without going through
// the agent — most importantly, the X button next to a block lets the
// user dismiss feedback they don't agree with via DELETE.
//
// Feedback does not participate in the `revision` optimistic-concurrency
// check. It's a side-channel to content, so a concurrent user keystroke
// must not cause an agent feedback write to fail (or vice versa).

import { parseJsonBody, parseUnknown } from "@/src/server/api/validation";
import { setBlockFeedback } from "@/src/server/documents/document-service";
import {
  blockRouteParamsSchema,
  feedbackBodySchema,
} from "@/src/server/documents/document-schemas";

type FeedbackRouteContext = {
  params: Promise<{
    documentId: string;
    blockId: string;
  }>;
};

export async function PATCH(request: Request, context: FeedbackRouteContext) {
  const params = parseUnknown(await context.params, blockRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const body = await parseJsonBody(request, feedbackBodySchema);

  if (!body.ok) {
    return body.response;
  }

  // Empty / whitespace strings collapse to null inside the service layer so
  // "clear" has a single canonical representation.
  const updated = await setBlockFeedback({
    documentId: params.data.documentId,
    blockId: params.data.blockId,
    feedback: body.data.feedback,
  });

  if (!updated) {
    return Response.json({ error: "Block not found." }, { status: 404 });
  }

  return Response.json(updated);
}

/**
 * Convenience verb for the X button. Identical to `PATCH { feedback: null }`
 * but clearer at call sites and matches REST expectations for "drop this
 * resource's state".
 */
export async function DELETE(_request: Request, context: FeedbackRouteContext) {
  const params = parseUnknown(await context.params, blockRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const updated = await setBlockFeedback({
    documentId: params.data.documentId,
    blockId: params.data.blockId,
    feedback: null,
  });

  if (!updated) {
    return Response.json({ error: "Block not found." }, { status: 404 });
  }

  return Response.json(updated);
}

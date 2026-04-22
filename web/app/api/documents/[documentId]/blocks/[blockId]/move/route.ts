// Block reordering endpoint.
//
// `afterBlockId` is `null` to move to the top. `expectedRevision` is
// optional here because reordering doesn't change a block's content — pass
// it only when you specifically want to guard against the block being
// edited between your read and your move.

import { moveBlock } from "@/src/server/documents/document-service";
import {
  blockRouteParamsSchema,
  moveBlockBodySchema,
} from "@/src/server/documents/document-schemas";
import { parseJsonBody, parseUnknown } from "@/src/server/api/validation";

type MoveRouteContext = {
  params: Promise<{
    documentId: string;
    blockId: string;
  }>;
};

export async function POST(request: Request, context: MoveRouteContext) {
  const params = parseUnknown(await context.params, blockRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const body = await parseJsonBody(request, moveBlockBodySchema);

  if (!body.ok) {
    return body.response;
  }

  const result = await moveBlock({
    documentId: params.data.documentId,
    blockId: params.data.blockId,
    afterBlockId: body.data.afterBlockId,
    expectedRevision: body.data.expectedRevision,
  });

  if (!result.ok) {
    return Response.json(
      {
        error: "Block conflict.",
        currentBlock: result.currentBlock,
      },
      { status: 409 },
    );
  }

  return Response.json({ blocks: result.value });
}

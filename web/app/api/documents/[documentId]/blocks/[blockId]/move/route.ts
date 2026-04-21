// Block reordering endpoint.
//
// `afterBlockId` is `null` to move to the top. `expectedRevision` is
// optional here because reordering doesn't change a block's content — pass
// it only when you specifically want to guard against the block being
// edited between your read and your move.

import { moveBlock } from "@/src/server/documents/document-service";

type MoveRouteContext = {
  params: Promise<{
    documentId: string;
    blockId: string;
  }>;
};

export async function POST(request: Request, context: MoveRouteContext) {
  const { documentId, blockId } = await context.params;
  const body = await request.json();
  const expectedRevision =
    body.expectedRevision === undefined
      ? undefined
      : Number(body.expectedRevision);

  if (expectedRevision !== undefined && !Number.isInteger(expectedRevision)) {
    return Response.json(
      { error: "expectedRevision must be an integer." },
      { status: 400 },
    );
  }

  const result = await moveBlock({
    documentId,
    blockId,
    afterBlockId:
      typeof body.afterBlockId === "string" ? body.afterBlockId : null,
    expectedRevision,
    source: "user",
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

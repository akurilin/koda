// Block insertion endpoint.
//
// Appends to the end when `afterBlockId` is omitted, inserts after the given
// block otherwise. Splitting the two modes on presence (rather than a null
// sentinel) keeps the contract simple: callers that want "add at the top"
// send `afterBlockId: null` through the insert path.

import {
  appendBlock,
  insertBlockAfter,
} from "@/src/server/documents/document-service";

type BlocksRouteContext = {
  params: Promise<{
    documentId: string;
  }>;
};

export async function POST(request: Request, context: BlocksRouteContext) {
  const { documentId } = await context.params;
  const body = await request.json();

  const block =
    body.afterBlockId === undefined
      ? await appendBlock({
          documentId,
          blockJson: body.blockJson,
        })
      : await insertBlockAfter({
          documentId,
          referenceBlockId: body.afterBlockId,
          blockJson: body.blockJson,
        });

  return Response.json(block, { status: 201 });
}

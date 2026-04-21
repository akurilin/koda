// Single-block read / update / delete.
//
// PATCH supports two modes: pass `text` for the lightweight "replace plain
// text" path the agent uses, or `blockJson` for a full structural replace
// from the editor. Both require `expectedRevision` — any conflict returns
// 409 with the current block so the client can reconcile.

import {
  deleteBlock,
  getDocument,
  replaceBlock,
  replaceBlockText,
} from "@/src/server/documents/document-service";

type BlockRouteContext = {
  params: Promise<{
    documentId: string;
    blockId: string;
  }>;
};

export async function GET(_request: Request, context: BlockRouteContext) {
  const { documentId, blockId } = await context.params;
  const document = await getDocument(documentId);
  const block = document?.blocks.find((item) => item.id === blockId);

  if (!block) {
    return Response.json({ error: "Block not found." }, { status: 404 });
  }

  return Response.json(block);
}

export async function PATCH(request: Request, context: BlockRouteContext) {
  const { documentId, blockId } = await context.params;
  const body = await request.json();
  const expectedRevision = Number(body.expectedRevision);

  if (!Number.isInteger(expectedRevision)) {
    return Response.json(
      { error: "expectedRevision must be an integer." },
      { status: 400 },
    );
  }

  const result =
    typeof body.text === "string"
      ? await replaceBlockText({
          documentId,
          blockId,
          text: body.text,
          expectedRevision,
          source: "user",
        })
      : await replaceBlock({
          documentId,
          blockId,
          blockJson: body.blockJson,
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

  return Response.json(result.value);
}

export async function DELETE(request: Request, context: BlockRouteContext) {
  const { documentId, blockId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const expectedRevision = Number(body.expectedRevision);

  if (!Number.isInteger(expectedRevision)) {
    return Response.json(
      { error: "expectedRevision must be an integer." },
      { status: 400 },
    );
  }

  const result = await deleteBlock({
    documentId,
    blockId,
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

  return Response.json(result.value);
}

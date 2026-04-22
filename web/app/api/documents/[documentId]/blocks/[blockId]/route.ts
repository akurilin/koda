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
import {
  blockRouteParamsSchema,
  deleteBlockBodySchema,
  patchBlockBodySchema,
} from "@/src/server/documents/document-schemas";
import { parseJsonBody, parseUnknown } from "@/src/server/api/validation";

type BlockRouteContext = {
  params: Promise<{
    documentId: string;
    blockId: string;
  }>;
};

export async function GET(_request: Request, context: BlockRouteContext) {
  const params = parseUnknown(await context.params, blockRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const { documentId, blockId } = params.data;
  const document = await getDocument(documentId);
  const block = document?.blocks.find((item) => item.id === blockId);

  if (!block) {
    return Response.json({ error: "Block not found." }, { status: 404 });
  }

  return Response.json(block);
}

export async function PATCH(request: Request, context: BlockRouteContext) {
  const params = parseUnknown(await context.params, blockRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const body = await parseJsonBody(request, patchBlockBodySchema);

  if (!body.ok) {
    return body.response;
  }

  const { documentId, blockId } = params.data;
  const { expectedRevision } = body.data;
  const result =
    "text" in body.data
      ? await replaceBlockText({
          documentId,
          blockId,
          text: body.data.text,
          expectedRevision,
        })
      : await replaceBlock({
          documentId,
          blockId,
          blockJson: body.data.blockJson,
          expectedRevision,
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
  const params = parseUnknown(await context.params, blockRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const body = await parseJsonBody(request, deleteBlockBodySchema);

  if (!body.ok) {
    return body.response;
  }

  const { documentId, blockId } = params.data;
  const result = await deleteBlock({
    documentId,
    blockId,
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

  return Response.json(result.value);
}

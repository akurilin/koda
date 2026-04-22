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
import {
  appendBlockBodySchema,
  documentRouteParamsSchema,
} from "@/src/server/documents/document-schemas";
import { parseJsonBody, parseUnknown } from "@/src/server/api/validation";

type BlocksRouteContext = {
  params: Promise<{
    documentId: string;
  }>;
};

export async function POST(request: Request, context: BlocksRouteContext) {
  const params = parseUnknown(await context.params, documentRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const body = await parseJsonBody(request, appendBlockBodySchema);

  if (!body.ok) {
    return body.response;
  }

  const block =
    body.data.afterBlockId === undefined
      ? await appendBlock({
          documentId: params.data.documentId,
          blockJson: body.data.blockJson,
        })
      : await insertBlockAfter({
          documentId: params.data.documentId,
          referenceBlockId: body.data.afterBlockId,
          blockJson: body.data.blockJson,
        });

  return Response.json(block, { status: 201 });
}

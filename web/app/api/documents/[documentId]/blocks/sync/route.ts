// Whole-document save endpoint used by the editor's debounced autosave.
//
// The client sends the entire current block list plus a map of the
// revisions it believed it was editing on top of. The service layer turns
// any mismatch into a 409 so the client can refetch and re-emit its diff.

import { syncDocumentBlocks } from "@/src/server/documents/document-service";
import {
  documentRouteParamsSchema,
  syncBlocksBodySchema,
} from "@/src/server/documents/document-schemas";
import { parseJsonBody, parseUnknown } from "@/src/server/api/validation";

type SyncRouteContext = {
  params: Promise<{
    documentId: string;
  }>;
};

export async function PUT(request: Request, context: SyncRouteContext) {
  const params = parseUnknown(await context.params, documentRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const body = await parseJsonBody(request, syncBlocksBodySchema);

  if (!body.ok) {
    return body.response;
  }

  const result = await syncDocumentBlocks({
    documentId: params.data.documentId,
    blocks: body.data.blocks,
    expectedRevisions: body.data.expectedRevisions,
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

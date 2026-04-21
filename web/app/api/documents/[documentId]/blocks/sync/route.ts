// Whole-document save endpoint used by the editor's debounced autosave.
//
// The client sends the entire current block list plus a map of the
// revisions it believed it was editing on top of. The service layer turns
// any mismatch into a 409 so the client can refetch and re-emit its diff.

import { syncDocumentBlocks } from "@/src/server/documents/document-service";

type SyncRouteContext = {
  params: Promise<{
    documentId: string;
  }>;
};

export async function PUT(request: Request, context: SyncRouteContext) {
  const { documentId } = await context.params;
  const body = await request.json();

  const result = await syncDocumentBlocks({
    documentId,
    // Tolerate missing / malformed fields by coercing to empty defaults;
    // the service layer is the one that validates individual block shapes.
    blocks: Array.isArray(body.blocks) ? body.blocks : [],
    expectedRevisions:
      body.expectedRevisions &&
      typeof body.expectedRevisions === "object" &&
      !Array.isArray(body.expectedRevisions)
        ? body.expectedRevisions
        : {},
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

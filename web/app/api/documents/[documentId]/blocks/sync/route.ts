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

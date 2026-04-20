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
          source: "user",
        })
      : await insertBlockAfter({
          documentId,
          referenceBlockId: body.afterBlockId,
          blockJson: body.blockJson,
          source: "user",
        });

  return Response.json(block, { status: 201 });
}

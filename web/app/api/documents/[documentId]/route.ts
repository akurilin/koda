import {
  deleteDocument,
  getDocument,
} from "@/src/server/documents/document-service";

type DocumentRouteContext = {
  params: Promise<{
    documentId: string;
  }>;
};

export async function GET(_request: Request, context: DocumentRouteContext) {
  const { documentId } = await context.params;
  const document = await getDocument(documentId);

  if (!document) {
    return Response.json({ error: "Document not found." }, { status: 404 });
  }

  return Response.json(document);
}

export async function DELETE(_request: Request, context: DocumentRouteContext) {
  const { documentId } = await context.params;
  await deleteDocument(documentId);

  return new Response(null, { status: 204 });
}

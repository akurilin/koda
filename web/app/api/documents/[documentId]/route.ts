// Per-document read and delete endpoints.

import {
  deleteDocument,
  getDocument,
} from "@/src/server/documents/document-service";
import { documentRouteParamsSchema } from "@/src/server/documents/document-schemas";
import { parseUnknown } from "@/src/server/api/validation";

// Next.js 15 makes route `params` a Promise; typing it here keeps the
// async-await in the handler readable.
type DocumentRouteContext = {
  params: Promise<{
    documentId: string;
  }>;
};

export async function GET(_request: Request, context: DocumentRouteContext) {
  const params = parseUnknown(await context.params, documentRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const { documentId } = params.data;
  const document = await getDocument(documentId);

  if (!document) {
    return Response.json({ error: "Document not found." }, { status: 404 });
  }

  return Response.json(document);
}

export async function DELETE(_request: Request, context: DocumentRouteContext) {
  const params = parseUnknown(await context.params, documentRouteParamsSchema);

  if (!params.ok) {
    return params.response;
  }

  const { documentId } = params.data;
  await deleteDocument(documentId);

  return new Response(null, { status: 204 });
}

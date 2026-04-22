// Creation endpoint for test-run documents.
//
// The app is currently wired around a singleton primary document (see the
// homepage and `getOrCreatePrimaryDocument`), so this route intentionally
// refuses to create "real" documents and only exists for e2e/integration
// tests that need an isolated row tagged with their own `testRunId`. When we
// grow a multi-document UI this guard can be relaxed.

import { parseJsonBody } from "@/src/server/api/validation";
import { createDocument } from "@/src/server/documents/document-service";
import { createDocumentBodySchema } from "@/src/server/documents/document-schemas";

export async function POST(request: Request) {
  const body = await parseJsonBody(request, createDocumentBodySchema);

  if (!body.ok) {
    return body.response;
  }

  const document = await createDocument({
    testRunId: body.data.testRunId,
  });

  return Response.json(document, { status: 201 });
}

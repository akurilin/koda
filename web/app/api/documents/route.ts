// Creation endpoint for test-run documents.
//
// The app is currently wired around a singleton primary document (see the
// homepage and `getOrCreatePrimaryDocument`), so this route intentionally
// refuses to create "real" documents and only exists for e2e/integration
// tests that need an isolated row tagged with their own `testRunId`. When we
// grow a multi-document UI this guard can be relaxed.

import { createDocument } from "@/src/server/documents/document-service";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  if (typeof body.testRunId !== "string" || body.testRunId.length === 0) {
    return Response.json(
      {
        error:
          "testRunId is required. The app uses a singleton primary document; new documents can only be created for test runs.",
      },
      { status: 400 },
    );
  }

  const document = await createDocument({
    title: typeof body.title === "string" ? body.title : "",
    testRunId: body.testRunId,
  });

  return Response.json(document, { status: 201 });
}

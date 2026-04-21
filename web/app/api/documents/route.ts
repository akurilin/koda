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

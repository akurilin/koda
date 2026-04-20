import { createDocument } from "@/src/server/documents/document-service";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const document = await createDocument({
    title: typeof body.title === "string" ? body.title : "",
    testRunId: typeof body.testRunId === "string" ? body.testRunId : null,
  });

  return Response.json(document, { status: 201 });
}

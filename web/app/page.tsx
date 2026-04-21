import { getOrCreatePrimaryDocument } from "@/src/server/documents/document-service";
import { DocumentWorkspace } from "@/app/components/document-workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const document = await getOrCreatePrimaryDocument();

  return <DocumentWorkspace initialDocument={document} />;
}

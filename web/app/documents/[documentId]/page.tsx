import { notFound } from "next/navigation";
import { getDocument } from "@/src/server/documents/document-service";
import { DocumentWorkspace } from "@/app/components/document-workspace";

export const dynamic = "force-dynamic";

type DocumentPageProps = {
  params: Promise<{
    documentId: string;
  }>;
};

export default async function DocumentPage({ params }: DocumentPageProps) {
  const { documentId } = await params;
  const document = await getDocument(documentId);

  if (!document) {
    notFound();
  }

  return <DocumentWorkspace initialDocument={document} />;
}

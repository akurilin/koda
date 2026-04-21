// Workshop route: `/documents/:documentId/workshop/:blockId`.
//
// The workshop session's identity is encoded in the URL — which document,
// which block — rather than held as internal state. That gives us three
// things we didn't have with the modal-over-internal-state version:
//
//   1. The back button lands somewhere meaningful (the doc URL).
//   2. The workshop URL is shareable and reproducible across reloads.
//   3. Navigating directly to a dangling block id renders a 404 instead of
//      crashing, because we validate the block exists on the server first.
//
// The workshop's *client-side* state (version stack, chat history) still
// lives only in memory — the URL captures "which block is being
// workshopped", not the session contents.

import { notFound } from "next/navigation";
import { getDocument } from "@/src/server/documents/document-service";
import { DocumentWorkspace } from "@/app/components/document-workspace";

export const dynamic = "force-dynamic";

type WorkshopPageProps = {
  params: Promise<{
    documentId: string;
    blockId: string;
  }>;
};

export default async function WorkshopPage({ params }: WorkshopPageProps) {
  const { documentId, blockId } = await params;
  const document = await getDocument(documentId);

  if (!document) {
    notFound();
  }

  // If the block doesn't exist we 404 rather than silently falling back to
  // the main doc view — a stale workshop URL is better surfaced as "gone"
  // than as a confusing "nothing happened".
  if (!document.blocks.some((block) => block.id === blockId)) {
    notFound();
  }

  return (
    <DocumentWorkspace initialDocument={document} workshopBlockId={blockId} />
  );
}

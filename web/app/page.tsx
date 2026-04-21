// Homepage: redirects to the canonical document URL.
//
// We used to render the primary document inline at `/`, but that hid the
// document id and made back-navigation brittle (workshop mode couldn't
// point at a stable origin URL). Now `/` resolves to the primary
// document id and issues a permanent-ish redirect to
// `/documents/:primaryId`, so every view the user lands in has an
// explicit URL they can share or bookmark.

import { redirect } from "next/navigation";
import { getOrCreatePrimaryDocumentRecord } from "@/src/server/documents/document-repository";

export const dynamic = "force-dynamic";

export default async function Home() {
  const document = await getOrCreatePrimaryDocumentRecord();
  redirect(`/documents/${document.id}`);
}

import { redirect } from "next/navigation";
import { createDocument } from "@/src/server/documents/document-service";

export const dynamic = "force-dynamic";

export default async function Home() {
  const document = await createDocument({
    title: "Untitled article",
  });

  redirect(`/documents/${document.id}`);
}

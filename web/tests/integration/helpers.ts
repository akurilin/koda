import { randomUUID } from "node:crypto";
import { sql } from "@/src/server/db/postgres";

export function createTestRunId() {
  return randomUUID();
}

export async function cleanupTestRun(testRunId: string) {
  await sql`
    DELETE FROM documents
    WHERE test_run_id = ${testRunId}
  `;
}

// Shared postgres.js client used by every server-side caller.
//
// Exporting a single module-scoped client means Next.js's route handlers all
// share one pool rather than each lambda-like invocation opening its own
// connections, which matters in local dev (Supabase default connection
// limits) and becomes critical once this is deployed.

import postgres from "postgres";

// Matches the `supabase start` defaults so developers don't need to set
// DATABASE_URL locally. Production always overrides via env.
const defaultLocalDatabaseUrl =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const databaseUrl = process.env.DATABASE_URL ?? defaultLocalDatabaseUrl;

// `prepare: false` — Supabase's PgBouncer (transaction pooler) doesn't
// support server-side prepared statements, and tripping over that only
// surfaces in prod. Keeping it off everywhere matches the prod topology.
//
// `idle_timeout: 1` keeps the pool small during dev hot reloads so we don't
// hold a lingering connection across module reloads.
export const sql = postgres(databaseUrl, {
  max: Number(process.env.DATABASE_MAX_CONNECTIONS ?? 5),
  idle_timeout: 1,
  prepare: false,
});

/**
 * Graceful shutdown hook — used by integration tests that spin up and tear
 * down database work in the same process. Production runtime relies on
 * process exit rather than calling this explicitly.
 */
export async function closeDatabaseConnection() {
  await sql.end({ timeout: 5 });
}

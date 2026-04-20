import postgres from "postgres";

const defaultLocalDatabaseUrl =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const databaseUrl = process.env.DATABASE_URL ?? defaultLocalDatabaseUrl;

export const sql = postgres(databaseUrl, {
  max: Number(process.env.DATABASE_MAX_CONNECTIONS ?? 5),
  idle_timeout: 1,
  prepare: false,
});

export async function closeDatabaseConnection() {
  await sql.end({ timeout: 5 });
}

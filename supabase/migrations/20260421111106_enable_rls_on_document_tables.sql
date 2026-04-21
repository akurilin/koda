-- Lock down the PostgREST surface on the `public` schema tables.
--
-- The Next.js server talks to Postgres as the `postgres` superuser, which
-- bypasses RLS, so the app is unaffected. With RLS on and no policies, the
-- `anon` and `authenticated` roles cannot read or write — which is what we
-- want by default for any table in `public` that PostgREST auto-exposes.

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_blocks ENABLE ROW LEVEL SECURITY;

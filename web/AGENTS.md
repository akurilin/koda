<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Database

- Use standard Supabase for local and production Postgres workflows.
- Manage schema changes through Supabase migrations in `../supabase/migrations/`; do not introduce a separate migration tracker unless explicitly requested.
- Create and apply Supabase migrations with the Supabase CLI. Do not hand-apply migration SQL directly to local or remote databases, because that bypasses Supabase's migration tracking.
- Follow PostgreSQL's documented SQL identifier conventions: use unquoted, lower-case identifiers with underscores for tables, columns, indexes, constraints, functions, and schemas.
- Write SQL key words in upper case and database object names in lower case, matching the convention shown in the PostgreSQL lexical structure documentation.
- Avoid quoted identifiers for application schema objects. Quoted identifiers are case-sensitive in PostgreSQL, while unquoted identifiers are folded to lower case.
- Keep identifiers within PostgreSQL's default 63-byte identifier length limit.

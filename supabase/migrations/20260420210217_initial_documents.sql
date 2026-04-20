CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL DEFAULT '',
  test_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_blocks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_block_id TEXT REFERENCES document_blocks(id) ON DELETE CASCADE,
  sort_index INTEGER NOT NULL,
  block_type TEXT NOT NULL,
  content_format TEXT NOT NULL DEFAULT 'blocknote_v1',
  block_json JSONB NOT NULL,
  plain_text TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT document_blocks_sort_index_check CHECK (sort_index >= 0),
  CONSTRAINT document_blocks_revision_check CHECK (revision >= 1),
  CONSTRAINT document_blocks_content_format_check CHECK (
    content_format = 'blocknote_v1'
  ),
  CONSTRAINT document_blocks_block_type_check CHECK (
    block_type IN (
      'paragraph',
      'heading',
      'quote',
      'codeBlock',
      'bulletListItem',
      'numberedListItem',
      'checkListItem'
    )
  )
);

CREATE UNIQUE INDEX document_blocks_top_level_sort_index_key
  ON document_blocks (document_id, sort_index)
  WHERE parent_block_id IS NULL;

CREATE UNIQUE INDEX document_blocks_child_sort_index_key
  ON document_blocks (document_id, parent_block_id, sort_index)
  WHERE parent_block_id IS NOT NULL;

CREATE INDEX document_blocks_document_id_sort_index_idx
  ON document_blocks (document_id, sort_index);

CREATE INDEX documents_test_run_id_idx
  ON documents (test_run_id)
  WHERE test_run_id IS NOT NULL;

CREATE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON documents
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER document_blocks_set_updated_at
BEFORE UPDATE ON document_blocks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

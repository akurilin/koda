-- Drop the nested-block scaffolding. The editor only ever works with a flat
-- list of top-level blocks, and no row has ever had a non-null
-- `parent_block_id`, so keeping the column and its partial unique indexes just
-- invited confusion about which representation of nesting was authoritative.

DROP INDEX IF EXISTS document_blocks_top_level_sort_index_key;
DROP INDEX IF EXISTS document_blocks_child_sort_index_key;

ALTER TABLE document_blocks
  DROP COLUMN parent_block_id;

CREATE UNIQUE INDEX document_blocks_document_id_sort_index_key
  ON document_blocks (document_id, sort_index);

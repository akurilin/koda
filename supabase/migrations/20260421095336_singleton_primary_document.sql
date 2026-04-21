DELETE FROM documents
WHERE test_run_id IS NULL;

CREATE UNIQUE INDEX documents_primary_singleton_key
  ON documents ((TRUE))
  WHERE test_run_id IS NULL;

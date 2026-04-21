-- Per-block freeform feedback authored by the main-editor agent.
--
-- The agent uses this column (via a dedicated `setBlockFeedback` tool) to
-- attach open-ended critique to individual blocks during a whole-article
-- review — e.g. "this paragraph is too long" or "these questions repeat".
-- The client renders a visual marker next to any block whose feedback is
-- not null and primes workshop mode with the stored text.
--
-- Deliberately a nullable plain TEXT column rather than JSONB: today the
-- payload is always a single string of prose. If we later want structure
-- (categories, severity, review timestamps, multiple reviewers) we can
-- migrate to JSONB at that point; premature structure now would widen
-- the read/write surface with no caller that benefits.
--
-- Feedback is a side-channel to block content. It does not participate in
-- the `revision` optimistic-concurrency check and must not be mutated on
-- the whole-document sync path (the client's autosave would otherwise
-- clobber agent-authored feedback). Writes come from two code paths:
--   - the `setBlockFeedback` agent tool (targeted UPDATE);
--   - the `replaceBlock` service function, which clears feedback on
--     workshop save to mark it resolved.

ALTER TABLE document_blocks
  ADD COLUMN agent_feedback TEXT;

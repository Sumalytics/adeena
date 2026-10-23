ALTER TABLE source_spans
  ADD COLUMN generation_excerpt text
  CHECK (generation_excerpt IS NULL OR char_length(generation_excerpt) BETWEEN 1 AND 1200);

COMMENT ON COLUMN source_spans.generation_excerpt IS
  'Private bounded generator context derived from the same canonical text offsets as excerpt; never learner-facing.';

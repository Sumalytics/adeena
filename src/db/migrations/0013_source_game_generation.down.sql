DROP POLICY IF EXISTS experience_generation_costs_update ON experience_generation_costs;
REVOKE UPDATE ON experience_generation_costs FROM adeena_app;
ALTER TABLE experience_generation_costs
  DROP COLUMN IF EXISTS execution_mode, DROP COLUMN IF EXISTS cached_input_tokens,
  DROP COLUMN IF EXISTS reasoning_tokens, DROP COLUMN IF EXISTS commercial_estimate_micros,
  DROP COLUMN IF EXISTS model_calls;
-- Retain valid slash-containing historical model names in the relaxed model check.

DROP TABLE IF EXISTS adeena_free_quota;

ALTER TABLE IF EXISTS experience_edit_costs DROP COLUMN IF EXISTS remaining_tokens;
ALTER TABLE IF EXISTS experience_edit_costs DROP COLUMN IF EXISTS remaining_requests;
ALTER TABLE IF EXISTS experience_edit_costs DROP COLUMN IF EXISTS latency_ms;
ALTER TABLE IF EXISTS experience_edit_costs DROP COLUMN IF EXISTS commercial_estimate_micros;
ALTER TABLE IF EXISTS experience_edit_costs DROP COLUMN IF EXISTS execution_mode;

DELETE FROM experience_edit_costs WHERE model !~ '^[a-z0-9@.:-]{1,80}$';
ALTER TABLE experience_edit_costs DROP CONSTRAINT IF EXISTS experience_edit_costs_model_check;
ALTER TABLE experience_edit_costs
  ADD CONSTRAINT experience_edit_costs_model_check CHECK (model ~ '^[a-z0-9@.:-]{1,80}$');

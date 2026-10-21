ALTER TABLE IF EXISTS experience_edit_costs DROP COLUMN IF EXISTS provider_response_id;
ALTER TABLE IF EXISTS experience_edit_costs DROP COLUMN IF EXISTS reasoning_tokens;
ALTER TABLE IF EXISTS experience_edit_costs DROP COLUMN IF EXISTS cached_input_tokens;
DROP TABLE IF EXISTS adeena_edit_spend;

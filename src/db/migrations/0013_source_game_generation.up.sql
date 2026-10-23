-- Extend existing usage records for source planning and independent plan review.
ALTER TABLE experience_generation_costs DROP CONSTRAINT experience_generation_costs_model_check;
ALTER TABLE experience_generation_costs ADD CONSTRAINT experience_generation_costs_model_check CHECK (model ~ '^[a-z0-9@.:/-]{1,80}$');
ALTER TABLE experience_generation_costs
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'fixture' CHECK (execution_mode IN ('fixture','paid-development','free-development')),
  ADD COLUMN cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  ADD COLUMN reasoning_tokens integer NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  ADD COLUMN commercial_estimate_micros integer CHECK (commercial_estimate_micros >= 0),
  ADD COLUMN model_calls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(model_calls) = 'array');
CREATE POLICY experience_generation_costs_update ON experience_generation_costs FOR UPDATE
  USING (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id())
  WITH CHECK (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id());
GRANT UPDATE ON experience_generation_costs TO adeena_app;

CREATE TABLE adeena_edit_spend (
  id text PRIMARY KEY CHECK (id = 'development'),
  reserved_micros integer NOT NULL CHECK (reserved_micros >= 0 AND reserved_micros <= 2000000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO adeena_edit_spend (id, reserved_micros) VALUES ('development', 0);

ALTER TABLE adeena_edit_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE adeena_edit_spend FORCE ROW LEVEL SECURITY;

CREATE POLICY adeena_edit_spend_select ON adeena_edit_spend
  FOR SELECT USING (adeena.current_user_id() IS NOT NULL);
CREATE POLICY adeena_edit_spend_update ON adeena_edit_spend
  FOR UPDATE USING (adeena.current_user_id() IS NOT NULL)
  WITH CHECK (adeena.current_user_id() IS NOT NULL);

REVOKE ALL ON adeena_edit_spend FROM PUBLIC;
GRANT SELECT, UPDATE ON adeena_edit_spend TO adeena_app;

ALTER TABLE experience_edit_costs
  ADD COLUMN cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  ADD COLUMN reasoning_tokens integer NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  ADD COLUMN provider_response_id text CHECK (provider_response_id IS NULL OR provider_response_id ~ '^[A-Za-z0-9_-]{1,80}$');

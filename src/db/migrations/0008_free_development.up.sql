ALTER TABLE experience_edit_costs DROP CONSTRAINT experience_edit_costs_model_check;
ALTER TABLE experience_edit_costs
  ADD CONSTRAINT experience_edit_costs_model_check CHECK (model ~ '^[a-z0-9@.:/-]{1,80}$');

ALTER TABLE experience_edit_costs
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'fixture' CHECK (execution_mode IN ('fixture', 'paid-development', 'free-development')),
  ADD COLUMN commercial_estimate_micros integer CHECK (commercial_estimate_micros IS NULL OR (commercial_estimate_micros >= 0 AND commercial_estimate_micros <= 2000000000)),
  ADD COLUMN latency_ms integer CHECK (latency_ms IS NULL OR (latency_ms >= 0 AND latency_ms <= 600000)),
  ADD COLUMN remaining_requests integer CHECK (remaining_requests IS NULL OR (remaining_requests >= 0 AND remaining_requests <= 2000000000)),
  ADD COLUMN remaining_tokens integer CHECK (remaining_tokens IS NULL OR (remaining_tokens >= 0 AND remaining_tokens <= 2000000000));

CREATE TABLE adeena_free_quota (
  id text PRIMARY KEY CHECK (id = 'development'),
  session_id text NOT NULL CHECK (session_id ~ '^[0-9a-f-]{36}$'),
  session_requests integer NOT NULL CHECK (session_requests >= 0 AND session_requests <= 5),
  day_requests integer NOT NULL CHECK (day_requests >= 0 AND day_requests <= 10),
  usage_day date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO adeena_free_quota (id, session_id, session_requests, day_requests, usage_day)
VALUES ('development', '00000000-0000-4000-8000-000000000000', 0, 0, DATE '1970-01-01');

ALTER TABLE adeena_free_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE adeena_free_quota FORCE ROW LEVEL SECURITY;

CREATE POLICY adeena_free_quota_select ON adeena_free_quota
  FOR SELECT USING (adeena.current_user_id() IS NOT NULL);
CREATE POLICY adeena_free_quota_update ON adeena_free_quota
  FOR UPDATE USING (adeena.current_user_id() IS NOT NULL)
  WITH CHECK (adeena.current_user_id() IS NOT NULL);

REVOKE ALL ON adeena_free_quota FROM PUBLIC;
GRANT SELECT, UPDATE ON adeena_free_quota TO adeena_app;

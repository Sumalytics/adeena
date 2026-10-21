CREATE TABLE experience_generation_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  topic_candidate_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  audience_label text NOT NULL CHECK (char_length(audience_label) BETWEEN 1 AND 80),
  age_band text NOT NULL CHECK (age_band IN ('5-7', '8-10', '11-13', '14-18', 'adult', 'unspecified')),
  compiler_version text NOT NULL CHECK (compiler_version = '1'),
  prompt_version text NOT NULL CHECK (prompt_version ~ '^[a-z0-9@.-]{1,40}$'),
  provider text NOT NULL CHECK (provider IN ('deterministic-fixture', 'configured-provider')),
  status text NOT NULL CHECK (status IN ('queued', 'planning', 'compiling', 'validating', 'ready', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 3),
  lease_owner text CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9-]{1,80}$'),
  lease_expires_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9-]{1,80}$'),
  permanent boolean NOT NULL DEFAULT false,
  review_status text CHECK (review_status IS NULL OR review_status IN ('ready-for-review', 'review-required')),
  experience_version_id uuid,
  source_chars integer NOT NULL DEFAULT 0 CHECK (source_chars >= 0),
  compile_ms integer CHECK (compile_ms IS NULL OR compile_ms >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id),
  FOREIGN KEY (topic_candidate_id, workspace_id) REFERENCES topic_candidates (id, workspace_id)
);

CREATE INDEX experience_generation_jobs_document_idx ON experience_generation_jobs (workspace_id, document_version_id);

CREATE TABLE experience_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  topic_candidate_id uuid NOT NULL,
  job_id uuid NOT NULL,
  experience_id uuid NOT NULL,
  compiler_version text NOT NULL CHECK (compiler_version = '1'),
  prompt_version text NOT NULL CHECK (prompt_version ~ '^[a-z0-9@.-]{1,40}$'),
  source_span_ids jsonb NOT NULL CHECK (jsonb_typeof(source_span_ids) = 'array'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  publication_status text NOT NULL DEFAULT 'unpublished' CHECK (publication_status = 'unpublished'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id),
  FOREIGN KEY (topic_candidate_id, workspace_id) REFERENCES topic_candidates (id, workspace_id),
  FOREIGN KEY (job_id, workspace_id) REFERENCES experience_generation_jobs (id, workspace_id)
);

CREATE INDEX experience_versions_workspace_idx ON experience_versions (workspace_id, created_at DESC);

ALTER TABLE experience_generation_jobs
  ADD CONSTRAINT experience_generation_jobs_version_fk
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id);

CREATE FUNCTION adeena.reject_experience_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'experience versions are immutable';
END;
$$;

CREATE TRIGGER experience_versions_immutable
BEFORE UPDATE OR DELETE ON experience_versions
FOR EACH ROW EXECUTE FUNCTION adeena.reject_experience_version_mutation();

CREATE TABLE experience_plans (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  experience_version_id uuid,
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (job_id, workspace_id) REFERENCES experience_generation_jobs (id, workspace_id),
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id)
);

CREATE TABLE experience_validation_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  experience_version_id uuid,
  ok boolean NOT NULL,
  diagnostics jsonb NOT NULL CHECK (jsonb_typeof(diagnostics) = 'object'),
  simulation jsonb NOT NULL CHECK (jsonb_typeof(simulation) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id),
  FOREIGN KEY (job_id, workspace_id) REFERENCES experience_generation_jobs (id, workspace_id),
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id)
);

CREATE TABLE experience_generation_costs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('deterministic-fixture', 'configured-provider')),
  model text NOT NULL CHECK (model ~ '^[a-z0-9@.:-]{1,80}$'),
  pricing_version text NOT NULL CHECK (pricing_version ~ '^[a-z0-9@.-]{1,40}$'),
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  call_count integer NOT NULL CHECK (call_count >= 0),
  retry_count integer NOT NULL CHECK (retry_count >= 0),
  estimated_cost_micros integer CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros >= 0),
  actual_cost_micros integer CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  usage_kind text NOT NULL CHECK (usage_kind IN ('actual', 'estimate', 'none')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id),
  FOREIGN KEY (job_id, workspace_id) REFERENCES experience_generation_jobs (id, workspace_id)
);

ALTER TABLE experience_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_generation_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE experience_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE experience_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE experience_validation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_validation_results FORCE ROW LEVEL SECURITY;
ALTER TABLE experience_generation_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_generation_costs FORCE ROW LEVEL SECURITY;

CREATE POLICY experience_generation_jobs_select ON experience_generation_jobs FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_generation_jobs_insert ON experience_generation_jobs FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id()
);
CREATE POLICY experience_generation_jobs_update ON experience_generation_jobs FOR UPDATE
  USING (adeena.is_active_member(workspace_id))
  WITH CHECK (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id());

CREATE POLICY experience_versions_select ON experience_versions FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_versions_insert ON experience_versions FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id()
);

CREATE POLICY experience_plans_select ON experience_plans FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_plans_insert ON experience_plans FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id()
);

CREATE POLICY experience_validation_results_select ON experience_validation_results FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_validation_results_insert ON experience_validation_results FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id()
);

CREATE POLICY experience_generation_costs_select ON experience_generation_costs FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_generation_costs_insert ON experience_generation_costs FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id()
);

REVOKE ALL ON experience_generation_jobs, experience_versions, experience_plans, experience_validation_results, experience_generation_costs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON experience_generation_jobs TO adeena_app;
GRANT SELECT, INSERT ON experience_versions, experience_plans, experience_validation_results, experience_generation_costs TO adeena_app;
REVOKE ALL ON FUNCTION adeena.reject_experience_version_mutation() FROM PUBLIC;

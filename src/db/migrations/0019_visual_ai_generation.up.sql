CREATE TABLE visual_generation_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  experience_version_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'configured-provider'),
  status text NOT NULL CHECK (status IN ('queued','planning','reviewing','ready','unsupported','failed')),
  prompt_version text NOT NULL CHECK (prompt_version ~ '^[a-z0-9@.-]{1,40}$'),
  review_prompt_version text NOT NULL CHECK (review_prompt_version ~ '^[a-z0-9@.-]{1,40}$'),
  instructional_plan jsonb CHECK (instructional_plan IS NULL OR jsonb_typeof(instructional_plan) = 'object'),
  model_review jsonb CHECK (model_review IS NULL OR jsonb_typeof(model_review) = 'object'),
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(diagnostics) = 'array'),
  association_id uuid,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9.-]{1,80}$'),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, experience_version_id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions(id, workspace_id),
  FOREIGN KEY (association_id, workspace_id, experience_version_id)
    REFERENCES visual_experience_blueprints(id, workspace_id, experience_version_id)
);

CREATE TABLE visual_generation_costs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  model text NOT NULL CHECK (model ~ '^[a-z0-9@.:/-]{1,80}$'),
  pricing_version text NOT NULL CHECK (pricing_version ~ '^[a-z0-9@.-]{1,80}$'),
  execution_mode text NOT NULL CHECK (execution_mode IN ('paid-development','free-development')),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reasoning_tokens integer NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  call_count integer NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  reserved_cost_micros integer NOT NULL CHECK (reserved_cost_micros >= 0),
  actual_cost_micros integer CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  commercial_estimate_micros integer CHECK (commercial_estimate_micros IS NULL OR commercial_estimate_micros >= 0),
  usage_kind text NOT NULL CHECK (usage_kind IN ('actual','estimate','none')),
  model_calls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(model_calls) = 'array'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id),
  FOREIGN KEY (job_id, workspace_id) REFERENCES visual_generation_jobs(id, workspace_id)
);

ALTER TABLE visual_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE visual_generation_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE visual_generation_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE visual_generation_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY visual_generation_jobs_member ON visual_generation_jobs USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id());
CREATE POLICY visual_generation_costs_member ON visual_generation_costs USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id());
REVOKE ALL ON visual_generation_jobs, visual_generation_costs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON visual_generation_jobs, visual_generation_costs TO adeena_app;

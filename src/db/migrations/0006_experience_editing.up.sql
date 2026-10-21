ALTER TABLE experience_versions ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE experience_versions ADD COLUMN parent_version_id uuid;
ALTER TABLE experience_versions ADD COLUMN edit_job_id uuid;
ALTER TABLE experience_versions ADD CONSTRAINT experience_versions_origin_check CHECK (
  (job_id IS NOT NULL AND parent_version_id IS NULL AND edit_job_id IS NULL)
  OR (job_id IS NULL AND parent_version_id IS NOT NULL AND edit_job_id IS NOT NULL)
);
ALTER TABLE experience_versions ADD CONSTRAINT experience_versions_parent_fk
  FOREIGN KEY (parent_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id);

CREATE TABLE experience_edit_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  experience_id uuid NOT NULL,
  base_version_id uuid NOT NULL,
  expected_base_version_id uuid NOT NULL,
  proposed_version_id uuid,
  idempotency_key uuid NOT NULL,
  instruction text NOT NULL CHECK (char_length(instruction) BETWEEN 1 AND 500),
  scene_id text CHECK (scene_id IS NULL OR scene_id ~ '^[a-z][a-z0-9-]{0,40}$'),
  status text NOT NULL CHECK (status IN (
    'requested', 'planning', 'proposed', 'validating', 'ready', 'accepted', 'rejected', 'failed', 'expired'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 3),
  lease_owner text CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9-]{1,80}$'),
  lease_expires_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9-]{1,80}$'),
  permanent boolean NOT NULL DEFAULT false,
  review_status text CHECK (review_status IS NULL OR review_status IN ('ready-for-review', 'review-required')),
  provider text NOT NULL CHECK (provider IN ('deterministic-fixture', 'configured-provider')),
  prompt_version text NOT NULL CHECK (prompt_version ~ '^[a-z0-9@.-]{1,40}$'),
  compiler_version text NOT NULL CHECK (compiler_version = '1'),
  edit_policy_version text NOT NULL CHECK (edit_policy_version = '1'),
  intent text CHECK (intent IS NULL OR char_length(intent) BETWEEN 1 AND 200),
  plan jsonb CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),
  patch jsonb CHECK (patch IS NULL OR jsonb_typeof(patch) = 'object'),
  validation jsonb CHECK (validation IS NULL OR jsonb_typeof(validation) = 'object'),
  summary text CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 300),
  graph_changed boolean,
  uncertainty text CHECK (uncertainty IS NULL OR char_length(uncertainty) BETWEEN 1 AND 300),
  review_note text CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 200),
  scenes_touched integer CHECK (scenes_touched IS NULL OR scenes_touched >= 0),
  choices_changed integer CHECK (choices_changed IS NULL OR choices_changed >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id),
  CONSTRAINT experience_edit_jobs_base_fk FOREIGN KEY (base_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id),
  CONSTRAINT experience_edit_jobs_expected_fk FOREIGN KEY (expected_base_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id)
);

CREATE INDEX experience_edit_jobs_experience_idx ON experience_edit_jobs (workspace_id, experience_id, created_at DESC);

ALTER TABLE experience_versions ADD CONSTRAINT experience_versions_edit_fk
  FOREIGN KEY (edit_job_id, workspace_id) REFERENCES experience_edit_jobs (id, workspace_id);
ALTER TABLE experience_edit_jobs ADD CONSTRAINT experience_edit_jobs_version_fk
  FOREIGN KEY (proposed_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id);

CREATE TABLE experience_current_drafts (
  workspace_id uuid NOT NULL,
  experience_id uuid NOT NULL,
  version_id uuid NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, experience_id),
  FOREIGN KEY (version_id, workspace_id) REFERENCES experience_versions (id, workspace_id)
);

CREATE TABLE experience_edit_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  edit_job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'requested', 'planning', 'proposed', 'validating', 'ready', 'accepted', 'rejected', 'failed', 'expired'
  )),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 300),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (edit_job_id, workspace_id) REFERENCES experience_edit_jobs (id, workspace_id)
);

CREATE TABLE experience_edit_costs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  edit_job_id uuid NOT NULL,
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
  UNIQUE (edit_job_id),
  FOREIGN KEY (edit_job_id, workspace_id) REFERENCES experience_edit_jobs (id, workspace_id)
);

ALTER TABLE experience_edit_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_edit_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE experience_current_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_current_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE experience_edit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_edit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE experience_edit_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_edit_costs FORCE ROW LEVEL SECURITY;

CREATE POLICY experience_edit_jobs_select ON experience_edit_jobs FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_edit_jobs_insert ON experience_edit_jobs FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id()
);
CREATE POLICY experience_edit_jobs_update ON experience_edit_jobs FOR UPDATE
  USING (adeena.is_active_member(workspace_id))
  WITH CHECK (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id());

CREATE POLICY experience_current_drafts_select ON experience_current_drafts FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_current_drafts_insert ON experience_current_drafts FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND updated_by = adeena.current_user_id()
);
CREATE POLICY experience_current_drafts_update ON experience_current_drafts FOR UPDATE
  USING (adeena.is_active_member(workspace_id))
  WITH CHECK (adeena.is_active_member(workspace_id) AND updated_by = adeena.current_user_id());

CREATE POLICY experience_edit_events_select ON experience_edit_events FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_edit_events_insert ON experience_edit_events FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id()
);

CREATE POLICY experience_edit_costs_select ON experience_edit_costs FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_edit_costs_insert ON experience_edit_costs FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id()
);
CREATE POLICY experience_edit_costs_update ON experience_edit_costs FOR UPDATE
  USING (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id())
  WITH CHECK (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id());

REVOKE ALL ON experience_edit_jobs, experience_current_drafts, experience_edit_events, experience_edit_costs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON experience_edit_jobs, experience_current_drafts TO adeena_app;
GRANT SELECT, INSERT ON experience_edit_events TO adeena_app;
GRANT SELECT, INSERT, UPDATE ON experience_edit_costs TO adeena_app;

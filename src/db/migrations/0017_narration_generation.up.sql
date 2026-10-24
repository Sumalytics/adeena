CREATE TABLE narration_development_budgets (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  charged_micros bigint NOT NULL DEFAULT 0 CHECK (charged_micros >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE narration_generation_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  experience_version_id uuid NOT NULL,
  narration_segment_id text NOT NULL CHECK (narration_segment_id ~ '^[a-z][a-z0-9-]{0,40}$'),
  idempotency_key uuid NOT NULL,
  approved_script text NOT NULL CHECK (char_length(btrim(approved_script)) BETWEEN 1 AND 600),
  script_hash text NOT NULL CHECK (script_hash ~ '^[a-f0-9]{64}$'),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL,
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  voice_profile_ref text NOT NULL CHECK (char_length(btrim(voice_profile_ref)) BETWEEN 1 AND 120),
  voice_style text NOT NULL CHECK (voice_style IN ('calm', 'warm', 'energetic')),
  speaking_rate numeric(3,2) NOT NULL CHECK (speaking_rate BETWEEN 0.8 AND 1.2),
  cue_ids jsonb NOT NULL CHECK (jsonb_typeof(cue_ids) = 'array'),
  cache_key text NOT NULL CHECK (cache_key ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('fake', 'azure-speech')),
  model text NOT NULL CHECK (model ~ '^[a-z0-9@.-]{1,80}$'),
  pricing_version text NOT NULL CHECK (pricing_version ~ '^[a-z0-9@.-]{1,80}$'),
  output_format text NOT NULL CHECK (char_length(output_format) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 2),
  lease_owner text CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9-]{1,80}$'),
  lease_expires_at timestamptz,
  provider_started_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9-]{1,80}$'),
  uncertain_charge boolean NOT NULL DEFAULT false,
  audio_asset_id uuid REFERENCES private_audio_assets(id),
  playback_metadata jsonb CHECK (playback_metadata IS NULL OR jsonb_typeof(playback_metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions(id, workspace_id)
);
CREATE INDEX narration_jobs_queue_idx ON narration_generation_jobs(workspace_id, status, created_at);
CREATE INDEX narration_jobs_segment_idx ON narration_generation_jobs(workspace_id, experience_version_id, narration_segment_id);

CREATE TABLE narration_audio_cache (
  workspace_id uuid NOT NULL,
  cache_key text NOT NULL CHECK (cache_key ~ '^[a-f0-9]{64}$'),
  audio_asset_id uuid NOT NULL REFERENCES private_audio_assets(id),
  playback_metadata jsonb NOT NULL CHECK (jsonb_typeof(playback_metadata) = 'object'),
  created_by_job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, cache_key),
  FOREIGN KEY (created_by_job_id, workspace_id) REFERENCES narration_generation_jobs(id, workspace_id)
);

CREATE TABLE narration_cache_claims (
  workspace_id uuid NOT NULL,
  cache_key text NOT NULL CHECK (cache_key ~ '^[a-f0-9]{64}$'),
  job_id uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  provider_started_at timestamptz,
  PRIMARY KEY (workspace_id, cache_key),
  FOREIGN KEY (job_id, workspace_id) REFERENCES narration_generation_jobs(id, workspace_id)
);

CREATE TABLE narration_generation_costs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  experience_version_id uuid NOT NULL,
  narration_segment_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('fake', 'azure-speech')),
  model text NOT NULL,
  pricing_version text NOT NULL,
  billable_characters integer NOT NULL CHECK (billable_characters >= 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  cache_status text NOT NULL CHECK (cache_status IN ('hit', 'miss')),
  estimated_cost_micros bigint NOT NULL CHECK (estimated_cost_micros >= 0),
  actual_cost_micros bigint CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  uncertain_charge boolean NOT NULL DEFAULT false,
  currency text NOT NULL CHECK (currency = 'USD'),
  audio_duration_ms integer CHECK (audio_duration_ms IS NULL OR audio_duration_ms > 0),
  audio_bytes integer CHECK (audio_bytes IS NULL OR audio_bytes > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (job_id, attempt),
  FOREIGN KEY (job_id, workspace_id) REFERENCES narration_generation_jobs(id, workspace_id),
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions(id, workspace_id)
);

ALTER TABLE narration_development_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE narration_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE narration_audio_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE narration_cache_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE narration_generation_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE narration_development_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE narration_generation_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE narration_audio_cache FORCE ROW LEVEL SECURITY;
ALTER TABLE narration_cache_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE narration_generation_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY narration_budget_member ON narration_development_budgets USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id));
CREATE POLICY narration_jobs_member ON narration_generation_jobs USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id));
CREATE POLICY narration_cache_member ON narration_audio_cache USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id));
CREATE POLICY narration_claims_member ON narration_cache_claims USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id));
CREATE POLICY narration_costs_member ON narration_generation_costs USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id));

REVOKE ALL ON narration_development_budgets, narration_generation_jobs, narration_audio_cache, narration_cache_claims, narration_generation_costs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON narration_development_budgets, narration_generation_jobs, narration_cache_claims, narration_generation_costs TO adeena_app;
GRANT SELECT, INSERT ON narration_audio_cache TO adeena_app;
GRANT DELETE ON narration_cache_claims TO adeena_app;

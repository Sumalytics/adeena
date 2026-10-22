CREATE TABLE creator_workflows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  created_by uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  document_version_id uuid,
  audience_label text,
  age_band text,
  recommendation_run_id uuid,
  recommendation_idempotency_key uuid,
  selected_topic_candidate_id uuid,
  generation_idempotency_key uuid,
  generation_job_id uuid,
  experience_version_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT creator_workflows_audience_pair_check CHECK (
    (audience_label IS NULL AND age_band IS NULL)
    OR (
      audience_label IS NOT NULL
      AND age_band IS NOT NULL
      AND char_length(audience_label) BETWEEN 1 AND 80
      AND age_band IN ('5-7', '8-10', '11-13', '14-18', 'adult', 'unspecified')
    )
  ),
  CONSTRAINT creator_workflows_topic_source_check CHECK (
    selected_topic_candidate_id IS NULL OR document_version_id IS NOT NULL
  ),
  CONSTRAINT creator_workflows_recommendation_context_check CHECK (
    recommendation_run_id IS NULL OR (document_version_id IS NOT NULL AND audience_label IS NOT NULL)
  ),
  CONSTRAINT creator_workflows_generation_context_check CHECK (
    (generation_idempotency_key IS NULL AND generation_job_id IS NULL)
    OR (
      generation_idempotency_key IS NOT NULL
      AND document_version_id IS NOT NULL
      AND audience_label IS NOT NULL
      AND selected_topic_candidate_id IS NOT NULL
    )
  ),
  CONSTRAINT creator_workflows_version_pointer_check CHECK (
    experience_version_id IS NULL OR generation_job_id IS NOT NULL
  ),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id),
  FOREIGN KEY (recommendation_run_id, workspace_id) REFERENCES recommendation_runs (id, workspace_id),
  FOREIGN KEY (selected_topic_candidate_id, workspace_id) REFERENCES topic_candidates (id, workspace_id),
  FOREIGN KEY (generation_job_id, workspace_id) REFERENCES experience_generation_jobs (id, workspace_id),
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id)
);

CREATE INDEX creator_workflows_workspace_updated_idx ON creator_workflows (workspace_id, updated_at DESC);
CREATE INDEX creator_workflows_generation_job_idx ON creator_workflows (workspace_id, generation_job_id) WHERE generation_job_id IS NOT NULL;
CREATE INDEX creator_workflows_experience_version_idx ON creator_workflows (workspace_id, experience_version_id) WHERE experience_version_id IS NOT NULL;

CREATE FUNCTION adeena.creator_workflow_references_match() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  run_document uuid;
  run_audience text;
  run_age text;
  topic_document uuid;
  job_document uuid;
  job_topic uuid;
  job_audience text;
  job_age text;
  job_key uuid;
  version_document uuid;
  version_job uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.generation_idempotency_key IS NOT NULL OR OLD.generation_job_id IS NOT NULL) THEN
    IF NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
      OR NEW.audience_label IS DISTINCT FROM OLD.audience_label
      OR NEW.age_band IS DISTINCT FROM OLD.age_band
      OR NEW.selected_topic_candidate_id IS DISTINCT FROM OLD.selected_topic_candidate_id
      OR NEW.recommendation_run_id IS DISTINCT FROM OLD.recommendation_run_id
    THEN
      RAISE EXCEPTION 'creator workflow selection is frozen' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.recommendation_run_id IS NOT NULL THEN
    SELECT document_version_id, audience_label, age_band
      INTO run_document, run_audience, run_age
      FROM recommendation_runs
      WHERE id = NEW.recommendation_run_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND
      OR run_document IS DISTINCT FROM NEW.document_version_id
      OR run_audience IS DISTINCT FROM NEW.audience_label
      OR run_age IS DISTINCT FROM NEW.age_band
    THEN
      RAISE EXCEPTION 'creator workflow recommendation does not match' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.selected_topic_candidate_id IS NOT NULL THEN
    SELECT document_version_id INTO topic_document
      FROM topic_candidates
      WHERE id = NEW.selected_topic_candidate_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND OR topic_document IS DISTINCT FROM NEW.document_version_id THEN
      RAISE EXCEPTION 'creator workflow topic does not match' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.generation_job_id IS NOT NULL THEN
    SELECT document_version_id, topic_candidate_id, audience_label, age_band, idempotency_key
      INTO job_document, job_topic, job_audience, job_age, job_key
      FROM experience_generation_jobs
      WHERE id = NEW.generation_job_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND
      OR job_document IS DISTINCT FROM NEW.document_version_id
      OR job_audience IS DISTINCT FROM NEW.audience_label
      OR job_age IS DISTINCT FROM NEW.age_band
      OR job_topic IS DISTINCT FROM NEW.selected_topic_candidate_id
      OR job_key IS DISTINCT FROM NEW.generation_idempotency_key
    THEN
      RAISE EXCEPTION 'creator workflow job does not match' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.experience_version_id IS NOT NULL THEN
    SELECT document_version_id, job_id INTO version_document, version_job
      FROM experience_versions
      WHERE id = NEW.experience_version_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND
      OR version_document IS DISTINCT FROM NEW.document_version_id
      OR version_job IS DISTINCT FROM NEW.generation_job_id
    THEN
      RAISE EXCEPTION 'creator workflow version does not match' USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER creator_workflows_references
BEFORE INSERT OR UPDATE ON creator_workflows
FOR EACH ROW EXECUTE FUNCTION adeena.creator_workflow_references_match();

ALTER TABLE creator_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_workflows FORCE ROW LEVEL SECURITY;

CREATE POLICY creator_workflows_select ON creator_workflows
  FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY creator_workflows_insert ON creator_workflows
  FOR INSERT WITH CHECK (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id());
CREATE POLICY creator_workflows_update ON creator_workflows
  FOR UPDATE USING (adeena.is_active_member(workspace_id))
  WITH CHECK (adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id());

REVOKE ALL ON creator_workflows FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON creator_workflows TO adeena_app;
REVOKE ALL ON FUNCTION adeena.creator_workflow_references_match() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adeena.creator_workflow_references_match() TO adeena_app;

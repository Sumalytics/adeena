-- Additive integrity rules. 0009 stays unchanged because it is already committed
-- and recorded on disposable databases. This replaces the trigger function in place.
CREATE OR REPLACE FUNCTION adeena.creator_workflow_references_match() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  run_document uuid;
  run_audience text;
  run_age text;
  run_active boolean;
  run_detection text;
  run_override integer;
  run_extraction uuid;
  current_override integer;
  current_extraction uuid;
  topic_eligibility text;
  topic_document uuid;
  topic_override integer;
  topic_extraction uuid;
  topic_detection text;
  job_document uuid;
  job_topic uuid;
  job_audience text;
  job_age text;
  job_key uuid;
  version_document uuid;
  version_job uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  ) THEN
    RAISE EXCEPTION 'creator workflow identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'creator workflow version must increase by one' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' AND NEW.version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'creator workflow version must start at one' USING ERRCODE = '23514';
  END IF;

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

  IF NEW.document_version_id IS NOT NULL THEN
    SELECT coalesce(max(version), 0) INTO current_override
      FROM topic_overrides
      WHERE workspace_id = NEW.workspace_id AND document_version_id = NEW.document_version_id;
    SELECT id INTO current_extraction
      FROM extraction_results
      WHERE workspace_id = NEW.workspace_id AND document_version_id = NEW.document_version_id
      ORDER BY completed_at DESC, id DESC
      LIMIT 1;
  END IF;

  IF NEW.recommendation_run_id IS NOT NULL THEN
    SELECT document_version_id, audience_label, age_band, active, detection_version, override_version, extraction_id
      INTO run_document, run_audience, run_age, run_active, run_detection, run_override, run_extraction
      FROM recommendation_runs
      WHERE id = NEW.recommendation_run_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND
      OR run_document IS DISTINCT FROM NEW.document_version_id
      OR run_audience IS DISTINCT FROM NEW.audience_label
      OR run_age IS DISTINCT FROM NEW.age_band
      OR run_active IS DISTINCT FROM true
      OR run_detection IS DISTINCT FROM '1'
      OR run_override IS DISTINCT FROM current_override
      OR current_extraction IS NULL
      OR run_extraction IS DISTINCT FROM current_extraction
    THEN
      RAISE EXCEPTION 'creator workflow recommendation does not match' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.selected_topic_candidate_id IS NOT NULL THEN
    IF NEW.recommendation_run_id IS NULL
      OR NEW.document_version_id IS NULL
      OR NEW.audience_label IS NULL
      OR NEW.age_band IS NULL
    THEN
      RAISE EXCEPTION 'creator workflow topic does not match' USING ERRCODE = '23514';
    END IF;
    SELECT eligibility, document_version_id, override_version, extraction_id, detection_version
      INTO topic_eligibility, topic_document, topic_override, topic_extraction, topic_detection
      FROM topic_candidates
      WHERE id = NEW.selected_topic_candidate_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND
      OR topic_document IS DISTINCT FROM NEW.document_version_id
      OR topic_eligibility IS DISTINCT FROM 'eligible'
      OR topic_detection IS DISTINCT FROM '1'
      OR topic_override IS DISTINCT FROM current_override
      OR topic_extraction IS DISTINCT FROM current_extraction
    THEN
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

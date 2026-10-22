CREATE OR REPLACE FUNCTION adeena.guard_release() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
      OR NEW.revoked_by IS DISTINCT FROM adeena.current_user_id()
      OR (to_jsonb(NEW) - 'revoked_at' - 'revoked_by') IS DISTINCT FROM
         (to_jsonb(OLD) - 'revoked_at' - 'revoked_by') THEN
      RAISE EXCEPTION 'release is immutable except for one-way revocation' USING ERRCODE = '23514';
    END IF;
    NEW.revoked_at := now();
    RETURN NEW;
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM experience_versions v
    JOIN source_document_versions d ON d.id = v.document_version_id AND d.workspace_id = v.workspace_id
    JOIN topic_candidates t ON t.id = v.topic_candidate_id AND t.workspace_id = v.workspace_id AND t.document_version_id = v.document_version_id
    LEFT JOIN experience_generation_jobs j ON j.id = v.job_id AND j.workspace_id = v.workspace_id
    LEFT JOIN experience_edit_jobs e ON e.id = v.edit_job_id AND e.workspace_id = v.workspace_id
    WHERE v.id = NEW.experience_version_id AND v.workspace_id = NEW.workspace_id
      AND d.rights_status = 'cleared' AND t.eligibility = 'eligible'
      AND NOT (t.reasons ?| ARRAY['review-required','sensitive-domain','unsafe-title','rights-blocked'])
      AND NOT EXISTS (
        SELECT 1 FROM recommendation_runs r WHERE r.workspace_id = v.workspace_id
          AND r.document_version_id = v.document_version_id AND r.active
          AND r.reasons ?| ARRAY['review-required','sensitive-domain','unsafe-title','rights-blocked']
      )
      AND (
        (j.status = 'ready' AND j.review_status = 'ready-for-review' AND j.experience_version_id = v.id AND EXISTS (
          SELECT 1 FROM experience_validation_results r WHERE r.experience_version_id = v.id
            AND r.workspace_id = v.workspace_id AND r.ok = true AND r.simulation @> '{"ok":true}'::jsonb
        ))
        OR (e.status = 'accepted' AND e.proposed_version_id = v.id AND e.review_status = 'ready-for-review'
          AND e.validation @> '{"ok":true,"simulation":{"ok":true}}'::jsonb)
      )
  ) THEN
    RAISE EXCEPTION 'publication denied' USING ERRCODE = '23514';
  END IF;
  NEW.published_at := now();
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS adeena.publication_blocks(uuid);
DROP TABLE IF EXISTS source_rights_clearances;

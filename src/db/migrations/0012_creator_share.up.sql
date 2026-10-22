-- Separate immutable, version-specific creator attestation; never a source rewrite.
CREATE TABLE source_rights_clearances (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  basis text NOT NULL CHECK (basis IN ('creator-owned', 'licensed')),
  evidence text NOT NULL CHECK (char_length(btrim(evidence)) BETWEEN 20 AND 2000),
  permits_public_adaptation boolean NOT NULL CHECK (permits_public_adaptation),
  recorded_by uuid NOT NULL DEFAULT adeena.current_user_id(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, document_version_id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions(id, workspace_id)
);
ALTER TABLE source_rights_clearances ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_rights_clearances FORCE ROW LEVEL SECURITY;
CREATE POLICY clearance_read ON source_rights_clearances FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY clearance_record ON source_rights_clearances FOR INSERT WITH CHECK (
  adeena.is_owner(workspace_id) AND recorded_by = adeena.current_user_id()
  AND EXISTS (SELECT 1 FROM source_document_versions d WHERE d.id = document_version_id
    AND d.workspace_id = source_rights_clearances.workspace_id AND d.rights_status = 'unverified')
);
REVOKE ALL ON source_rights_clearances FROM PUBLIC;
GRANT SELECT ON source_rights_clearances TO adeena_app;
GRANT INSERT (id, workspace_id, document_version_id, basis, evidence, permits_public_adaptation) ON source_rights_clearances TO adeena_app;

-- Shared authoritative eligibility for UI and the publication trigger.
-- Original generation reviewFor() uses only source rights for review_status.
-- The separate rights gate still requires clearance. Edit review is independent.
CREATE FUNCTION adeena.publication_blocks(version_id uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT array_remove(ARRAY[
    CASE WHEN NOT adeena.is_owner(v.workspace_id) THEN 'owner-required' END,
    CASE WHEN d.rights_status = 'blocked' THEN 'rights-blocked'
      WHEN d.rights_status <> 'cleared' AND c.id IS NULL THEN 'rights-clearance-required' END,
    CASE WHEN t.eligibility <> 'eligible' OR t.reasons ?| ARRAY['review-required','sensitive-domain','unsafe-title','rights-blocked']
      OR EXISTS (SELECT 1 FROM recommendation_runs r WHERE r.workspace_id = v.workspace_id
        AND r.document_version_id = v.document_version_id AND r.active
        AND r.reasons ?| ARRAY['review-required','sensitive-domain','unsafe-title','rights-blocked'])
      THEN 'independent-review-required' END,
    CASE WHEN NOT (
      (j.status = 'ready' AND j.experience_version_id = v.id AND
        (j.review_status = 'ready-for-review' OR
          (j.review_status = 'review-required' AND d.rights_status = 'unverified')))
      OR (e.status = 'accepted' AND e.proposed_version_id = v.id AND e.review_status = 'ready-for-review')
    ) IS TRUE THEN 'version-review-required' END,
    CASE WHEN NOT (
      (j.id IS NOT NULL AND EXISTS (SELECT 1 FROM experience_validation_results r
        WHERE r.experience_version_id = v.id AND r.workspace_id = v.workspace_id AND r.ok AND r.simulation @> '{"ok":true}'::jsonb))
      OR (e.id IS NOT NULL AND e.validation @> '{"ok":true,"simulation":{"ok":true}}'::jsonb)
    ) IS TRUE THEN 'validation-required' END
  ], NULL)
  FROM experience_versions v
  JOIN source_document_versions d ON d.id = v.document_version_id AND d.workspace_id = v.workspace_id
  JOIN topic_candidates t ON t.id = v.topic_candidate_id AND t.workspace_id = v.workspace_id AND t.document_version_id = v.document_version_id
  LEFT JOIN source_rights_clearances c ON c.document_version_id = d.id AND c.workspace_id = d.workspace_id
  LEFT JOIN experience_generation_jobs j ON j.id = v.job_id AND j.workspace_id = v.workspace_id
  LEFT JOIN experience_edit_jobs e ON e.id = v.edit_job_id AND e.workspace_id = v.workspace_id
  WHERE v.id = version_id), ARRAY['version-unavailable']::text[])
$$;
REVOKE ALL ON FUNCTION adeena.publication_blocks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adeena.publication_blocks(uuid) TO adeena_app;

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
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR cardinality(adeena.publication_blocks(NEW.experience_version_id)) > 0 THEN
    RAISE EXCEPTION 'publication denied' USING ERRCODE = '23514';
  END IF;
  NEW.published_at := now();
  RETURN NEW;
END;
$$;

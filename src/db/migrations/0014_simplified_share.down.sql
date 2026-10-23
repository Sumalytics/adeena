CREATE OR REPLACE FUNCTION adeena.publication_blocks(version_id uuid) RETURNS text[]
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

ALTER TABLE experience_releases DROP CONSTRAINT IF EXISTS experience_releases_approval_evidence_check;
ALTER TABLE experience_releases ADD CONSTRAINT experience_releases_approval_evidence_check CHECK (
  jsonb_typeof(approval_evidence) = 'object'
  AND approval_evidence @> '{"decision":"approved","contentReviewed":true,"privacy":"no-identifiable-learner","unresolvedHighRisk":false}'::jsonb
  AND coalesce(approval_evidence->>'experienceVersionId', '') = experience_version_id::text
  AND coalesce(char_length(btrim(approval_evidence->>'note')), 0) BETWEEN 10 AND 1000
) NOT VALID;

DROP TABLE IF EXISTS source_permission_declarations;

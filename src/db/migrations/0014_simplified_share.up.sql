-- Append-only creator declaration. Source versions remain immutable and
-- unverified rights are never rewritten as independently verified rights.
CREATE TABLE source_permission_declarations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  declaration text NOT NULL CHECK (declaration = 'permission-asserted'),
  declared_by uuid NOT NULL DEFAULT adeena.current_user_id(),
  declared_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, document_version_id, declared_by),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions(id, workspace_id)
);
ALTER TABLE source_permission_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_permission_declarations FORCE ROW LEVEL SECURITY;
CREATE POLICY source_permission_read ON source_permission_declarations FOR SELECT
  USING (adeena.is_active_member(workspace_id));
CREATE POLICY source_permission_record ON source_permission_declarations FOR INSERT
  WITH CHECK (
    adeena.is_active_member(workspace_id)
    AND declared_by = adeena.current_user_id()
    AND EXISTS (
      SELECT 1 FROM source_document_versions d
      WHERE d.id = document_version_id
        AND d.workspace_id = source_permission_declarations.workspace_id
        AND d.rights_status <> 'blocked'
    )
  );
REVOKE ALL ON source_permission_declarations FROM PUBLIC;
GRANT SELECT ON source_permission_declarations TO adeena_app;
GRANT INSERT (id, workspace_id, document_version_id, declaration) ON source_permission_declarations TO adeena_app;

ALTER TABLE experience_releases DROP CONSTRAINT IF EXISTS experience_releases_approval_evidence_check;
ALTER TABLE experience_releases DROP CONSTRAINT IF EXISTS experience_releases_check;
ALTER TABLE experience_releases ADD CONSTRAINT experience_releases_approval_evidence_check CHECK (
  jsonb_typeof(approval_evidence) = 'object'
  AND coalesce(approval_evidence->>'experienceVersionId', '') = experience_version_id::text
  AND (
    (
      approval_evidence @> '{"decision":"approved","contentReviewed":true,"privacy":"no-identifiable-learner","unresolvedHighRisk":false}'::jsonb
      AND coalesce(char_length(btrim(approval_evidence->>'note')), 0) BETWEEN 10 AND 1000
    )
    OR approval_evidence @> '{"mode":"creator-declared-mvp","sourceAuthorizationGatePassed":true,"contentApprovalRecorded":false,"initiatedBy":"share-action","policyVersion":"mvp-share-v1"}'::jsonb
  )
);

-- Ordinary source permission is established at upload/reuse. Publication still
-- requires a safe selected topic and a validated, immutable playable version.
CREATE OR REPLACE FUNCTION adeena.publication_blocks(version_id uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT array_remove(ARRAY[
    CASE WHEN NOT adeena.is_owner(v.workspace_id) THEN 'owner-required' END,
    CASE WHEN d.rights_status = 'blocked' THEN 'rights-blocked'
      WHEN d.rights_status <> 'cleared' AND c.id IS NULL AND p.id IS NULL THEN 'permission-declaration-required' END,
    CASE WHEN t.eligibility <> 'eligible' OR t.reasons ?| ARRAY['review-required','sensitive-domain','unsafe-title','rights-blocked']
      THEN 'independent-review-required' END,
    CASE WHEN NOT (
      (j.status = 'ready' AND j.experience_version_id = v.id AND j.review_status IN ('ready-for-review', 'review-required'))
      OR (e.status = 'accepted' AND e.proposed_version_id = v.id)
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
  LEFT JOIN source_permission_declarations p ON p.document_version_id = d.id AND p.workspace_id = d.workspace_id
    AND p.declared_by = adeena.current_user_id()
  LEFT JOIN experience_generation_jobs j ON j.id = v.job_id AND j.workspace_id = v.workspace_id
  LEFT JOIN experience_edit_jobs e ON e.id = v.edit_job_id AND e.workspace_id = v.workspace_id
  WHERE v.id = version_id), ARRAY['version-unavailable']::text[])
$$;


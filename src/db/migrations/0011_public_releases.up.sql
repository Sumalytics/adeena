CREATE TABLE experience_releases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  experience_version_id uuid NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  approval_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(approval_evidence) = 'object'
    AND approval_evidence @> '{"decision":"approved","contentReviewed":true,"privacy":"no-identifiable-learner","unresolvedHighRisk":false}'::jsonb
    AND coalesce(approval_evidence->>'experienceVersionId', '') = experience_version_id::text
    AND coalesce(char_length(btrim(approval_evidence->>'note')), 0) BETWEEN 10 AND 1000
  ),
  public_manifest jsonb NOT NULL CHECK (jsonb_typeof(public_manifest) = 'object'),
  revoked_at timestamptz,
  revoked_by uuid,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  UNIQUE (workspace_id, experience_version_id),
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id)
);

ALTER TABLE experience_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY experience_releases_select ON experience_releases FOR SELECT
  USING (adeena.is_active_member(workspace_id));
CREATE POLICY experience_releases_insert ON experience_releases FOR INSERT
  WITH CHECK (adeena.is_owner(workspace_id) AND published_by = adeena.current_user_id());
CREATE POLICY experience_releases_revoke ON experience_releases FOR UPDATE
  USING (adeena.is_owner(workspace_id))
  WITH CHECK (adeena.is_owner(workspace_id) AND revoked_by = adeena.current_user_id());

CREATE FUNCTION adeena.guard_release() RETURNS trigger
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
CREATE TRIGGER experience_releases_guard BEFORE INSERT OR UPDATE ON experience_releases
  FOR EACH ROW EXECUTE FUNCTION adeena.guard_release();

-- The HTTP server uses adeena_app without a bound identity for guests. It may
-- read only this narrow public projection, never the underlying private tables.
CREATE FUNCTION adeena.read_public_release(release_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public_manifest FROM public.experience_releases
  WHERE id = release_id AND revoked_at IS NULL
$$;
REVOKE ALL ON experience_releases FROM PUBLIC;
GRANT SELECT, INSERT ON experience_releases TO adeena_app;
GRANT UPDATE (revoked_at, revoked_by) ON experience_releases TO adeena_app;
REVOKE ALL ON FUNCTION adeena.guard_release() FROM PUBLIC;
REVOKE ALL ON FUNCTION adeena.read_public_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adeena.read_public_release(uuid) TO adeena_app;

DROP POLICY IF EXISTS visual_worker_jobs_select ON visual_generation_jobs;
DROP POLICY IF EXISTS visual_worker_jobs_update ON visual_generation_jobs;
DROP POLICY IF EXISTS visual_worker_costs_select ON visual_generation_costs;
DROP POLICY IF EXISTS visual_worker_costs_insert ON visual_generation_costs;
DROP POLICY IF EXISTS visual_worker_costs_update ON visual_generation_costs;
DROP POLICY IF EXISTS visual_worker_blueprints_select ON visual_experience_blueprints;
DROP POLICY IF EXISTS visual_worker_blueprints_insert ON visual_experience_blueprints;
DROP POLICY IF EXISTS visual_worker_versions_select ON experience_versions;
DROP POLICY IF EXISTS visual_worker_generation_jobs_select ON experience_generation_jobs;
DROP POLICY IF EXISTS visual_worker_topics_select ON topic_candidates;
DROP POLICY IF EXISTS visual_worker_documents_select ON source_document_versions;
DROP POLICY IF EXISTS visual_worker_plans_select ON experience_plans;
DROP POLICY IF EXISTS visual_worker_spans_select ON source_spans;
DROP POLICY IF EXISTS visual_worker_free_quota_select ON adeena_free_quota;
DROP POLICY IF EXISTS visual_worker_free_quota_update ON adeena_free_quota;
DROP POLICY IF EXISTS visual_worker_edit_spend_select ON adeena_edit_spend;
DROP POLICY IF EXISTS visual_worker_edit_spend_update ON adeena_edit_spend;

REVOKE ALL ON visual_generation_jobs, visual_generation_costs, visual_experience_blueprints,
  experience_versions, experience_generation_jobs, topic_candidates, source_document_versions,
  experience_plans, source_spans, adeena_free_quota, adeena_edit_spend FROM adeena_visual_worker;
REVOKE ALL ON FUNCTION adeena.visual_worker_has_claim(uuid) FROM adeena_visual_worker;
REVOKE ALL ON FUNCTION adeena.current_user_id() FROM adeena_visual_worker;
REVOKE ALL ON FUNCTION adeena.is_active_member(uuid) FROM adeena_visual_worker;
REVOKE ALL ON FUNCTION adeena.claim_visual_generation_job(text,integer,uuid) FROM adeena_visual_worker;
REVOKE ALL ON FUNCTION adeena.activate_visual_generation_claim(uuid,text,uuid) FROM adeena_visual_worker;
REVOKE ALL ON FUNCTION adeena.visual_worker_can_access(text,uuid,uuid) FROM adeena_visual_worker;
REVOKE ALL ON SCHEMA public, adeena FROM adeena_visual_worker;

CREATE OR REPLACE FUNCTION adeena.is_active_member(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships
    WHERE workspace_id=target AND user_id=adeena.current_user_id() AND status='active'
  )
$$;
DROP FUNCTION IF EXISTS adeena.visual_worker_has_claim(uuid);
DROP FUNCTION IF EXISTS adeena.visual_worker_can_access(text,uuid,uuid);
CREATE FUNCTION adeena.visual_worker_has_claim(target_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.visual_generation_jobs j
    WHERE j.id = nullif(current_setting('adeena.visual_worker_job_id', true), '')::uuid
      AND j.workspace_id = target_workspace
      AND j.lease_owner = nullif(current_setting('adeena.visual_worker_owner', true), '')
      AND j.lease_token = nullif(current_setting('adeena.visual_worker_token', true), '')::uuid
      AND j.lease_expires_at > now() AND j.status IN ('queued','planning','reviewing')
  )
$$;
CREATE OR REPLACE FUNCTION adeena.is_active_member(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT adeena.visual_worker_has_claim(target) OR EXISTS (
    SELECT 1 FROM public.workspace_memberships
    WHERE workspace_id=target AND user_id=adeena.current_user_id() AND status='active'
  )
$$;
GRANT EXECUTE ON FUNCTION adeena.visual_worker_has_claim(uuid) TO adeena_app;
GRANT EXECUTE ON FUNCTION adeena.claim_visual_generation_job(text,integer,uuid) TO adeena_app;
GRANT EXECUTE ON FUNCTION adeena.activate_visual_generation_claim(uuid,text,uuid) TO adeena_app;


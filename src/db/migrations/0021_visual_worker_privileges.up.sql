DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('adeena_visual_worker_role'));
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adeena_visual_worker') THEN
    CREATE ROLE adeena_visual_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'adeena_visual_worker'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'adeena_visual_worker has unsafe PostgreSQL role attributes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
    WHERE r.rolname='adeena_visual_worker'
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE r.rolname='adeena_visual_worker'
  ) OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE r.rolname='adeena_visual_worker'
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE r.rolname='adeena_visual_worker'
  ) OR EXISTS (
    SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
    WHERE r.rolname='adeena_visual_worker'
  ) THEN
    RAISE EXCEPTION 'adeena_visual_worker must not inherit roles or own database objects';
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM adeena_visual_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM adeena_visual_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA adeena FROM adeena_visual_worker;
REVOKE ALL ON SCHEMA public, adeena FROM adeena_visual_worker;

REVOKE ALL ON FUNCTION adeena.visual_worker_has_claim(uuid) FROM PUBLIC, adeena_app;
REVOKE ALL ON FUNCTION adeena.claim_visual_generation_job(text,integer,uuid) FROM PUBLIC, adeena_app;
REVOKE ALL ON FUNCTION adeena.activate_visual_generation_claim(uuid,text,uuid) FROM PUBLIC, adeena_app;

CREATE OR REPLACE FUNCTION adeena.is_active_member(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships
    WHERE workspace_id = target
      AND user_id = adeena.current_user_id()
      AND status = 'active'
  )
$$;

CREATE FUNCTION adeena.visual_worker_can_access(resource_kind text, target_workspace uuid, target_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE claimed public.visual_generation_jobs%ROWTYPE;
BEGIN
  IF session_user <> 'adeena_visual_worker' THEN RETURN false; END IF;
  SELECT * INTO claimed FROM public.visual_generation_jobs j
  WHERE j.id = nullif(current_setting('adeena.visual_worker_job_id', true), '')::uuid
    AND j.lease_owner = nullif(current_setting('adeena.visual_worker_owner', true), '')
    AND j.lease_token = nullif(current_setting('adeena.visual_worker_token', true), '')::uuid
    AND j.lease_expires_at > now()
    AND j.status IN ('queued','planning','reviewing');
  IF NOT FOUND THEN RETURN false; END IF;
  IF resource_kind = 'active' THEN RETURN true; END IF;
  IF target_workspace IS DISTINCT FROM claimed.workspace_id THEN RETURN false; END IF;
  IF resource_kind = 'workspace' THEN RETURN true; END IF;
  IF resource_kind = 'visual-job' THEN RETURN target_id = claimed.id; END IF;
  IF resource_kind = 'claimed-version' THEN RETURN target_id = claimed.experience_version_id; END IF;
  IF resource_kind = 'experience-version' THEN
    RETURN EXISTS (
      WITH RECURSIVE lineage AS (
        SELECT v.id,v.parent_version_id FROM public.experience_versions v
        WHERE v.id=claimed.experience_version_id AND v.workspace_id=claimed.workspace_id
        UNION ALL
        SELECT parent.id,parent.parent_version_id FROM public.experience_versions parent
        JOIN lineage ON lineage.parent_version_id=parent.id
        WHERE parent.workspace_id=claimed.workspace_id
      ) SELECT 1 FROM lineage WHERE id=target_id
    );
  END IF;
  IF resource_kind = 'generation-job' THEN
    RETURN EXISTS (
      WITH RECURSIVE lineage AS (
        SELECT v.id,v.parent_version_id,v.job_id FROM public.experience_versions v
        WHERE v.id=claimed.experience_version_id AND v.workspace_id=claimed.workspace_id
        UNION ALL
        SELECT parent.id,parent.parent_version_id,parent.job_id FROM public.experience_versions parent
        JOIN lineage ON lineage.parent_version_id=parent.id
        WHERE parent.workspace_id=claimed.workspace_id
      ) SELECT 1 FROM lineage WHERE job_id=target_id
    );
  END IF;
  IF resource_kind = 'topic' THEN
    RETURN EXISTS (SELECT 1 FROM public.experience_versions v WHERE v.id=claimed.experience_version_id AND v.workspace_id=claimed.workspace_id AND v.topic_candidate_id=target_id);
  END IF;
  IF resource_kind = 'document-version' THEN
    RETURN EXISTS (SELECT 1 FROM public.experience_versions v WHERE v.id=claimed.experience_version_id AND v.workspace_id=claimed.workspace_id AND v.document_version_id=target_id);
  END IF;
  IF resource_kind = 'source-span' THEN
    RETURN EXISTS (SELECT 1 FROM public.experience_versions v WHERE v.id=claimed.experience_version_id AND v.workspace_id=claimed.workspace_id AND v.source_span_ids ? target_id::text);
  END IF;
  IF resource_kind = 'experience-plan' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.experience_plans p
      WHERE p.id=target_id AND adeena.visual_worker_can_access('generation-job',p.workspace_id,p.job_id)
    );
  END IF;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION adeena.visual_worker_has_claim(target_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT adeena.visual_worker_can_access('workspace',target_workspace,NULL::uuid) $$;

CREATE OR REPLACE FUNCTION adeena.claim_visual_generation_job(worker_name text, lease_seconds integer, target_job uuid DEFAULT NULL)
RETURNS TABLE (job_id uuid, workspace_id uuid, experience_version_id uuid, idempotency_key uuid, lease_token uuid, created_by uuid, status text, attempt_count integer, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE claimed_id uuid;
BEGIN
  IF session_user <> 'adeena_visual_worker' THEN
    RAISE EXCEPTION 'visual worker role required' USING ERRCODE = '42501';
  END IF;
  IF worker_name !~ '^[a-z0-9-]{1,80}$' OR lease_seconds < 5 OR lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid visual worker claim';
  END IF;

  UPDATE public.visual_generation_jobs j
  SET status='ready', association_id=b.id, failure_code=NULL, diagnostics='[]'::jsonb,
      provider_stage=NULL, provider_started_at=NULL, lease_owner=NULL, lease_token=NULL,
      lease_expires_at=NULL, completed_at=coalesce(j.completed_at,now()), updated_at=now()
  FROM public.visual_experience_blueprints b
  WHERE j.status IN ('queued','planning','reviewing') AND j.lease_expires_at < now()
    AND b.workspace_id=j.workspace_id AND b.experience_version_id=j.experience_version_id;

  WITH uncertain AS (
    UPDATE public.visual_generation_jobs j
    SET status='failed', failure_code='provider-outcome-unknown', uncertain_charge=true,
      diagnostics='[{"code":"provider-outcome-unknown","message":"The worker stopped after a provider request began; the operation was not purchased again."}]'::jsonb,
      lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, completed_at=now(), updated_at=now()
    WHERE j.status IN ('planning','reviewing') AND j.lease_expires_at < now() AND j.provider_started_at IS NOT NULL
    RETURNING j.id
  )
  UPDATE public.visual_generation_costs c SET actual_cost_micros=NULL, usage_kind='estimate'
  FROM uncertain u WHERE c.job_id=u.id;

  UPDATE public.visual_generation_jobs j
  SET status='failed', failure_code='worker-attempts-exhausted',
      diagnostics='[{"code":"worker-attempts-exhausted","message":"Visual generation could not start within its bounded worker attempts."}]'::jsonb,
      lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, completed_at=now(), updated_at=now()
  WHERE j.status IN ('queued','planning','reviewing') AND j.lease_expires_at < now()
    AND j.provider_started_at IS NULL AND j.attempt_count >= j.max_attempts;

  SELECT j.id INTO claimed_id FROM public.visual_generation_jobs j
  WHERE (target_job IS NULL OR j.id = target_job) AND j.attempt_count < j.max_attempts
    AND ((j.status='queued' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<now()))
      OR (j.status IN ('planning','reviewing') AND j.lease_expires_at<now() AND j.provider_started_at IS NULL))
  ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF claimed_id IS NULL THEN RETURN; END IF;
  RETURN QUERY UPDATE public.visual_generation_jobs j
  SET lease_owner=worker_name, lease_token=gen_random_uuid(), lease_expires_at=now()+make_interval(secs=>lease_seconds),
      attempt_count=j.attempt_count+1, updated_at=now()
  WHERE j.id=claimed_id
  RETURNING j.id,j.workspace_id,j.experience_version_id,j.idempotency_key,j.lease_token,j.created_by,j.status,j.attempt_count,j.created_at;
END
$$;

CREATE OR REPLACE FUNCTION adeena.activate_visual_generation_claim(job uuid, worker_name text, token uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE selected public.visual_generation_jobs%ROWTYPE;
BEGIN
  IF session_user <> 'adeena_visual_worker' THEN
    RAISE EXCEPTION 'visual worker role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected FROM public.visual_generation_jobs j
  WHERE j.id=job AND j.lease_owner=worker_name AND j.lease_token=token
    AND j.lease_expires_at>now() AND j.status IN ('queued','planning','reviewing');
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid or expired visual worker claim'; END IF;
  PERFORM set_config('adeena.visual_worker_job_id', selected.id::text, true);
  PERFORM set_config('adeena.visual_worker_owner', worker_name, true);
  PERFORM set_config('adeena.visual_worker_token', token::text, true);
  PERFORM set_config('adeena.user_id', '', true);
  RETURN selected.workspace_id;
END
$$;

CREATE POLICY visual_worker_jobs_select ON visual_generation_jobs FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('visual-job',workspace_id,id));
CREATE POLICY visual_worker_jobs_update ON visual_generation_jobs FOR UPDATE TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('visual-job',workspace_id,id))
  WITH CHECK (adeena.visual_worker_can_access('visual-job',workspace_id,id));
CREATE POLICY visual_worker_costs_select ON visual_generation_costs FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('visual-job',workspace_id,job_id));
CREATE POLICY visual_worker_costs_insert ON visual_generation_costs FOR INSERT TO adeena_visual_worker
  WITH CHECK (adeena.visual_worker_can_access('visual-job',workspace_id,job_id));
CREATE POLICY visual_worker_costs_update ON visual_generation_costs FOR UPDATE TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('visual-job',workspace_id,job_id))
  WITH CHECK (adeena.visual_worker_can_access('visual-job',workspace_id,job_id));
CREATE POLICY visual_worker_blueprints_select ON visual_experience_blueprints FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('claimed-version',workspace_id,experience_version_id));
CREATE POLICY visual_worker_blueprints_insert ON visual_experience_blueprints FOR INSERT TO adeena_visual_worker
  WITH CHECK (adeena.visual_worker_can_access('claimed-version',workspace_id,experience_version_id));
CREATE POLICY visual_worker_versions_select ON experience_versions FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('experience-version',workspace_id,id));
CREATE POLICY visual_worker_generation_jobs_select ON experience_generation_jobs FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('generation-job',workspace_id,id));
CREATE POLICY visual_worker_topics_select ON topic_candidates FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('topic',workspace_id,id));
CREATE POLICY visual_worker_documents_select ON source_document_versions FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('document-version',workspace_id,id));
CREATE POLICY visual_worker_plans_select ON experience_plans FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('experience-plan',workspace_id,id));
CREATE POLICY visual_worker_spans_select ON source_spans FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('source-span',workspace_id,id));
CREATE POLICY visual_worker_free_quota_select ON adeena_free_quota FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('active',NULL::uuid,NULL::uuid));
CREATE POLICY visual_worker_free_quota_update ON adeena_free_quota FOR UPDATE TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('active',NULL::uuid,NULL::uuid))
  WITH CHECK (adeena.visual_worker_can_access('active',NULL::uuid,NULL::uuid));
CREATE POLICY visual_worker_edit_spend_select ON adeena_edit_spend FOR SELECT TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('active',NULL::uuid,NULL::uuid));
CREATE POLICY visual_worker_edit_spend_update ON adeena_edit_spend FOR UPDATE TO adeena_visual_worker
  USING (adeena.visual_worker_can_access('active',NULL::uuid,NULL::uuid))
  WITH CHECK (adeena.visual_worker_can_access('active',NULL::uuid,NULL::uuid));

GRANT USAGE ON SCHEMA public, adeena TO adeena_visual_worker;
GRANT EXECUTE ON FUNCTION adeena.current_user_id() TO adeena_visual_worker;
GRANT EXECUTE ON FUNCTION adeena.is_active_member(uuid) TO adeena_visual_worker;
GRANT EXECUTE ON FUNCTION adeena.visual_worker_can_access(text,uuid,uuid) TO adeena_visual_worker;
GRANT EXECUTE ON FUNCTION adeena.visual_worker_has_claim(uuid) TO adeena_visual_worker;
GRANT EXECUTE ON FUNCTION adeena.claim_visual_generation_job(text,integer,uuid) TO adeena_visual_worker;
GRANT EXECUTE ON FUNCTION adeena.activate_visual_generation_claim(uuid,text,uuid) TO adeena_visual_worker;
GRANT SELECT ON visual_generation_jobs, visual_generation_costs, visual_experience_blueprints,
  experience_versions, experience_generation_jobs, topic_candidates, source_document_versions,
  experience_plans, source_spans, adeena_free_quota, adeena_edit_spend TO adeena_visual_worker;
GRANT UPDATE (status,instructional_plan,model_review,diagnostics,association_id,failure_code,duration_ms,
  updated_at,provider_stage,provider_started_at,proposal,uncertain_charge,completed_at,lease_owner,lease_token,lease_expires_at)
  ON visual_generation_jobs TO adeena_visual_worker;
GRANT INSERT (id,workspace_id,job_id,model,pricing_version,execution_mode,input_tokens,cached_input_tokens,
  output_tokens,reasoning_tokens,call_count,retry_count,reserved_cost_micros,actual_cost_micros,
  commercial_estimate_micros,usage_kind,model_calls,created_by,created_at)
  ON visual_generation_costs TO adeena_visual_worker;
GRANT UPDATE (input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,call_count,retry_count,
  actual_cost_micros,commercial_estimate_micros,usage_kind,model_calls)
  ON visual_generation_costs TO adeena_visual_worker;
GRANT INSERT (id,workspace_id,experience_version_id,contract,blueprint,blueprint_hash,validation_context,
  scene_mapping,validation_status,blueprint_contract,renderer_version,authored_fixture,fixture_label,created_by,created_at)
  ON visual_experience_blueprints TO adeena_visual_worker;
GRANT UPDATE (session_id,session_requests,day_requests,usage_day,updated_at) ON adeena_free_quota TO adeena_visual_worker;
GRANT UPDATE (reserved_micros,updated_at) ON adeena_edit_spend TO adeena_visual_worker;


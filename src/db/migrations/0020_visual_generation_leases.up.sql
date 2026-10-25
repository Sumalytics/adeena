ALTER TABLE visual_generation_jobs
  ADD COLUMN lease_owner text CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9-]{1,80}$'),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN provider_stage text CHECK (provider_stage IS NULL OR provider_stage IN ('visualPlan','visualReview')),
  ADD COLUMN provider_started_at timestamptz,
  ADD COLUMN proposal jsonb CHECK (proposal IS NULL OR jsonb_typeof(proposal) = 'object'),
  ADD COLUMN uncertain_charge boolean NOT NULL DEFAULT false,
  ADD COLUMN completed_at timestamptz;

CREATE INDEX visual_generation_jobs_claim_idx
  ON visual_generation_jobs (status, lease_expires_at, created_at)
  WHERE status IN ('queued','planning','reviewing');

CREATE FUNCTION adeena.visual_worker_has_claim(target_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.visual_generation_jobs j
    WHERE j.id = nullif(current_setting('adeena.visual_worker_job_id', true), '')::uuid
      AND j.workspace_id = target_workspace
      AND j.lease_owner = nullif(current_setting('adeena.visual_worker_owner', true), '')
      AND j.lease_token = nullif(current_setting('adeena.visual_worker_token', true), '')::uuid
      AND j.lease_expires_at > now()
      AND j.status IN ('queued','planning','reviewing')
  )
$$;

CREATE OR REPLACE FUNCTION adeena.is_active_member(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT adeena.visual_worker_has_claim(target) OR EXISTS (
    SELECT 1 FROM public.workspace_memberships
    WHERE workspace_id = target
      AND user_id = adeena.current_user_id()
      AND status = 'active'
  )
$$;

CREATE FUNCTION adeena.claim_visual_generation_job(worker_name text, lease_seconds integer, target_job uuid DEFAULT NULL)
RETURNS TABLE (job_id uuid, workspace_id uuid, experience_version_id uuid, idempotency_key uuid, lease_token uuid, created_by uuid, status text, attempt_count integer, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE claimed_id uuid;
BEGIN
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
  UPDATE public.visual_generation_costs c
  SET actual_cost_micros=NULL, usage_kind='estimate'
  FROM uncertain u WHERE c.job_id=u.id;

  UPDATE public.visual_generation_jobs j
  SET status='failed', failure_code='worker-attempts-exhausted',
      diagnostics='[{"code":"worker-attempts-exhausted","message":"Visual generation could not start within its bounded worker attempts."}]'::jsonb,
      lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, completed_at=now(), updated_at=now()
  WHERE j.status IN ('queued','planning','reviewing') AND j.lease_expires_at < now()
    AND j.provider_started_at IS NULL AND j.attempt_count >= j.max_attempts;

  SELECT j.id INTO claimed_id
  FROM public.visual_generation_jobs j
  WHERE (target_job IS NULL OR j.id = target_job)
    AND j.attempt_count < j.max_attempts
    AND (
      (j.status = 'queued' AND (j.lease_expires_at IS NULL OR j.lease_expires_at < now()))
      OR (j.status IN ('planning','reviewing') AND j.lease_expires_at < now() AND j.provider_started_at IS NULL)
    )
  ORDER BY j.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF claimed_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.visual_generation_jobs j
  SET lease_owner=worker_name, lease_token=gen_random_uuid(),
      lease_expires_at=now()+make_interval(secs => lease_seconds),
      attempt_count=j.attempt_count+1, updated_at=now()
  WHERE j.id=claimed_id
  RETURNING j.id,j.workspace_id,j.experience_version_id,j.idempotency_key,j.lease_token,j.created_by,j.status,j.attempt_count,j.created_at;
END
$$;

CREATE FUNCTION adeena.activate_visual_generation_claim(job uuid, worker_name text, token uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE selected public.visual_generation_jobs%ROWTYPE;
BEGIN
  SELECT * INTO selected FROM public.visual_generation_jobs j
  WHERE j.id=job AND j.lease_owner=worker_name AND j.lease_token=token
    AND j.lease_expires_at>now() AND j.status IN ('queued','planning','reviewing');
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid or expired visual worker claim'; END IF;
  PERFORM set_config('adeena.visual_worker_job_id', selected.id::text, true);
  PERFORM set_config('adeena.visual_worker_owner', worker_name, true);
  PERFORM set_config('adeena.visual_worker_token', token::text, true);
  PERFORM set_config('adeena.user_id', selected.created_by::text, true);
  RETURN selected.workspace_id;
END
$$;

REVOKE ALL ON FUNCTION adeena.visual_worker_has_claim(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION adeena.claim_visual_generation_job(text,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION adeena.activate_visual_generation_claim(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adeena.visual_worker_has_claim(uuid) TO adeena_app;
GRANT EXECUTE ON FUNCTION adeena.claim_visual_generation_job(text,integer,uuid) TO adeena_app;
GRANT EXECUTE ON FUNCTION adeena.activate_visual_generation_claim(uuid,text,uuid) TO adeena_app;


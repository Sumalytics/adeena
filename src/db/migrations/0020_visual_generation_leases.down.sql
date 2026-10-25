DROP FUNCTION IF EXISTS adeena.activate_visual_generation_claim(uuid,text,uuid);
DROP FUNCTION IF EXISTS adeena.claim_visual_generation_job(text,integer,uuid);
CREATE OR REPLACE FUNCTION adeena.is_active_member(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workspace_memberships WHERE workspace_id=target AND user_id=adeena.current_user_id() AND status='active')
$$;
DROP FUNCTION IF EXISTS adeena.visual_worker_has_claim(uuid);
DROP INDEX IF EXISTS visual_generation_jobs_claim_idx;
ALTER TABLE visual_generation_jobs
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS uncertain_charge,
  DROP COLUMN IF EXISTS proposal,
  DROP COLUMN IF EXISTS provider_started_at,
  DROP COLUMN IF EXISTS provider_stage,
  DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS attempt_count,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS lease_token,
  DROP COLUMN IF EXISTS lease_owner;

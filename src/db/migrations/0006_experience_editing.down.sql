DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'experience_versions' AND column_name = 'edit_job_id'
  ) THEN
    ALTER TABLE experience_versions DISABLE TRIGGER experience_versions_immutable;
    ALTER TABLE IF EXISTS experience_edit_jobs DROP CONSTRAINT IF EXISTS experience_edit_jobs_version_fk;
    ALTER TABLE IF EXISTS experience_edit_jobs DROP CONSTRAINT IF EXISTS experience_edit_jobs_base_fk;
    ALTER TABLE IF EXISTS experience_edit_jobs DROP CONSTRAINT IF EXISTS experience_edit_jobs_expected_fk;
    DROP TABLE IF EXISTS experience_edit_events;
    DROP TABLE IF EXISTS experience_edit_costs;
    DROP TABLE IF EXISTS experience_current_drafts;
    ALTER TABLE experience_versions DROP CONSTRAINT IF EXISTS experience_versions_edit_fk;
    ALTER TABLE experience_versions DROP CONSTRAINT IF EXISTS experience_versions_parent_fk;
    DELETE FROM experience_versions WHERE edit_job_id IS NOT NULL;
    ALTER TABLE experience_versions DROP CONSTRAINT IF EXISTS experience_versions_origin_check;
    ALTER TABLE experience_versions DROP COLUMN edit_job_id;
    ALTER TABLE experience_versions DROP COLUMN parent_version_id;
    ALTER TABLE experience_versions ALTER COLUMN job_id SET NOT NULL;
    ALTER TABLE experience_versions ENABLE TRIGGER experience_versions_immutable;
    DROP TABLE IF EXISTS experience_edit_jobs;
  ELSE
    DROP TABLE IF EXISTS experience_edit_events;
    DROP TABLE IF EXISTS experience_edit_costs;
    DROP TABLE IF EXISTS experience_current_drafts;
    DROP TABLE IF EXISTS experience_edit_jobs;
  END IF;
END $$;

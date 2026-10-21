DROP TABLE IF EXISTS experience_generation_costs;
DROP TABLE IF EXISTS experience_validation_results;
DROP TABLE IF EXISTS experience_plans;
ALTER TABLE IF EXISTS experience_generation_jobs DROP CONSTRAINT IF EXISTS experience_generation_jobs_version_fk;
DROP TABLE IF EXISTS experience_versions;
DROP TABLE IF EXISTS experience_generation_jobs;
DROP FUNCTION IF EXISTS adeena.reject_experience_version_mutation();

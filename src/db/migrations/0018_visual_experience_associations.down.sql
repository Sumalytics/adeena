DROP TABLE IF EXISTS visual_experience_audio;
DROP TABLE IF EXISTS visual_experience_blueprints;
DROP FUNCTION IF EXISTS adeena.reject_visual_experience_mutation();
ALTER TABLE private_audio_assets DROP CONSTRAINT IF EXISTS private_audio_assets_version_identity;

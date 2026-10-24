ALTER TABLE private_audio_assets ADD CONSTRAINT private_audio_assets_version_identity UNIQUE (id, workspace_id, experience_version_id);

CREATE TABLE visual_experience_blueprints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  experience_version_id uuid NOT NULL,
  contract text NOT NULL CHECK (contract = 'ADEENA-VISUAL-EXPERIENCE-ASSOCIATION-v1'),
  blueprint jsonb NOT NULL CHECK (jsonb_typeof(blueprint) = 'object'),
  blueprint_hash text NOT NULL CHECK (blueprint_hash ~ '^[a-f0-9]{64}$'),
  validation_context jsonb NOT NULL CHECK (jsonb_typeof(validation_context) = 'object'),
  scene_mapping jsonb NOT NULL CHECK (jsonb_typeof(scene_mapping) = 'object'),
  validation_status text NOT NULL CHECK (validation_status = 'valid'),
  blueprint_contract text NOT NULL CHECK (blueprint_contract = 'ADEENA-VISUAL-LEARNING-v1'),
  renderer_version text NOT NULL CHECK (renderer_version ~ '^visual-renderer@[0-9]+$'),
  authored_fixture boolean NOT NULL DEFAULT false,
  fixture_label text CHECK (fixture_label IS NULL OR char_length(btrim(fixture_label)) BETWEEN 1 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, experience_version_id),
  UNIQUE (id, workspace_id, experience_version_id),
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions(id, workspace_id)
);

CREATE TABLE visual_experience_audio (
  association_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  experience_version_id uuid NOT NULL,
  narration_segment_id text NOT NULL CHECK (narration_segment_id ~ '^[a-z][a-z0-9-]{0,40}$'),
  audio_asset_id uuid NOT NULL,
  playback_metadata jsonb NOT NULL CHECK (jsonb_typeof(playback_metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (association_id, narration_segment_id),
  FOREIGN KEY (association_id, workspace_id, experience_version_id)
    REFERENCES visual_experience_blueprints(id, workspace_id, experience_version_id),
  FOREIGN KEY (audio_asset_id, workspace_id, experience_version_id)
    REFERENCES private_audio_assets(id, workspace_id, experience_version_id)
);

ALTER TABLE visual_experience_blueprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE visual_experience_audio ENABLE ROW LEVEL SECURITY;
ALTER TABLE visual_experience_blueprints FORCE ROW LEVEL SECURITY;
ALTER TABLE visual_experience_audio FORCE ROW LEVEL SECURITY;
CREATE POLICY visual_blueprints_member ON visual_experience_blueprints USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id));
CREATE POLICY visual_audio_member ON visual_experience_audio USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id));

CREATE FUNCTION adeena.reject_visual_experience_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'visual experience associations are immutable'; END; $$;
CREATE TRIGGER visual_blueprints_immutable BEFORE UPDATE OR DELETE ON visual_experience_blueprints FOR EACH ROW EXECUTE FUNCTION adeena.reject_visual_experience_mutation();
CREATE TRIGGER visual_audio_immutable BEFORE UPDATE OR DELETE ON visual_experience_audio FOR EACH ROW EXECUTE FUNCTION adeena.reject_visual_experience_mutation();

REVOKE ALL ON visual_experience_blueprints, visual_experience_audio FROM PUBLIC;
GRANT SELECT, INSERT ON visual_experience_blueprints, visual_experience_audio TO adeena_app;
REVOKE ALL ON FUNCTION adeena.reject_visual_experience_mutation() FROM PUBLIC;

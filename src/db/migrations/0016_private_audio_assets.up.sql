CREATE TABLE private_audio_assets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  experience_version_id uuid NOT NULL,
  narration_segment_id text NOT NULL CHECK (narration_segment_id ~ '^[a-z][a-z0-9-]{0,40}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  storage_locator text NOT NULL CHECK (storage_locator ~ '^private-audio://[0-9a-f-]{36}/[a-f0-9]{64}/audio\.(wav|mp3|ogg)$'),
  mime_type text NOT NULL CHECK (mime_type IN ('audio/wav', 'audio/mpeg', 'audio/ogg')),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 8388608),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 1 AND 30000),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  voice_profile_ref text NOT NULL CHECK (char_length(btrim(voice_profile_ref)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  UNIQUE (workspace_id, experience_version_id, narration_segment_id, content_hash),
  FOREIGN KEY (experience_version_id, workspace_id) REFERENCES experience_versions (id, workspace_id)
);

CREATE INDEX private_audio_assets_version_idx ON private_audio_assets (workspace_id, experience_version_id);
CREATE INDEX private_audio_assets_active_idx ON private_audio_assets (id) WHERE status = 'active';

ALTER TABLE private_audio_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_audio_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY private_audio_assets_select ON private_audio_assets FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY private_audio_assets_insert ON private_audio_assets FOR INSERT WITH CHECK (adeena.is_active_member(workspace_id));
CREATE POLICY private_audio_assets_retire ON private_audio_assets FOR UPDATE
  USING (adeena.is_active_member(workspace_id)) WITH CHECK (adeena.is_active_member(workspace_id));

CREATE FUNCTION adeena.guard_private_audio_asset() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private audio assets cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'retired'
    OR (to_jsonb(NEW) - 'status' - 'retired_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'retired_at') THEN
    RAISE EXCEPTION 'private audio assets are immutable except for retirement' USING ERRCODE = '23514';
  END IF;
  NEW.retired_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER private_audio_assets_immutable BEFORE UPDATE OR DELETE ON private_audio_assets
  FOR EACH ROW EXECUTE FUNCTION adeena.guard_private_audio_asset();

REVOKE ALL ON private_audio_assets FROM PUBLIC;
GRANT SELECT, INSERT ON private_audio_assets TO adeena_app;
GRANT UPDATE (status, retired_at) ON private_audio_assets TO adeena_app;
REVOKE ALL ON FUNCTION adeena.guard_private_audio_asset() FROM PUBLIC;

CREATE TABLE topic_overrides (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  node_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  corrected_title text NOT NULL CHECK (char_length(corrected_title) BETWEEN 1 AND 200),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (document_version_id, version),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id),
  FOREIGN KEY (collection_id, workspace_id) REFERENCES knowledge_collections (id, workspace_id),
  FOREIGN KEY (node_id, collection_id) REFERENCES knowledge_nodes (id, collection_id)
);

CREATE TABLE topic_candidates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  extraction_id uuid NOT NULL,
  detection_version text NOT NULL CHECK (detection_version = '1'),
  override_version integer NOT NULL CHECK (override_version >= 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  source_order integer NOT NULL CHECK (source_order >= 0),
  detection_method text NOT NULL CHECK (detection_method IN ('explicit-heading', 'document-structure', 'bounded-text')),
  uncertainty text NOT NULL CHECK (uncertainty IN ('stated', 'uncertain')),
  eligibility text NOT NULL CHECK (eligibility IN ('eligible', 'needs-review', 'insufficient-support')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  support_chars integer NOT NULL CHECK (support_chars >= 0),
  primary_node_id uuid NOT NULL,
  node_ids jsonb NOT NULL CHECK (jsonb_typeof(node_ids) = 'array' AND jsonb_array_length(node_ids) >= 1),
  source_span_ids jsonb NOT NULL CHECK (jsonb_typeof(source_span_ids) = 'array' AND jsonb_array_length(source_span_ids) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, document_version_id, detection_version, override_version, source_order),
  FOREIGN KEY (collection_id, workspace_id) REFERENCES knowledge_collections (id, workspace_id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id),
  FOREIGN KEY (extraction_id, workspace_id) REFERENCES extraction_results (id, workspace_id)
);

CREATE TABLE recommendation_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  collection_id uuid,
  document_version_id uuid NOT NULL,
  extraction_id uuid NOT NULL,
  detection_version text NOT NULL CHECK (detection_version = '1'),
  override_version integer NOT NULL CHECK (override_version >= 0),
  audience_label text NOT NULL CHECK (char_length(audience_label) BETWEEN 1 AND 80),
  age_band text NOT NULL CHECK (age_band IN ('5-7', '8-10', '11-13', '14-18', 'adult', 'unspecified')),
  status text NOT NULL CHECK (status IN ('recommended', 'needs-creator-selection', 'insufficient-support')),
  topic_candidate_id uuid,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 400),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  source_span_ids jsonb NOT NULL CHECK (jsonb_typeof(source_span_ids) = 'array'),
  understood text NOT NULL CHECK (understood IN ('full', 'partial', 'unreadable')),
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  processed_chars integer NOT NULL CHECK (processed_chars >= 0),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count = 0),
  generates_experience boolean NOT NULL DEFAULT false CHECK (generates_experience = false),
  experience_version_id uuid CHECK (experience_version_id IS NULL),
  ai_generation_authorized boolean NOT NULL DEFAULT false CHECK (ai_generation_authorized = false),
  active boolean NOT NULL DEFAULT true,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (collection_id, workspace_id) REFERENCES knowledge_collections (id, workspace_id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id),
  FOREIGN KEY (extraction_id, workspace_id) REFERENCES extraction_results (id, workspace_id),
  FOREIGN KEY (topic_candidate_id, workspace_id) REFERENCES topic_candidates (id, workspace_id)
);

CREATE UNIQUE INDEX recommendation_runs_one_active
  ON recommendation_runs (workspace_id, document_version_id, audience_label, age_band, override_version)
  WHERE active;

CREATE INDEX recommendation_runs_document_idx ON recommendation_runs (workspace_id, document_version_id, created_at);

ALTER TABLE topic_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE topic_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE recommendation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY topic_overrides_select ON topic_overrides FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY topic_overrides_insert ON topic_overrides FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id) AND created_by = adeena.current_user_id()
);

CREATE POLICY topic_candidates_select ON topic_candidates FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY topic_candidates_insert ON topic_candidates FOR INSERT WITH CHECK (adeena.is_active_member(workspace_id));

CREATE POLICY recommendation_runs_select ON recommendation_runs FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY recommendation_runs_insert ON recommendation_runs FOR INSERT WITH CHECK (adeena.is_active_member(workspace_id));
CREATE POLICY recommendation_runs_update ON recommendation_runs
  FOR UPDATE USING (adeena.is_active_member(workspace_id))
  WITH CHECK (adeena.is_active_member(workspace_id));

REVOKE ALL ON topic_overrides, topic_candidates, recommendation_runs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON topic_overrides, topic_candidates, recommendation_runs TO adeena_app;

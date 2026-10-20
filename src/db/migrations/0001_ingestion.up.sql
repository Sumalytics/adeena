CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  workspace_type text NOT NULL CHECK (workspace_type IN ('personal', 'organization')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_not_synthetic CHECK (id <> '00000000-0000-4000-8000-000000000001'::uuid)
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_memberships_user_idx ON workspace_memberships (user_id);

CREATE TABLE source_documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE source_document_versions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  parent_version_id uuid,
  original_filename text NOT NULL CHECK (char_length(original_filename) BETWEEN 1 AND 120),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL CHECK (media_type IN (
    'text/plain',
    'text/markdown',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/pdf'
  )),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  storage_locator text NOT NULL CHECK (storage_locator ~ '^private://[0-9a-f-]{36}/[a-f0-9]{64}/original\.bin$'),
  rights_status text NOT NULL CHECK (rights_status IN ('unverified', 'cleared', 'blocked')),
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (document_id, version),
  UNIQUE (workspace_id, content_hash),
  FOREIGN KEY (document_id, workspace_id) REFERENCES source_documents (id, workspace_id),
  FOREIGN KEY (parent_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id)
);

CREATE SCHEMA adeena;

CREATE FUNCTION adeena.reject_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source document versions are immutable';
END;
$$;

CREATE TRIGGER source_document_versions_immutable
BEFORE UPDATE OR DELETE ON source_document_versions
FOR EACH ROW EXECUTE FUNCTION adeena.reject_version_mutation();

CREATE TABLE extraction_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'complete', 'partial', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 8),
  lease_owner text CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9-]{1,80}$'),
  lease_expires_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9-]{1,80}$'),
  permanent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id)
);

CREATE INDEX extraction_jobs_claim_idx ON extraction_jobs (workspace_id, status, lease_expires_at, created_at);

CREATE TABLE extraction_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  job_id uuid NOT NULL,
  extractor_name text NOT NULL CHECK (extractor_name = 'adeena.source-extract'),
  extractor_version text NOT NULL CHECK (extractor_version = '1'),
  status text NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
  canonical_locator text CHECK (
    canonical_locator IS NULL OR canonical_locator ~ '^private://[0-9a-f-]{36}/[a-f0-9]{64}/canonical\.txt$'
  ),
  canonical_text_hash text NOT NULL CHECK (canonical_text_hash ~ '^[a-f0-9]{64}$'),
  page_count integer CHECK (page_count IS NULL OR page_count >= 0),
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_version_id, extractor_name, extractor_version),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id),
  FOREIGN KEY (job_id, workspace_id) REFERENCES extraction_jobs (id, workspace_id)
);

CREATE TABLE knowledge_collections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
  structure_status text NOT NULL CHECK (structure_status IN ('complete', 'partial', 'failed')),
  canonical_text_hash text NOT NULL CHECK (canonical_text_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id)
);

CREATE TABLE source_spans (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  extraction_id uuid NOT NULL,
  text_hash text NOT NULL CHECK (text_hash ~ '^[a-f0-9]{64}$'),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  page_number integer CHECK (page_number IS NULL OR page_number > 0),
  excerpt text NOT NULL CHECK (char_length(excerpt) BETWEEN 1 AND 280),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (document_version_id, workspace_id) REFERENCES source_document_versions (id, workspace_id),
  FOREIGN KEY (extraction_id, workspace_id) REFERENCES extraction_results (id, workspace_id)
);

CREATE TABLE knowledge_nodes (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  parent_id uuid,
  role text NOT NULL CHECK (role IN ('document', 'chapter', 'section', 'block')),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
  node_order integer NOT NULL CHECK (node_order >= 0),
  confidence text NOT NULL CHECK (confidence IN ('reliable', 'ambiguous', 'none')),
  span_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, collection_id),
  UNIQUE (collection_id, node_order),
  FOREIGN KEY (collection_id, workspace_id) REFERENCES knowledge_collections (id, workspace_id),
  FOREIGN KEY (span_id, workspace_id) REFERENCES source_spans (id, workspace_id),
  FOREIGN KEY (parent_id, collection_id) REFERENCES knowledge_nodes (id, collection_id)
);

CREATE INDEX knowledge_nodes_parent_idx ON knowledge_nodes (parent_id);

CREATE TABLE source_processing_costs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  job_id uuid NOT NULL,
  uploaded_bytes integer NOT NULL CHECK (uploaded_bytes >= 0),
  stored_bytes integer NOT NULL CHECK (stored_bytes >= 0),
  processed_pages integer CHECK (processed_pages IS NULL OR processed_pages >= 0),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  operation_status text NOT NULL CHECK (operation_status IN ('complete', 'partial', 'failed')),
  ai_generation_authorized boolean NOT NULL DEFAULT false CHECK (ai_generation_authorized = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, workspace_id) REFERENCES extraction_jobs (id, workspace_id)
);

CREATE FUNCTION adeena.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('adeena.user_id', true), '')::uuid
$$;

CREATE FUNCTION adeena.is_active_member(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships
    WHERE workspace_id = target
      AND user_id = adeena.current_user_id()
      AND status = 'active'
  )
$$;

CREATE FUNCTION adeena.is_owner(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships
    WHERE workspace_id = target
      AND user_id = adeena.current_user_id()
      AND role = 'owner'
      AND status = 'active'
  )
$$;

CREATE FUNCTION adeena.create_workspace(workspace_id uuid, workspace_name text, kind text, owner_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF owner_id IS DISTINCT FROM adeena.current_user_id() THEN
    RAISE EXCEPTION 'workspace owner must be the verified user';
  END IF;
  INSERT INTO public.workspaces (id, name, workspace_type) VALUES (workspace_id, workspace_name, kind);
  INSERT INTO public.workspace_memberships (workspace_id, user_id, role, status)
  VALUES (workspace_id, owner_id, 'owner', 'active');
END;
$$;

REVOKE ALL ON FUNCTION adeena.current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION adeena.is_active_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION adeena.is_owner(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION adeena.create_workspace(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION adeena.reject_version_mutation() FROM PUBLIC;
GRANT USAGE ON SCHEMA adeena TO adeena_app;
GRANT USAGE ON SCHEMA public TO adeena_app;
GRANT EXECUTE ON FUNCTION adeena.current_user_id() TO adeena_app;
GRANT EXECUTE ON FUNCTION adeena.is_active_member(uuid) TO adeena_app;
GRANT EXECUTE ON FUNCTION adeena.is_owner(uuid) TO adeena_app;
GRANT EXECUTE ON FUNCTION adeena.create_workspace(uuid, text, text, uuid) TO adeena_app;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_select ON workspaces FOR SELECT USING (adeena.is_active_member(id));
CREATE POLICY workspaces_update ON workspaces FOR UPDATE USING (adeena.is_owner(id)) WITH CHECK (adeena.is_owner(id));
CREATE POLICY workspaces_insert ON workspaces
FOR INSERT WITH CHECK (adeena.current_user_id() IS NOT NULL);

ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_memberships_select ON workspace_memberships FOR SELECT USING (adeena.is_active_member(workspace_id));
CREATE POLICY workspace_memberships_insert ON workspace_memberships FOR INSERT WITH CHECK (adeena.is_owner(workspace_id));
CREATE POLICY workspace_memberships_update ON workspace_memberships FOR UPDATE USING (adeena.is_owner(workspace_id)) WITH CHECK (adeena.is_owner(workspace_id));

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'source_documents',
    'source_document_versions',
    'extraction_jobs',
    'extraction_results',
    'knowledge_collections',
    'knowledge_nodes',
    'source_spans',
    'source_processing_costs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (adeena.is_active_member(workspace_id))',
      target || '_select',
      target
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (adeena.is_active_member(workspace_id))',
      target || '_insert',
      target
    );
  END LOOP;
END $$;

CREATE POLICY extraction_jobs_update ON extraction_jobs
FOR UPDATE USING (adeena.is_active_member(workspace_id))
WITH CHECK (adeena.is_active_member(workspace_id));

CREATE POLICY source_document_versions_update ON source_document_versions
FOR UPDATE USING (adeena.is_active_member(workspace_id))
WITH CHECK (adeena.is_active_member(workspace_id));

CREATE POLICY source_document_versions_delete ON source_document_versions
FOR DELETE USING (adeena.is_active_member(workspace_id));

DROP POLICY source_document_versions_insert ON source_document_versions;
CREATE POLICY source_document_versions_insert ON source_document_versions
FOR INSERT WITH CHECK (
  adeena.is_active_member(workspace_id)
  AND uploaded_by = adeena.current_user_id()
);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO adeena_app;
REVOKE ALL ON TABLE adeena_schema_migrations FROM adeena_app;
REVOKE CREATE ON SCHEMA public FROM adeena_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON SCHEMA adeena FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON SCHEMA adeena FROM authenticated';
  END IF;
END $$;

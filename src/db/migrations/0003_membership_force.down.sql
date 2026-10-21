DO $$
BEGIN
  IF to_regclass('public.workspace_memberships') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE workspace_memberships NO FORCE ROW LEVEL SECURITY';
  END IF;
END $$;

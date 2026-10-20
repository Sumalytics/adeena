DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'adeena') THEN
    DROP FUNCTION IF EXISTS adeena.personal_workspace_for_session();
  END IF;
END $$;

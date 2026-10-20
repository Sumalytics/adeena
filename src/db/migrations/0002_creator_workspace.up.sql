CREATE FUNCTION adeena.personal_workspace_for_session()
RETURNS TABLE (workspace_id uuid, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.workspace_id, m.status
  FROM public.workspace_memberships AS m
  INNER JOIN public.workspaces AS w ON w.id = m.workspace_id
  WHERE m.user_id = adeena.current_user_id()
    AND m.role = 'owner'
    AND w.workspace_type = 'personal'
    AND w.id <> '00000000-0000-4000-8000-000000000001'::uuid
  ORDER BY m.created_at
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION adeena.personal_workspace_for_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adeena.personal_workspace_for_session() TO adeena_app;

-- Folder-level sharing defaults for project documents.

CREATE TABLE IF NOT EXISTS public.project_file_folder_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  share_with_clients boolean NOT NULL DEFAULT false,
  share_with_subs boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_file_folder_permissions_path_format CHECK (path ~ '^/.+')
);

CREATE UNIQUE INDEX IF NOT EXISTS project_file_folder_permissions_unique_idx
  ON public.project_file_folder_permissions (org_id, project_id, path);

CREATE INDEX IF NOT EXISTS project_file_folder_permissions_org_project_idx
  ON public.project_file_folder_permissions (org_id, project_id);

ALTER TABLE public.project_file_folder_permissions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_file_folder_permissions'
      AND policyname = 'project_file_folder_permissions_access'
  ) THEN
    CREATE POLICY "project_file_folder_permissions_access"
      ON public.project_file_folder_permissions
      FOR ALL
      USING (auth.role() = 'service_role' OR is_org_member(org_id))
      WITH CHECK (auth.role() = 'service_role' OR is_org_member(org_id));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.set_project_file_folder_permissions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_file_folder_permissions_set_updated_at
ON public.project_file_folder_permissions;

CREATE TRIGGER project_file_folder_permissions_set_updated_at
BEFORE UPDATE ON public.project_file_folder_permissions
FOR EACH ROW EXECUTE FUNCTION public.set_project_file_folder_permissions_updated_at();

COMMENT ON TABLE public.project_file_folder_permissions IS
  'Folder-level sharing defaults for project files (client/sub visibility).';

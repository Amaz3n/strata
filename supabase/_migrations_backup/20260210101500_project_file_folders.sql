-- Persist project folders so empty folders and defaults can exist before files are uploaded.

CREATE TABLE IF NOT EXISTS public.project_file_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  created_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_file_folders_path_format CHECK (path ~ '^/.+')
);

CREATE UNIQUE INDEX IF NOT EXISTS project_file_folders_unique_path_idx
  ON public.project_file_folders (org_id, project_id, path);

CREATE INDEX IF NOT EXISTS project_file_folders_org_project_idx
  ON public.project_file_folders (org_id, project_id);

ALTER TABLE public.project_file_folders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_file_folders'
      AND policyname = 'project_file_folders_access'
  ) THEN
    CREATE POLICY "project_file_folders_access"
      ON public.project_file_folders
      FOR ALL
      USING (auth.role() = 'service_role' OR is_org_member(org_id))
      WITH CHECK (auth.role() = 'service_role' OR is_org_member(org_id));
  END IF;
END
$$;

COMMENT ON TABLE public.project_file_folders IS
  'Persisted virtual folders for project documents.';
COMMENT ON COLUMN public.project_file_folders.path IS
  'Normalized virtual folder path (e.g., /contracts/change-orders).';

-- Shareable public links for project files.
-- Grants time-bound, optionally usage-bound access via a random token, with
-- independent download permission. Revocable.

CREATE TABLE IF NOT EXISTS public.file_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  token text NOT NULL,
  label text,
  expires_at timestamptz,
  max_uses integer,
  use_count integer NOT NULL DEFAULT 0,
  allow_download boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  created_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_share_links_max_uses_positive CHECK (max_uses IS NULL OR max_uses > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS file_share_links_token_key
  ON public.file_share_links (token);

CREATE INDEX IF NOT EXISTS file_share_links_file_id_idx
  ON public.file_share_links (file_id);

CREATE INDEX IF NOT EXISTS file_share_links_org_project_idx
  ON public.file_share_links (org_id, project_id);

ALTER TABLE public.file_share_links ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'file_share_links'
      AND policyname = 'file_share_links_access'
  ) THEN
    CREATE POLICY "file_share_links_access"
      ON public.file_share_links
      FOR ALL
      USING (auth.role() = 'service_role' OR is_org_member(org_id))
      WITH CHECK (auth.role() = 'service_role' OR is_org_member(org_id));
  END IF;
END
$$;

COMMENT ON TABLE public.file_share_links IS
  'Tokenized public share links for project files. Access is validated by service-role lookups at the /f/[token] route.';

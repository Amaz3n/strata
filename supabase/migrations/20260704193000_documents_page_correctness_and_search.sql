-- Documents page correctness and scale improvements.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_files_org_project_category_active
  ON public.files (org_id, project_id, category)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_org_project_folder_active
  ON public.files (org_id, project_id, folder_path)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_org_project_archived
  ON public.files (org_id, project_id, archived_at)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_files_org_project_folder_checksum_active
  ON public.files (org_id, project_id, folder_path, checksum)
  WHERE archived_at IS NULL AND checksum IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_files_org_project_due_active
  ON public.files (org_id, project_id, due_at)
  WHERE archived_at IS NULL AND due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_files_file_name_trgm_active
  ON public.files USING gin (file_name gin_trgm_ops)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_description_trgm_active
  ON public.files USING gin (description gin_trgm_ops)
  WHERE archived_at IS NULL AND description IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_file_counts_by_category(
  p_org_id uuid,
  p_project_id uuid DEFAULT NULL
)
RETURNS TABLE(category text, file_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(f.category, 'other') AS category, COUNT(*) AS file_count
  FROM public.files f
  WHERE f.org_id = p_org_id
    AND (p_project_id IS NULL OR f.project_id = p_project_id)
    AND f.archived_at IS NULL
  GROUP BY COALESCE(f.category, 'other')
  ORDER BY category;
$$;

CREATE OR REPLACE FUNCTION public.list_project_document_folders(
  p_org_id uuid,
  p_project_id uuid
)
RETURNS TABLE(path text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT source.path
  FROM (
    SELECT f.folder_path AS path
    FROM public.files f
    WHERE f.org_id = p_org_id
      AND f.project_id = p_project_id
      AND f.archived_at IS NULL
      AND f.folder_path IS NOT NULL
      AND f.folder_path <> '/'

    UNION

    SELECT pff.path
    FROM public.project_file_folders pff
    WHERE pff.org_id = p_org_id
      AND pff.project_id = p_project_id
      AND pff.path IS NOT NULL
      AND pff.path <> '/'
  ) source
  WHERE source.path IS NOT NULL
  ORDER BY source.path;
$$;

CREATE OR REPLACE FUNCTION public.list_project_child_folders(
  p_org_id uuid,
  p_project_id uuid,
  p_parent_path text DEFAULT NULL
)
RETURNS TABLE(path text, name text, item_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH params AS (
    SELECT NULLIF(regexp_replace(COALESCE(p_parent_path, ''), '/+$', ''), '') AS parent_path
  ),
  persisted_paths AS (
    SELECT pff.path AS source_path
    FROM public.project_file_folders pff
    CROSS JOIN params p
    WHERE pff.org_id = p_org_id
      AND pff.project_id = p_project_id
      AND pff.path IS NOT NULL
      AND pff.path <> '/'
      AND (
        p.parent_path IS NULL
        OR pff.path LIKE p.parent_path || '/%'
      )
  ),
  file_paths AS (
    SELECT f.folder_path AS source_path
    FROM public.files f
    CROSS JOIN params p
    WHERE f.org_id = p_org_id
      AND f.project_id = p_project_id
      AND f.archived_at IS NULL
      AND f.folder_path IS NOT NULL
      AND f.folder_path <> '/'
      AND (
        p.parent_path IS NULL
        OR f.folder_path LIKE p.parent_path || '/%'
      )
  ),
  child_paths AS (
    SELECT
      CASE
        WHEN p.parent_path IS NULL THEN '/' || split_part(trim(both '/' FROM pp.source_path), '/', 1)
        ELSE p.parent_path || '/' || split_part(substring(pp.source_path FROM char_length(p.parent_path) + 2), '/', 1)
      END AS child_path,
      0::bigint AS file_count
    FROM persisted_paths pp
    CROSS JOIN params p

    UNION ALL

    SELECT
      CASE
        WHEN p.parent_path IS NULL THEN '/' || split_part(trim(both '/' FROM fp.source_path), '/', 1)
        ELSE p.parent_path || '/' || split_part(substring(fp.source_path FROM char_length(p.parent_path) + 2), '/', 1)
      END AS child_path,
      1::bigint AS file_count
    FROM file_paths fp
    CROSS JOIN params p
  )
  SELECT
    cp.child_path AS path,
    split_part(trim(both '/' FROM cp.child_path), '/', array_length(string_to_array(trim(both '/' FROM cp.child_path), '/'), 1)) AS name,
    SUM(cp.file_count)::bigint AS item_count
  FROM child_paths cp
  WHERE cp.child_path IS NOT NULL
    AND cp.child_path <> '/'
  GROUP BY cp.child_path
  ORDER BY cp.child_path;
$$;

CREATE OR REPLACE FUNCTION public.rename_project_file_folder_paths(
  p_org_id uuid,
  p_project_id uuid,
  p_old_path text,
  p_new_path text,
  p_actor_id uuid DEFAULT NULL
)
RETURNS TABLE(
  affected_files integer,
  affected_folders integer,
  affected_permission_folders integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_files integer := 0;
  v_folders integer := 0;
  v_permissions integer := 0;
BEGIN
  IF p_old_path IS NULL OR p_new_path IS NULL OR p_old_path = '/' OR p_new_path = '/' THEN
    RAISE EXCEPTION 'Folder paths must be non-root paths';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.project_file_folders pff
    WHERE pff.org_id = p_org_id
      AND pff.project_id = p_project_id
      AND pff.path = p_new_path
      AND pff.path <> p_old_path
  ) THEN
    RAISE EXCEPTION 'A folder with that path already exists';
  END IF;

  UPDATE public.files f
  SET folder_path = p_new_path || substring(f.folder_path FROM char_length(p_old_path) + 1),
      updated_at = now()
  WHERE f.org_id = p_org_id
    AND f.project_id = p_project_id
    AND (
      f.folder_path = p_old_path
      OR f.folder_path LIKE p_old_path || '/%'
    );
  GET DIAGNOSTICS v_files = ROW_COUNT;

  UPDATE public.project_file_folders pff
  SET path = p_new_path || substring(pff.path FROM char_length(p_old_path) + 1)
  WHERE pff.org_id = p_org_id
    AND pff.project_id = p_project_id
    AND (
      pff.path = p_old_path
      OR pff.path LIKE p_old_path || '/%'
    );
  GET DIAGNOSTICS v_folders = ROW_COUNT;

  UPDATE public.project_file_folder_permissions pfp
  SET path = p_new_path || substring(pfp.path FROM char_length(p_old_path) + 1),
      updated_by = p_actor_id,
      updated_at = now()
  WHERE pfp.org_id = p_org_id
    AND pfp.project_id = p_project_id
    AND (
      pfp.path = p_old_path
      OR pfp.path LIKE p_old_path || '/%'
    );
  GET DIAGNOSTICS v_permissions = ROW_COUNT;

  RETURN QUERY SELECT v_files, v_folders, v_permissions;
END;
$$;

-- Legacy RPC kept for older clients that only need nested file path movement.
CREATE OR REPLACE FUNCTION public.rename_nested_folder_paths(
  p_org_id uuid,
  p_project_id uuid,
  p_old_path text,
  p_new_path text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_files integer := 0;
BEGIN
  UPDATE public.files f
  SET folder_path = p_new_path || substring(f.folder_path FROM char_length(p_old_path) + 1),
      updated_at = now()
  WHERE f.org_id = p_org_id
    AND f.project_id = p_project_id
    AND f.folder_path LIKE p_old_path || '/%';
  GET DIAGNOSTICS v_files = ROW_COUNT;
  RETURN v_files;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_file_counts_by_category(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_project_document_folders(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_project_child_folders(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rename_project_file_folder_paths(uuid, uuid, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rename_nested_folder_paths(uuid, uuid, text, text) TO authenticated, service_role;

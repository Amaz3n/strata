-- Register "as of" a chosen revision: for each sheet, the version that was
-- current at that revision's point in time (latest published version issued on
-- or before the chosen revision). Sheets introduced in a later revision are
-- omitted, so the list shows exactly one coherent version per sheet for the
-- selected revision. Columns mirror drawing_sheets_list so the existing UI maps
-- it with no changes. SECURITY INVOKER => normal RLS on the base tables applies.
CREATE OR REPLACE FUNCTION public.drawing_register_snapshot(
  p_set_id uuid,
  p_revision_id uuid
)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  project_id uuid,
  drawing_set_id uuid,
  sheet_number text,
  sheet_title text,
  discipline text,
  share_with_clients boolean,
  share_with_subs boolean,
  sort_order integer,
  created_at timestamptz,
  updated_at timestamptz,
  current_version_id uuid,
  thumbnail_url text,
  tile_base_url text,
  tile_manifest jsonb,
  image_width integer,
  image_height integer,
  open_pins_count bigint,
  in_progress_pins_count bigint,
  completed_pins_count bigint,
  total_pins_count bigint,
  pins_by_type jsonb,
  pins_by_status jsonb,
  markups_count bigint,
  set_title text,
  set_status text,
  current_revision_id uuid,
  current_revision_label text,
  current_revision_creator_name text,
  version_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH cutoff AS (
    SELECT r.created_at AS cutoff_at
    FROM drawing_revisions r
    WHERE r.id = p_revision_id
  )
  SELECT
    s.id,
    s.org_id,
    s.project_id,
    s.drawing_set_id,
    s.sheet_number,
    s.sheet_title,
    s.discipline,
    s.share_with_clients,
    s.share_with_subs,
    s.sort_order,
    s.created_at,
    s.updated_at,
    sv.id              AS current_version_id,
    sv.thumbnail_url,
    sv.tile_base_url,
    sv.tile_manifest,
    sv.image_width,
    sv.image_height,
    COALESCE(pin_counts.open_pins, 0)        AS open_pins_count,
    COALESCE(pin_counts.in_progress_pins, 0) AS in_progress_pins_count,
    COALESCE(pin_counts.completed_pins, 0)   AS completed_pins_count,
    COALESCE(pin_counts.total_pins, 0)       AS total_pins_count,
    COALESCE(pin_counts.pins_by_type, '{}'::jsonb)   AS pins_by_type,
    COALESCE(pin_counts.pins_by_status, '{}'::jsonb) AS pins_by_status,
    COALESCE(markup_counts.total_markups, 0) AS markups_count,
    ds.title  AS set_title,
    ds.status AS set_status,
    sv.drawing_revision_id AS current_revision_id,
    rr.revision_label      AS current_revision_label,
    cau.full_name          AS current_revision_creator_name,
    ver_counts.version_count
  FROM drawing_sheets s
  CROSS JOIN cutoff
  LEFT JOIN drawing_sets ds ON ds.id = s.drawing_set_id
  -- the version current "as of" the cutoff revision
  LEFT JOIN LATERAL (
    SELECT v.id, v.thumbnail_url, v.tile_base_url, v.tile_manifest,
           v.image_width, v.image_height, v.drawing_revision_id, v.created_at
    FROM drawing_sheet_versions v
    JOIN drawing_revisions r2 ON r2.id = v.drawing_revision_id
    WHERE v.drawing_sheet_id = s.id
      AND r2.status = 'published'
      AND r2.created_at <= cutoff.cutoff_at
    ORDER BY r2.created_at DESC, v.created_at DESC
    LIMIT 1
  ) sv ON true
  LEFT JOIN drawing_revisions rr ON rr.id = sv.drawing_revision_id
  LEFT JOIN app_users cau ON cau.id = rr.created_by
  LEFT JOIN LATERAL (
    SELECT count(*) AS version_count
    FROM drawing_sheet_versions vv
    JOIN drawing_revisions rv ON rv.id = vv.drawing_revision_id
    WHERE vv.drawing_sheet_id = s.id
      AND rv.status = 'published'
      AND rv.created_at <= cutoff.cutoff_at
  ) ver_counts ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE p.status = ANY (ARRAY['open','pending'])) AS open_pins,
      count(*) FILTER (WHERE p.status = 'in_progress') AS in_progress_pins,
      count(*) FILTER (WHERE p.status = ANY (ARRAY['closed','approved'])) AS completed_pins,
      count(*) AS total_pins,
      (SELECT COALESCE(jsonb_object_agg(t.entity_type, t.cnt), '{}'::jsonb)
         FROM (SELECT entity_type, count(*) AS cnt FROM drawing_pins
                WHERE drawing_sheet_id = s.id GROUP BY entity_type) t
        WHERE t.entity_type IS NOT NULL) AS pins_by_type,
      (SELECT COALESCE(jsonb_object_agg(t.status, t.cnt), '{}'::jsonb)
         FROM (SELECT status, count(*) AS cnt FROM drawing_pins
                WHERE drawing_sheet_id = s.id GROUP BY status) t
        WHERE t.status IS NOT NULL) AS pins_by_status
    FROM drawing_pins p
    WHERE p.drawing_sheet_id = s.id
  ) pin_counts ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS total_markups
    FROM drawing_markups m
    WHERE m.drawing_sheet_id = s.id
  ) markup_counts ON true
  WHERE s.drawing_set_id = p_set_id
    AND sv.id IS NOT NULL
  ORDER BY s.sort_order ASC, s.sheet_number ASC;
$function$;

GRANT EXECUTE ON FUNCTION public.drawing_register_snapshot(uuid, uuid) TO authenticated, service_role;

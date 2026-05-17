-- Fix drawings sheets list: correct joins + view-based RLS.

DROP TRIGGER IF EXISTS refresh_drawing_sheets_list_trigger ON public.drawing_sheet_versions;
DROP FUNCTION IF EXISTS public.refresh_drawing_sheets_list();
DROP MATERIALIZED VIEW IF EXISTS public.drawing_sheets_list;
DROP MATERIALIZED VIEW IF EXISTS public.drawing_sheets_list_mv;
DROP VIEW IF EXISTS public.drawing_sheets_list;

CREATE MATERIALIZED VIEW public.drawing_sheets_list_mv AS
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

  -- Current version (latest version for current revision)
  sv.id AS current_version_id,
  sv.thumbnail_url,
  sv.tile_base_url,
  sv.tile_manifest,
  sv.image_width,
  sv.image_height,

  -- Counts (pre-aggregated)
  COALESCE(pin_counts.open_pins, 0) AS open_pins_count,
  COALESCE(pin_counts.in_progress_pins, 0) AS in_progress_pins_count,
  COALESCE(pin_counts.completed_pins, 0) AS completed_pins_count,
  COALESCE(pin_counts.total_pins, 0) AS total_pins_count,
  COALESCE(pin_counts.pins_by_type, '{}'::jsonb) AS pins_by_type,
  COALESCE(pin_counts.pins_by_status, '{}'::jsonb) AS pins_by_status,
  COALESCE(markup_counts.total_markups, 0) AS markups_count,

  -- Set info
  ds.title AS set_title,
  ds.status AS set_status
FROM drawing_sheets s
LEFT JOIN drawing_sets ds ON ds.id = s.drawing_set_id
LEFT JOIN LATERAL (
  SELECT
    v.id,
    v.thumbnail_url,
    v.tile_base_url,
    v.tile_manifest,
    v.image_width,
    v.image_height
  FROM drawing_sheet_versions v
  WHERE v.drawing_sheet_id = s.id
    AND v.drawing_revision_id = s.current_revision_id
  ORDER BY v.created_at DESC
  LIMIT 1
) sv ON true
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE p.status IN ('open', 'pending')) AS open_pins,
    COUNT(*) FILTER (WHERE p.status = 'in_progress') AS in_progress_pins,
    COUNT(*) FILTER (WHERE p.status IN ('closed', 'approved')) AS completed_pins,
    COUNT(*) AS total_pins,
    (
      SELECT COALESCE(jsonb_object_agg(t.entity_type, t.cnt), '{}'::jsonb)
      FROM (
        SELECT entity_type, COUNT(*) AS cnt
        FROM drawing_pins
        WHERE drawing_sheet_id = s.id
        GROUP BY entity_type
      ) t
      WHERE t.entity_type IS NOT NULL
    ) AS pins_by_type,
    (
      SELECT COALESCE(jsonb_object_agg(t.status, t.cnt), '{}'::jsonb)
      FROM (
        SELECT status, COUNT(*) AS cnt
        FROM drawing_pins
        WHERE drawing_sheet_id = s.id
        GROUP BY status
      ) t
      WHERE t.status IS NOT NULL
    ) AS pins_by_status
  FROM drawing_pins p
  WHERE p.drawing_sheet_id = s.id
) pin_counts ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS total_markups
  FROM drawing_markups m
  WHERE m.drawing_sheet_id = s.id
) markup_counts ON true;

CREATE UNIQUE INDEX idx_drawing_sheets_list_id ON public.drawing_sheets_list_mv(id);
CREATE INDEX idx_drawing_sheets_list_org_project_sort ON public.drawing_sheets_list_mv(org_id, project_id, sort_order);

REVOKE ALL ON TABLE public.drawing_sheets_list_mv FROM anon;
REVOKE ALL ON TABLE public.drawing_sheets_list_mv FROM authenticated;
REVOKE ALL ON TABLE public.drawing_sheets_list_mv FROM public;

CREATE VIEW public.drawing_sheets_list AS
SELECT *
FROM public.drawing_sheets_list_mv
WHERE is_org_member(org_id);

GRANT SELECT ON public.drawing_sheets_list TO authenticated;

COMMENT ON MATERIALIZED VIEW public.drawing_sheets_list_mv IS 'Denormalized list backing MV for drawings sheets (current version + counts)';
COMMENT ON VIEW public.drawing_sheets_list IS 'RLS-safe view for drawings sheets list (filters by is_org_member)';

CREATE OR REPLACE FUNCTION public.refresh_drawing_sheets_list()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  REFRESH MATERIALIZED VIEW public.drawing_sheets_list_mv;
END;
$$;

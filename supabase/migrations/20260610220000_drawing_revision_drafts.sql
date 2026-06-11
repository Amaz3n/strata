-- Revision lifecycle for the draft -> publish flow, plus per-sheet version count
-- and a draft-visibility gate on the sheets list.

-- 1. Revision lifecycle columns. Existing revisions are already live => published.
ALTER TABLE public.drawing_revisions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid;

ALTER TABLE public.drawing_revisions
  DROP CONSTRAINT IF EXISTS drawing_revisions_status_check;
ALTER TABLE public.drawing_revisions
  ADD CONSTRAINT drawing_revisions_status_check
  CHECK (status IN ('processing', 'draft', 'published'));

ALTER TABLE public.drawing_revisions
  DROP CONSTRAINT IF EXISTS drawing_revisions_published_by_fkey;
ALTER TABLE public.drawing_revisions
  ADD CONSTRAINT drawing_revisions_published_by_fkey
  FOREIGN KEY (published_by) REFERENCES public.app_users(id);

-- Backfill published_at for existing published revisions.
UPDATE public.drawing_revisions
  SET published_at = COALESCE(published_at, created_at)
  WHERE status = 'published' AND published_at IS NULL;

CREATE INDEX IF NOT EXISTS drawing_revisions_project_status_idx
  ON public.drawing_revisions (org_id, project_id, status);

-- 2. Recreate the sheets list MV + wrapper view to (a) expose a per-sheet
--    published version_count for labeling, and (b) hide draft-only sheets
--    (current_revision_id IS NULL) from the live register.
DROP MATERIALIZED VIEW IF EXISTS public.drawing_sheets_list_mv CASCADE;

CREATE MATERIALIZED VIEW public.drawing_sheets_list_mv AS
 SELECT s.id,
    s.org_id,
    s.project_id,
    s.drawing_set_id,
    s.sheet_number,
    s.sheet_title,
    s.discipline,
    s.current_revision_id,
    s.share_with_clients,
    s.share_with_subs,
    s.sort_order,
    s.created_at,
    s.updated_at,
    sv.id AS current_version_id,
    sv.thumbnail_url,
    sv.tile_base_url,
    sv.tile_manifest,
    sv.image_width,
    sv.image_height,
    cr.revision_label AS current_revision_label,
    cau.full_name AS current_revision_creator_name,
    COALESCE(ver_counts.version_count, (0)::bigint) AS version_count,
    COALESCE(pin_counts.open_pins, (0)::bigint) AS open_pins_count,
    COALESCE(pin_counts.in_progress_pins, (0)::bigint) AS in_progress_pins_count,
    COALESCE(pin_counts.completed_pins, (0)::bigint) AS completed_pins_count,
    COALESCE(pin_counts.total_pins, (0)::bigint) AS total_pins_count,
    COALESCE(pin_counts.pins_by_type, '{}'::jsonb) AS pins_by_type,
    COALESCE(pin_counts.pins_by_status, '{}'::jsonb) AS pins_by_status,
    COALESCE(markup_counts.total_markups, (0)::bigint) AS markups_count,
    ds.title AS set_title,
    ds.status AS set_status
   FROM ((((((( drawing_sheets s
     LEFT JOIN drawing_sets ds ON ((ds.id = s.drawing_set_id)))
     LEFT JOIN drawing_revisions cr ON ((cr.id = s.current_revision_id)))
     LEFT JOIN app_users cau ON ((cau.id = cr.created_by)))
     LEFT JOIN LATERAL ( SELECT count(*) AS version_count
           FROM (drawing_sheet_versions vv
             JOIN drawing_revisions rr ON ((rr.id = vv.drawing_revision_id)))
          WHERE ((vv.drawing_sheet_id = s.id) AND (rr.status = 'published'))) ver_counts ON (true))
     LEFT JOIN LATERAL ( SELECT v.id,
            v.thumbnail_url,
            v.tile_base_url,
            v.tile_manifest,
            v.image_width,
            v.image_height
           FROM drawing_sheet_versions v
          WHERE ((v.drawing_sheet_id = s.id) AND (v.drawing_revision_id = s.current_revision_id))
          ORDER BY v.created_at DESC
         LIMIT 1) sv ON (true))
     LEFT JOIN LATERAL ( SELECT count(*) FILTER (WHERE (p.status = ANY (ARRAY['open'::text, 'pending'::text]))) AS open_pins,
            count(*) FILTER (WHERE (p.status = 'in_progress'::text)) AS in_progress_pins,
            count(*) FILTER (WHERE (p.status = ANY (ARRAY['closed'::text, 'approved'::text]))) AS completed_pins,
            count(*) AS total_pins,
            ( SELECT COALESCE(jsonb_object_agg(t.entity_type, t.cnt), '{}'::jsonb) AS "coalesce"
                   FROM ( SELECT drawing_pins.entity_type,
                            count(*) AS cnt
                           FROM drawing_pins
                          WHERE (drawing_pins.drawing_sheet_id = s.id)
                          GROUP BY drawing_pins.entity_type) t
                  WHERE (t.entity_type IS NOT NULL)) AS pins_by_type,
            ( SELECT COALESCE(jsonb_object_agg(t.status, t.cnt), '{}'::jsonb) AS "coalesce"
                   FROM ( SELECT drawing_pins.status,
                            count(*) AS cnt
                           FROM drawing_pins
                          WHERE (drawing_pins.drawing_sheet_id = s.id)
                          GROUP BY drawing_pins.status) t
                  WHERE (t.status IS NOT NULL)) AS pins_by_status
           FROM drawing_pins p
          WHERE (p.drawing_sheet_id = s.id)) pin_counts ON (true))
     LEFT JOIN LATERAL ( SELECT count(*) AS total_markups
           FROM drawing_markups m
          WHERE (m.drawing_sheet_id = s.id)) markup_counts ON (true))
  WHERE (s.current_revision_id IS NOT NULL);

CREATE UNIQUE INDEX idx_drawing_sheets_list_id ON public.drawing_sheets_list_mv USING btree (id);
CREATE INDEX idx_drawing_sheets_list_org_project_sort ON public.drawing_sheets_list_mv USING btree (org_id, project_id, sort_order);

REFRESH MATERIALIZED VIEW public.drawing_sheets_list_mv;

CREATE VIEW public.drawing_sheets_list AS
 SELECT id, org_id, project_id, drawing_set_id, sheet_number, sheet_title, discipline,
    share_with_clients, share_with_subs, sort_order, created_at, updated_at,
    current_version_id, thumbnail_url, tile_base_url, tile_manifest, image_width, image_height,
    open_pins_count, in_progress_pins_count, completed_pins_count, total_pins_count,
    pins_by_type, pins_by_status, markups_count, set_title, set_status,
    current_revision_id, current_revision_label, current_revision_creator_name, version_count
   FROM drawing_sheets_list_mv
  WHERE is_org_member(org_id);

GRANT ALL ON public.drawing_sheets_list TO anon;
GRANT ALL ON public.drawing_sheets_list TO authenticated;
GRANT ALL ON public.drawing_sheets_list TO service_role;

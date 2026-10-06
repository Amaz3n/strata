-- Live project-scoped reads remove the global publication refresh.
CREATE VIEW public.drawing_current_register WITH (security_invoker=true) AS
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
     LEFT JOIN drawing_sets ds ON ((ds.id = s.drawing_set_id AND ds.org_id=s.org_id)))
     LEFT JOIN drawing_revisions cr ON ((cr.id = s.current_revision_id AND cr.org_id=s.org_id)))
     LEFT JOIN app_users cau ON ((cau.id = cr.created_by)))
     LEFT JOIN LATERAL ( SELECT count(*) AS version_count
           FROM (drawing_sheet_versions vv
             JOIN drawing_revisions rr ON ((rr.id = vv.drawing_revision_id)))
          WHERE ((vv.drawing_sheet_id = s.id AND vv.org_id=s.org_id AND rr.org_id=s.org_id) AND (rr.status = 'published'))) ver_counts ON (true))
     LEFT JOIN LATERAL ( SELECT v.id,
            v.thumbnail_url,
            v.tile_base_url,
            v.tile_manifest,
            v.image_width,
            v.image_height
           FROM drawing_sheet_versions v
          WHERE ((v.drawing_sheet_id = s.id AND v.org_id=s.org_id) AND (v.drawing_revision_id = s.current_revision_id))
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
                          WHERE (drawing_pins.drawing_sheet_id = s.id AND drawing_pins.org_id=s.org_id)
                          GROUP BY drawing_pins.entity_type) t
                  WHERE (t.entity_type IS NOT NULL)) AS pins_by_type,
            ( SELECT COALESCE(jsonb_object_agg(t.status, t.cnt), '{}'::jsonb) AS "coalesce"
                   FROM ( SELECT drawing_pins.status,
                            count(*) AS cnt
                           FROM drawing_pins
                          WHERE (drawing_pins.drawing_sheet_id = s.id AND drawing_pins.org_id=s.org_id)
                          GROUP BY drawing_pins.status) t
                  WHERE (t.status IS NOT NULL)) AS pins_by_status
           FROM drawing_pins p
          WHERE (p.drawing_sheet_id = s.id AND p.org_id=s.org_id)) pin_counts ON (true))
     LEFT JOIN LATERAL ( SELECT count(*) AS total_markups
           FROM drawing_markups m
          WHERE (m.drawing_sheet_id = s.id AND m.org_id=s.org_id)) markup_counts ON (true))
  WHERE (s.current_revision_id IS NOT NULL);
GRANT SELECT ON public.drawing_current_register TO authenticated,service_role;
CREATE OR REPLACE VIEW public.drawing_sheets_list WITH (security_invoker=true) AS
 SELECT id, org_id, project_id, drawing_set_id, sheet_number, sheet_title, discipline,
    share_with_clients, share_with_subs, sort_order, created_at, updated_at,
    current_version_id, thumbnail_url, tile_base_url, tile_manifest, image_width, image_height,
    open_pins_count, in_progress_pins_count, completed_pins_count, total_pins_count,
    pins_by_type, pins_by_status, markups_count, set_title, set_status,
    current_revision_id, current_revision_label, current_revision_creator_name, version_count
   FROM drawing_current_register
  WHERE is_org_member(org_id);
CREATE INDEX IF NOT EXISTS drawing_current_version_lookup ON public.drawing_sheet_versions(org_id,drawing_sheet_id,drawing_revision_id,created_at DESC);
CREATE INDEX IF NOT EXISTS drawing_live_project_sort ON public.drawing_sheets(org_id,project_id,sort_order,id) WHERE current_revision_id IS NOT NULL;
-- Retain the old RPC for queued historical refresh jobs; it no longer scans all projects.
CREATE OR REPLACE FUNCTION public.refresh_drawing_sheets_list() RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_catalog AS $$BEGIN RETURN; END$$;

-- Publish a draft drawing issuance atomically. This replaces the application
-- loop that could partially update the live register if one sheet failed.
CREATE OR REPLACE FUNCTION public.publish_drawing_revision(
  p_org_id uuid,
  p_revision_id uuid,
  p_user_id uuid,
  p_label text DEFAULT NULL,
  p_issuance_type text DEFAULT NULL,
  p_issued_date date DEFAULT NULL,
  p_issued_by text DEFAULT NULL,
  p_received_from text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_decisions jsonb DEFAULT '{}'::jsonb,
  p_sheet_edits jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  rev record;
  dv record;
  sheet record;
  accept_sheet boolean;
  edits jsonb;
  proposed jsonb;
  was_draft_only boolean;
  new_sheet_number text;
  new_sheet_title text;
  new_discipline text;
  remaining_count bigint;
BEGIN
  SELECT id, org_id, project_id, drawing_set_id, status
    INTO rev
  FROM drawing_revisions
  WHERE org_id = p_org_id
    AND id = p_revision_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Revision not found';
  END IF;

  IF rev.status = 'published' THEN
    RAISE EXCEPTION 'Revision already published';
  END IF;

  FOR dv IN
    SELECT id, drawing_sheet_id, extracted_metadata
    FROM drawing_sheet_versions
    WHERE org_id = p_org_id
      AND drawing_revision_id = p_revision_id
    ORDER BY page_index ASC NULLS LAST, created_at ASC
  LOOP
    SELECT id, current_revision_id
      INTO sheet
    FROM drawing_sheets
    WHERE org_id = p_org_id
      AND id = dv.drawing_sheet_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Drawing sheet not found for version %', dv.id;
    END IF;

    accept_sheet := COALESCE((p_decisions ->> sheet.id::text)::boolean, true);
    was_draft_only := sheet.current_revision_id IS NULL;

    IF accept_sheet THEN
      edits := COALESCE(p_sheet_edits -> sheet.id::text, '{}'::jsonb);
      proposed := COALESCE(dv.extracted_metadata -> 'proposed', '{}'::jsonb);
      new_sheet_number := COALESCE(NULLIF(edits ->> 'sheet_number', ''), proposed ->> 'sheet_number');
      new_sheet_title := COALESCE(NULLIF(edits ->> 'sheet_title', ''), NULLIF(proposed ->> 'sheet_title', ''));
      new_discipline := COALESCE(edits ->> 'discipline', proposed ->> 'discipline');

      UPDATE drawing_sheets
      SET current_revision_id = p_revision_id,
          drawing_set_id = rev.drawing_set_id,
          sheet_number = COALESCE(new_sheet_number, sheet_number),
          sheet_title = CASE
            WHEN new_sheet_title IS NULL THEN sheet_title
            ELSE new_sheet_title
          END,
          discipline = COALESCE(new_discipline, discipline),
          updated_at = now()
      WHERE org_id = p_org_id
        AND id = sheet.id;
    ELSE
      DELETE FROM drawing_sheet_versions
      WHERE org_id = p_org_id
        AND id = dv.id;

      IF was_draft_only THEN
        SELECT count(*)
          INTO remaining_count
        FROM drawing_sheet_versions
        WHERE org_id = p_org_id
          AND drawing_sheet_id = sheet.id;

        IF remaining_count = 0 THEN
          DELETE FROM drawing_sheets
          WHERE org_id = p_org_id
            AND id = sheet.id;
        END IF;
      END IF;
    END IF;
  END LOOP;

  UPDATE drawing_revisions
  SET status = 'published',
      processing_stage = 'published',
      published_at = now(),
      published_by = p_user_id,
      revision_label = COALESCE(NULLIF(p_label, ''), revision_label),
      issuance_type = COALESCE(NULLIF(p_issuance_type, ''), issuance_type),
      issued_date = COALESCE(p_issued_date, issued_date),
      issued_by = NULLIF(p_issued_by, ''),
      received_from = NULLIF(p_received_from, ''),
      notes = NULLIF(p_notes, '')
  WHERE org_id = p_org_id
    AND id = p_revision_id;

  PERFORM refresh_drawing_sheets_list();
END;
$function$;

GRANT EXECUTE ON FUNCTION public.publish_drawing_revision(
  uuid, uuid, uuid, text, text, date, text, text, text, jsonb, jsonb
) TO authenticated, service_role;

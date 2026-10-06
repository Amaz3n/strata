-- Publish state, required follow-up jobs, and receipt are one transaction.
ALTER TABLE public.drawing_revisions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER drawing_revision_updated_at BEFORE UPDATE ON public.drawing_revisions FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE FUNCTION public.drawing_revision_manifest_complete(p_org_id uuid,p_revision_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_catalog AS $$
DECLARE pages integer; modern boolean;
BEGIN
 SELECT total_pages INTO pages FROM drawing_revisions WHERE id=p_revision_id AND org_id=p_org_id;
 IF pages IS NULL OR pages<=0 THEN RETURN false; END IF;
 SELECT EXISTS(SELECT 1 FROM drawing_upload_operations WHERE org_id=p_org_id AND revision_id=p_revision_id) INTO modern;
 RETURN NOT EXISTS(SELECT 1 FROM generate_series(0,pages-1) ordinal WHERE NOT EXISTS(
  SELECT 1 FROM drawing_sheet_versions v WHERE v.org_id=p_org_id AND v.drawing_revision_id=p_revision_id AND v.page_index=ordinal AND (NOT modern OR EXISTS(SELECT 1 FROM drawing_split_pages sp WHERE sp.org_id=p_org_id AND sp.revision_id=p_revision_id AND sp.version_id=v.id AND sp.page_index=ordinal AND sp.state='emitted'))
 ) AND NOT EXISTS(SELECT 1 FROM drawing_deleted_pages d WHERE d.org_id=p_org_id AND d.revision_id=p_revision_id AND d.page_index=ordinal))
 AND NOT EXISTS(SELECT 1 FROM drawing_sheet_versions WHERE org_id=p_org_id AND drawing_revision_id=p_revision_id AND (page_index IS NULL OR page_index<0 OR page_index>=pages));
END $$;
REVOKE ALL ON FUNCTION public.drawing_revision_manifest_complete(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.drawing_revision_manifest_complete(uuid,uuid) TO service_role;
CREATE TABLE public.drawing_publication_receipts(revision_id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES public.orgs(id),user_id uuid,request jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.drawing_publication_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.drawing_publication_receipts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.drawing_publication_receipts TO service_role;
CREATE INDEX drawing_publication_receipts_org ON public.drawing_publication_receipts(org_id);
-- Keep canonical sheet identities when automatic detection proposes an occupied
-- number. Older drafts can contain these proposals even though processing has
-- already assigned their pages unique numbers. Never merge or discard pages.
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
  conflict_constraint text;
  expected text;
  total integer;
  request_data jsonb;
  previous_request jsonb;
BEGIN
  PERFORM 1 FROM projects WHERE org_id=p_org_id AND id=(SELECT project_id FROM drawing_revisions WHERE id=p_revision_id AND org_id=p_org_id) FOR UPDATE;
  PERFORM 1 FROM outbox WHERE org_id=p_org_id AND status='processing' AND (payload->>'draftRevisionId'=p_revision_id::text OR payload->>'revisionId'=p_revision_id::text) ORDER BY id FOR UPDATE;
  SELECT id, org_id, project_id, drawing_set_id, status, total_pages, source_file_id, updated_at, cancelled_at
    INTO rev
  FROM drawing_revisions
  WHERE org_id = p_org_id
    AND id = p_revision_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Revision not found';
  END IF;

  request_data:=jsonb_build_object('label',p_label,'issuance_type',p_issuance_type,'issued_date',p_issued_date,'issued_by',p_issued_by,'received_from',p_received_from,'notes',p_notes,'decisions',p_decisions,'sheet_edits',p_sheet_edits - '__expected_revision_updated_at');
  IF rev.status = 'published' THEN
    SELECT request INTO previous_request FROM drawing_publication_receipts WHERE revision_id=p_revision_id AND org_id=p_org_id;
    IF previous_request IS NULL THEN RAISE EXCEPTION 'Revision was already published'; END IF;
    IF previous_request<>request_data THEN RAISE EXCEPTION 'Publication request differs from the committed revision'; END IF;
    RETURN;
  END IF;

  IF rev.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'Revision cancelled'; END IF;
  expected:=p_sheet_edits->>'__expected_revision_updated_at';
  IF expected IS NOT NULL AND rev.updated_at IS DISTINCT FROM expected::timestamptz THEN RAISE EXCEPTION 'Revision changed; reload before publishing'; END IF;
  SELECT count(*) INTO total FROM drawing_sheet_versions WHERE org_id=p_org_id AND drawing_revision_id=p_revision_id;
  IF NOT public.drawing_revision_manifest_complete(p_org_id,p_revision_id) THEN RAISE EXCEPTION 'Drawing page manifest is incomplete'; END IF;
  IF NOT EXISTS(SELECT 1 FROM drawing_sheet_versions WHERE org_id=p_org_id AND drawing_revision_id=p_revision_id AND COALESCE((p_decisions->>drawing_sheet_id::text)::boolean,true)) THEN RAISE EXCEPTION 'Accept at least one sheet'; END IF;
  -- Lock accepted identities before validation; metadata workers serialize behind these locks.
  PERFORM 1 FROM drawing_sheet_versions WHERE org_id=p_org_id AND drawing_revision_id=p_revision_id ORDER BY id FOR UPDATE;
  FOR dv IN
    SELECT id, drawing_sheet_id, extracted_metadata, tile_manifest, artifact_id, tiles_base_path
    FROM drawing_sheet_versions
    WHERE org_id = p_org_id
      AND drawing_revision_id = p_revision_id
    ORDER BY page_index ASC NULLS LAST, created_at ASC
  LOOP
    SELECT id, current_revision_id, sheet_number
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
      IF edits->>'version_id' IS NOT NULL AND edits->>'version_id'<>dv.id::text THEN RAISE EXCEPTION 'Drawing version changed; reload before publishing'; END IF;
      IF dv.artifact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM drawing_artifacts a WHERE a.id=dv.artifact_id AND a.org_id=p_org_id AND a.state='active' AND a.storage_prefix=dv.tiles_base_path AND public.drawing_manifest_complete(a.render_output->'tile_manifest')) THEN RAISE EXCEPTION 'Drawing artifact is not ready'; END IF;
      IF NOT public.drawing_manifest_complete(dv.tile_manifest) THEN RAISE EXCEPTION 'An accepted drawing is not ready'; END IF;
      IF (COALESCE((dv.extracted_metadata->'sheet_detection'->>'vision_pending')::boolean,false)
          OR COALESCE(dv.extracted_metadata->'sheet_detection'->>'confidence','low')<>'high'
          OR dv.extracted_metadata->'sheet_detection' ? 'vision_error')
        AND NOT COALESCE((edits->>'identity_reviewed')::boolean,false)
        AND NOT COALESCE((dv.extracted_metadata->>'identity_reviewed')::boolean,false)
      THEN RAISE EXCEPTION 'Confirm the identity of every uncertain drawing'; END IF;
      IF COALESCE((edits->>'identity_reviewed')::boolean,false) THEN
        IF edits->>'version_id' IS DISTINCT FROM dv.id::text THEN RAISE EXCEPTION 'Identity confirmation requires the current version'; END IF;
        UPDATE drawing_sheet_versions SET extracted_metadata=extracted_metadata||jsonb_build_object('identity_reviewed',true,'identity_reviewed_by',p_user_id,'identity_reviewed_at',clock_timestamp()) WHERE id=dv.id AND org_id=p_org_id;
      END IF;
      proposed := COALESCE(dv.extracted_metadata -> 'proposed', '{}'::jsonb);
      new_sheet_number := COALESCE(NULLIF(edits ->> 'sheet_number', ''), proposed ->> 'sheet_number');
      new_sheet_title := COALESCE(NULLIF(edits ->> 'sheet_title', ''), NULLIF(proposed ->> 'sheet_title', ''));
      new_discipline := COALESCE(edits ->> 'discipline', proposed ->> 'discipline');

      -- Let the unique index arbitrate concurrent uploads too. Only an
      -- automatic proposal may fall back; an explicit edit needs correction.
      BEGIN
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
      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
        IF conflict_constraint <> 'drawing_sheets_project_sheet_number_key' THEN
          RAISE;
        END IF;
        IF NULLIF(btrim(edits ->> 'sheet_number'), '') IS NOT NULL THEN
          RAISE EXCEPTION 'Sheet number "%" is already in use in this project. Choose a unique sheet number and publish again.', new_sheet_number;
        END IF;

        -- Preserve this sheet and its version, markups, and takeoff references.
        UPDATE drawing_sheets
        SET current_revision_id = p_revision_id,
            drawing_set_id = rev.drawing_set_id,
            sheet_number = sheet.sheet_number,
            sheet_title = CASE
              WHEN new_sheet_title IS NULL THEN sheet_title
              ELSE new_sheet_title
            END,
            discipline = COALESCE(new_discipline, discipline),
            updated_at = now()
        WHERE org_id = p_org_id
          AND id = sheet.id;
        UPDATE drawing_sheet_versions
        SET extracted_metadata = jsonb_set(
          COALESCE(extracted_metadata, '{}'::jsonb), '{proposed}',
          proposed || jsonb_build_object('sheet_number', sheet.sheet_number)
        )
        WHERE org_id = p_org_id AND id = dv.id;
      END;
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

  UPDATE drawing_sets SET source_file_id=rev.source_file_id WHERE id=rev.drawing_set_id AND org_id=p_org_id;
  INSERT INTO outbox(org_id,job_type,payload,run_at) VALUES
   (p_org_id,'reanchor_takeoff_markups',jsonb_build_object('revision_id',p_revision_id),now()),
   (p_org_id,'detect_drawing_changes',jsonb_build_object('orgId',p_org_id,'revisionId',p_revision_id),now()),
   (p_org_id,'cleanup_drawing_storage',jsonb_build_object('orgId',p_org_id),now());
  INSERT INTO drawing_publication_receipts(revision_id,org_id,user_id,request) VALUES(p_revision_id,p_org_id,p_user_id,request_data);
  INSERT INTO events(org_id,event_type,entity_type,entity_id,payload) VALUES(p_org_id,'drawing_revision_published','drawing_revision',p_revision_id,jsonb_build_object('project_id',rev.project_id));
  INSERT INTO audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES(p_org_id,p_user_id,'update','drawing_revision',p_revision_id,jsonb_build_object('status','published'));
END;
$function$;

REVOKE ALL ON FUNCTION public.publish_drawing_revision(uuid,uuid,uuid,text,text,date,text,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_drawing_revision(uuid,uuid,uuid,text,text,date,text,text,text,jsonb,jsonb) TO service_role;

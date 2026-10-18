-- Internal lifecycle records. User entry points authorize project permissions before
-- calling these SECURITY INVOKER, service-role-only transactions.
CREATE TABLE public.drawing_upload_operations (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 project_id uuid NOT NULL REFERENCES public.projects(id), user_id uuid NOT NULL REFERENCES public.app_users(id),
 generation uuid NOT NULL DEFAULT gen_random_uuid(), intent jsonb NOT NULL,
 storage_path text NOT NULL, status text NOT NULL DEFAULT 'reserved'
 CHECK(status IN ('reserved','registered','cancelled','expired')),
 transfer_id uuid, multipart_upload_id text,
 file_id uuid, revision_id uuid, drawing_set_id uuid,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,storage_path)
);
ALTER TABLE public.drawing_upload_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.drawing_upload_operations FROM anon, authenticated;
GRANT ALL ON public.drawing_upload_operations TO service_role;
CREATE INDEX drawing_upload_operations_project ON public.drawing_upload_operations(org_id,project_id,status);
CREATE INDEX drawing_upload_operations_user ON public.drawing_upload_operations(user_id);
CREATE INDEX drawing_upload_operations_expiry ON public.drawing_upload_operations(expires_at) WHERE status='reserved';
CREATE UNIQUE INDEX drawing_upload_operations_admission ON public.drawing_upload_operations(project_id) WHERE status='reserved';
CREATE TRIGGER drawing_upload_operations_updated_at BEFORE UPDATE ON public.drawing_upload_operations FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TABLE public.drawing_abandoned_uploads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES public.orgs(id),operation_id uuid NOT NULL,
 generation uuid NOT NULL,storage_path text NOT NULL,multipart_upload_id text,not_before timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 cleaned_at timestamptz,UNIQUE(operation_id,generation)
);
ALTER TABLE public.drawing_abandoned_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.drawing_abandoned_uploads FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.drawing_abandoned_uploads TO service_role;
CREATE INDEX drawing_abandoned_uploads_due ON public.drawing_abandoned_uploads(not_before) WHERE cleaned_at IS NULL;
CREATE FUNCTION public.reserve_drawing_upload(p_id uuid,p_org_id uuid,p_project_id uuid,p_user_id uuid,p_intent jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_catalog AS $$
DECLARE op drawing_upload_operations; gen uuid:=gen_random_uuid();
BEGIN
 PERFORM 1 FROM projects WHERE id=p_project_id AND org_id=p_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project not found'; END IF;
 SELECT * INTO op FROM drawing_upload_operations WHERE id=p_id FOR UPDATE;
 IF FOUND THEN
  IF op.org_id<>p_org_id OR op.project_id<>p_project_id OR op.user_id<>p_user_id OR op.intent<>p_intent THEN
   RAISE EXCEPTION 'Upload operation conflicts with its original request';
  END IF;
  IF op.status='registered' THEN RETURN to_jsonb(op); END IF;
  IF op.status='cancelled' THEN RAISE EXCEPTION 'Upload cancelled'; END IF;
  IF op.status='reserved' AND op.expires_at>now() THEN RETURN to_jsonb(op); END IF;
 END IF;
 UPDATE drawing_upload_operations SET status='expired' WHERE project_id=p_project_id AND org_id=p_org_id AND status='reserved' AND expires_at<=now();
 IF EXISTS(SELECT 1 FROM drawing_upload_operations WHERE org_id=p_org_id AND project_id=p_project_id AND status='reserved') THEN RAISE EXCEPTION 'Another upload is reserved for this project'; END IF;
 IF EXISTS(SELECT 1 FROM drawing_revisions WHERE org_id=p_org_id AND project_id=p_project_id AND status IN ('processing','draft')) THEN
  RAISE EXCEPTION 'A revision is already pending review. Publish or discard it before uploading another.';
 END IF;
 IF op.id IS NOT NULL THEN
  IF NULLIF(op.intent->>'sourceFileId','') IS NULL THEN
   INSERT INTO drawing_abandoned_uploads(org_id,operation_id,generation,storage_path,multipart_upload_id) VALUES(op.org_id,op.id,op.generation,op.storage_path,op.multipart_upload_id) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE drawing_upload_operations SET status='reserved',generation=gen,storage_path=p_org_id::text||'/'||p_project_id::text||'/drawings/uploads/'||p_id::text||'/'||gen::text||'.pdf',transfer_id=NULL,multipart_upload_id=NULL,expires_at=now()+interval '24 hours' WHERE id=op.id RETURNING * INTO op;
  RETURN to_jsonb(op);
 END IF;
 INSERT INTO drawing_upload_operations(id,org_id,project_id,user_id,generation,intent,storage_path)
 VALUES(p_id,p_org_id,p_project_id,p_user_id,gen,p_intent,
  p_org_id::text||'/'||p_project_id::text||'/drawings/uploads/'||p_id::text||'/'||gen::text||'.pdf') RETURNING * INTO op;
 RETURN to_jsonb(op);
END $$;
CREATE FUNCTION public.claim_drawing_upload_transfer(p_id uuid,p_org_id uuid,p_project_id uuid,p_user_id uuid,p_transfer_id uuid,p_upload_id text DEFAULT NULL,p_generation uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_catalog AS $$
DECLARE op drawing_upload_operations;
BEGIN
 SELECT * INTO op FROM drawing_upload_operations WHERE id=p_id AND org_id=p_org_id AND project_id=p_project_id AND user_id=p_user_id FOR UPDATE;
 IF NOT FOUND OR op.status<>'reserved' OR op.expires_at<=now() OR op.generation IS DISTINCT FROM p_generation THEN RAISE EXCEPTION 'Upload reservation is not active'; END IF;
 IF op.transfer_id IS NOT NULL AND op.transfer_id<>p_transfer_id THEN RAISE EXCEPTION 'Upload is already owned by another transfer'; END IF;
 UPDATE drawing_upload_operations SET transfer_id=p_transfer_id,
 multipart_upload_id=COALESCE(multipart_upload_id,p_upload_id),updated_at=now() WHERE id=op.id RETURNING * INTO op;
 RETURN to_jsonb(op);
END $$;
CREATE FUNCTION public.cancel_drawing_upload(p_id uuid,p_org_id uuid,p_project_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_catalog AS $$
DECLARE op drawing_upload_operations;
BEGIN
 PERFORM 1 FROM projects WHERE id=p_project_id AND org_id=p_org_id FOR UPDATE;
 SELECT * INTO op FROM drawing_upload_operations WHERE id=p_id AND org_id=p_org_id AND project_id=p_project_id AND user_id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Upload not found'; END IF;
 IF op.status='registered' THEN RETURN to_jsonb(op); END IF;
 IF NULLIF(op.intent->>'sourceFileId','') IS NULL THEN
  INSERT INTO drawing_abandoned_uploads(org_id,operation_id,generation,storage_path,multipart_upload_id) VALUES(op.org_id,op.id,op.generation,op.storage_path,op.multipart_upload_id) ON CONFLICT DO NOTHING;
 END IF;
 UPDATE drawing_upload_operations SET status='cancelled',updated_at=now() WHERE id=op.id RETURNING * INTO op;
 RETURN to_jsonb(op);
END $$;
CREATE FUNCTION public.finalize_drawing_upload(p_id uuid,p_org_id uuid,p_project_id uuid,p_user_id uuid,p_storage_path text,p_generation uuid,p_verified_size bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_catalog AS $$
DECLARE op drawing_upload_operations; f files; sid uuid; rid uuid; label text; project_name text;
BEGIN
 -- Same project lock as reserve and deletion. No file/revision can escape a failed transaction.
 SELECT name INTO project_name FROM projects WHERE id=p_project_id AND org_id=p_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project not found'; END IF;
 SELECT * INTO op FROM drawing_upload_operations WHERE id=p_id AND org_id=p_org_id AND project_id=p_project_id AND user_id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Upload reservation not found'; END IF;
 IF op.status='registered' THEN RETURN to_jsonb(op); END IF;
 IF op.status<>'reserved' OR op.expires_at<=now() OR op.generation<>p_generation THEN RAISE EXCEPTION 'Upload reservation is not active'; END IF;
 IF p_verified_size IS NULL OR p_verified_size<=0 OR p_verified_size<>(op.intent->>'fileSize')::bigint THEN RAISE EXCEPTION 'Uploaded PDF size mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM drawing_revisions WHERE org_id=p_org_id AND project_id=p_project_id AND status IN ('processing','draft')) THEN
  RAISE EXCEPTION 'A revision is already pending review. Publish or discard it before uploading another.';
 END IF;
 IF NULLIF(op.intent->>'targetSheetId','') IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM drawing_sheets WHERE id=(op.intent->>'targetSheetId')::uuid AND org_id=p_org_id AND project_id=p_project_id) THEN RAISE EXCEPTION 'Target sheet not found'; END IF;
 IF NULLIF(op.intent->>'sourceFileId','') IS NOT NULL THEN
  SELECT * INTO f FROM files WHERE id=(op.intent->>'sourceFileId')::uuid AND org_id=p_org_id AND project_id=p_project_id AND archived_at IS NULL AND mime_type='application/pdf';
  IF NOT FOUND OR f.storage_path<>p_storage_path OR f.size_bytes<>p_verified_size THEN RAISE EXCEPTION 'Source document not found'; END IF;
 ELSE
  IF p_storage_path<>op.storage_path THEN RAISE EXCEPTION 'Upload path does not match reservation'; END IF;
  INSERT INTO files(org_id,project_id,file_name,storage_path,mime_type,size_bytes,visibility,category,source,uploaded_by)
  VALUES(p_org_id,p_project_id,op.intent->>'fileName',op.storage_path,'application/pdf',(op.intent->>'fileSize')::bigint,'private','plans','upload',p_user_id) RETURNING * INTO f;
 END IF;
 SELECT id INTO sid FROM drawing_sets WHERE org_id=p_org_id AND project_id=p_project_id ORDER BY created_at,id LIMIT 1;
 IF sid IS NULL THEN
  INSERT INTO drawing_sets(org_id,project_id,title,set_type,status,processing_stage,created_by)
  VALUES(p_org_id,p_project_id,COALESCE(NULLIF(op.intent->>'title',''),project_name||' Drawings'),NULLIF(op.intent->>'setType',''),'ready','ready',p_user_id) RETURNING id INTO sid;
 END IF;
 SELECT COALESCE(NULLIF(op.intent->>'issuanceLabel',''),CASE WHEN count(*)=0 THEN 'Initial Set' ELSE 'Revision '||(count(*)+1)::text END)
 INTO label FROM drawing_revisions WHERE org_id=p_org_id AND project_id=p_project_id AND status='published';
 INSERT INTO drawing_revisions(org_id,project_id,drawing_set_id,revision_label,issuance_type,status,processing_stage,issued_date,issued_by,received_from,notes,source_file_id,created_by)
 VALUES(p_org_id,p_project_id,sid,label,COALESCE(op.intent->>'issuanceType','revision'),'processing','queued',COALESCE(NULLIF(op.intent->>'issuedDate','')::date,current_date),NULLIF(op.intent->>'issuedBy',''),NULLIF(op.intent->>'receivedFrom',''),NULLIF(op.intent->>'notes',''),f.id,p_user_id) RETURNING id INTO rid;
 INSERT INTO outbox(org_id,job_type,payload,run_at)
 VALUES(p_org_id,'process_drawing_set',jsonb_build_object('drawingSetId',sid,'projectId',p_project_id,'sourceFileId',f.id,'storagePath',f.storage_path,'draftRevisionId',rid,'orgId',p_org_id,'targetSheetId',op.intent->>'targetSheetId','uploadOperationId',op.id),now());
 INSERT INTO events(org_id,event_type,entity_type,entity_id,payload)
 VALUES(p_org_id,'drawing_upload_registered','drawing_revision',rid,jsonb_build_object('project_id',p_project_id,'operation_id',op.id));
 INSERT INTO audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data)
 VALUES(p_org_id,p_user_id,'insert','drawing_revision',rid,jsonb_build_object('project_id',p_project_id,'operation_id',op.id,'file_id',f.id));
 UPDATE drawing_upload_operations SET status='registered',file_id=f.id,revision_id=rid,drawing_set_id=sid,updated_at=now() WHERE id=op.id RETURNING * INTO op;
 RETURN to_jsonb(op);
END $$;
REVOKE ALL ON FUNCTION public.reserve_drawing_upload(uuid,uuid,uuid,uuid,jsonb),public.claim_drawing_upload_transfer(uuid,uuid,uuid,uuid,uuid,text,uuid),public.cancel_drawing_upload(uuid,uuid,uuid,uuid),public.finalize_drawing_upload(uuid,uuid,uuid,uuid,text,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_drawing_upload(uuid,uuid,uuid,uuid,jsonb),public.claim_drawing_upload_transfer(uuid,uuid,uuid,uuid,uuid,text,uuid),public.cancel_drawing_upload(uuid,uuid,uuid,uuid),public.finalize_drawing_upload(uuid,uuid,uuid,uuid,text,uuid,bigint) TO service_role;

CREATE FUNCTION public.renew_drawing_upload(p_id uuid,p_org_id uuid,p_project_id uuid,p_user_id uuid,p_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_catalog AS $$
DECLARE op drawing_upload_operations;
BEGIN
 PERFORM 1 FROM projects WHERE id=p_project_id AND org_id=p_org_id FOR UPDATE;
 UPDATE drawing_upload_operations SET expires_at=now()+interval '24 hours'
 WHERE id=p_id AND org_id=p_org_id AND project_id=p_project_id AND user_id=p_user_id AND generation=p_generation AND status='reserved' AND expires_at>now() RETURNING * INTO op;
 IF NOT FOUND THEN RAISE EXCEPTION 'Upload expired; reserve again to resume'; END IF;
 RETURN to_jsonb(op);
END $$;
REVOKE ALL ON FUNCTION public.renew_drawing_upload(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.renew_drawing_upload(uuid,uuid,uuid,uuid,uuid) TO service_role;

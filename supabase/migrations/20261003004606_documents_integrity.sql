-- Immutable receipt survives current-version changes and deleted history rows.
CREATE TABLE public.document_upload_commits (
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 storage_path text NOT NULL,
 file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
 PRIMARY KEY(org_id,storage_path)
);
CREATE INDEX document_upload_commits_file ON public.document_upload_commits(file_id);
ALTER TABLE public.document_upload_commits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_upload_commits FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.document_upload_commits TO service_role;

-- Cleanup jobs are retention-pruned, so deleted immutable keys need their own ledger.
CREATE TABLE public.document_blob_tombstones (
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 storage_path text NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,storage_path)
);
ALTER TABLE public.document_blob_tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_blob_tombstones FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.document_blob_tombstones TO service_role;

-- Application services authorize the org/project before these service-only commits.
-- Storage paths are immutable operation keys; ambiguous replies must be retried.
CREATE OR REPLACE FUNCTION public.commit_document_upload(p_org_id uuid,p_actor_id uuid,p_file jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE f public.files; v_id uuid; v_path text:=p_file->>'storage_path'; v_project uuid:=(p_file->>'project_id')::uuid;
BEGIN
 IF v_path IS NULL OR left(v_path,length(p_org_id::text)+1)<>p_org_id::text||'/' THEN RAISE EXCEPTION 'Invalid storage scope'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_org_id::text||v_path,0));
 IF p_file->>'id' IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(p_org_id::text||(p_file->>'id'),1));
   SELECT * INTO f FROM files WHERE org_id=p_org_id AND id=(p_file->>'id')::uuid;
 END IF;
 IF f.id IS NULL THEN
   SELECT source.* INTO f FROM document_upload_commits c JOIN files source ON source.id=c.file_id AND source.org_id=c.org_id WHERE c.org_id=p_org_id AND c.storage_path=v_path;
 END IF;
 IF f.id IS NULL THEN SELECT * INTO f FROM files WHERE org_id=p_org_id AND storage_path=v_path ORDER BY created_at LIMIT 1; END IF;
 IF f.id IS NOT NULL THEN
   IF f.project_id IS DISTINCT FROM v_project THEN RAISE EXCEPTION 'Upload project conflict'; END IF;
   IF p_file->>'request_fingerprint' IS NOT NULL AND f.metadata->>'request_fingerprint' IS DISTINCT FROM p_file->>'request_fingerprint' THEN RAISE EXCEPTION 'Upload content conflict'; END IF;
   INSERT INTO document_upload_commits(org_id,storage_path,file_id) VALUES(p_org_id,v_path,f.id) ON CONFLICT DO NOTHING;
   RETURN to_jsonb(f);
 END IF;
 IF EXISTS(SELECT 1 FROM document_blob_tombstones WHERE org_id=p_org_id AND storage_path=v_path) THEN RAISE EXCEPTION 'Uploaded object was deleted'; END IF;
 IF v_project IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=v_project AND org_id=p_org_id) THEN RAISE EXCEPTION 'Invalid project'; END IF;
 INSERT INTO files(id,org_id,project_id,uploaded_by,file_name,storage_path,mime_type,size_bytes,checksum,visibility,category,folder_path,description,tags,source,share_with_clients,share_with_subs,metadata)
 VALUES(coalesce((p_file->>'id')::uuid,gen_random_uuid()),p_org_id,v_project,p_actor_id,p_file->>'file_name',v_path,p_file->>'mime_type',(p_file->>'size_bytes')::bigint,p_file->>'checksum',coalesce(p_file->>'visibility','private'),p_file->>'category',p_file->>'folder_path',p_file->>'description',ARRAY(SELECT jsonb_array_elements_text(coalesce(p_file->'tags','[]'))),coalesce(p_file->>'source','upload'),coalesce((p_file->>'share_with_clients')::boolean,false),coalesce((p_file->>'share_with_subs')::boolean,false),jsonb_strip_nulls(jsonb_build_object('request_fingerprint',p_file->>'request_fingerprint'))) RETURNING * INTO f;
 INSERT INTO doc_versions(org_id,file_id,version_number,storage_path,file_name,mime_type,size_bytes,checksum,created_by)
 VALUES(p_org_id,f.id,1,f.storage_path,f.file_name,f.mime_type,f.size_bytes,f.checksum,p_actor_id) RETURNING id INTO v_id;
 UPDATE files SET current_version_id=v_id WHERE org_id=p_org_id AND id=f.id RETURNING * INTO f;
 IF v_project IS NOT NULL AND f.folder_path IS NOT NULL AND f.folder_path<>'/' THEN
   INSERT INTO project_file_folders(org_id,project_id,path,created_by) VALUES(p_org_id,v_project,f.folder_path,p_actor_id) ON CONFLICT DO NOTHING;
 END IF;
 INSERT INTO document_upload_commits(org_id,storage_path,file_id) VALUES(p_org_id,v_path,f.id);
 INSERT INTO audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES(p_org_id,p_actor_id,'insert','file',f.id,to_jsonb(f));
 INSERT INTO events(org_id,event_type,entity_type,entity_id,payload) VALUES(p_org_id,'file_created','file',f.id,jsonb_build_object('file_name',f.file_name,'project_id',f.project_id,'actor_id',p_actor_id));
 INSERT INTO outbox(org_id,job_type,payload)
 SELECT p_org_id,'index_file',jsonb_build_object('fileId',f.id,'storagePath',f.storage_path)
 WHERE f.mime_type IN ('application/pdf','image/jpeg','image/png','image/heic','image/heif','image/tiff','text/plain','text/csv');
 INSERT INTO outbox(org_id,job_type,payload)
 SELECT p_org_id,'generate_file_preview',jsonb_build_object('fileId',f.id,'storagePath',f.storage_path)
 WHERE f.mime_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/tiff');

 RETURN to_jsonb(f);
END $$;
REVOKE ALL ON FUNCTION public.commit_document_upload(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_document_upload(uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.commit_document_version(p_org_id uuid,p_file_id uuid,p_actor_id uuid,p_version jsonb,p_initial boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE f public.files; v public.doc_versions; n integer;
BEGIN
 IF left(p_version->>'storage_path',length(p_org_id::text)+1) IS DISTINCT FROM p_org_id::text||'/' THEN RAISE EXCEPTION 'Invalid storage scope'; END IF;
 -- Serialize every reference writer with deletion before the cleanup tombstone.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_org_id::text||(p_version->>'storage_path'),0));
 SELECT * INTO f FROM files WHERE org_id=p_org_id AND id=p_file_id FOR UPDATE;
 IF f.id IS NULL THEN RAISE EXCEPTION 'File not found'; END IF;
 IF EXISTS(SELECT 1 FROM document_upload_commits WHERE org_id=p_org_id AND storage_path=p_version->>'storage_path' AND file_id<>p_file_id)
 OR EXISTS(SELECT 1 FROM doc_versions WHERE org_id=p_org_id AND storage_path=p_version->>'storage_path' AND file_id<>p_file_id)
 OR EXISTS(SELECT 1 FROM files WHERE org_id=p_org_id AND storage_path=p_version->>'storage_path' AND id<>p_file_id) THEN
   RAISE EXCEPTION 'Upload belongs to another file';
 END IF;
 SELECT * INTO v FROM doc_versions WHERE org_id=p_org_id AND file_id=p_file_id AND storage_path=p_version->>'storage_path' ORDER BY version_number LIMIT 1;
 IF v.id IS NOT NULL THEN RETURN to_jsonb(v)||jsonb_build_object('is_current',f.current_version_id=v.id); END IF;
 IF EXISTS(SELECT 1 FROM document_blob_tombstones WHERE org_id=p_org_id AND storage_path=p_version->>'storage_path') THEN RAISE EXCEPTION 'Version was deleted'; END IF;
 SELECT coalesce(max(version_number),0) INTO n FROM doc_versions WHERE org_id=p_org_id AND file_id=p_file_id;
 IF p_initial AND n>0 THEN RETURN NULL; END IF;
 IF NOT p_initial AND n=0 THEN
   INSERT INTO doc_versions(org_id,file_id,version_number,storage_path,file_name,mime_type,size_bytes,checksum,created_by)
   VALUES(p_org_id,f.id,1,f.storage_path,f.file_name,f.mime_type,f.size_bytes,f.checksum,p_actor_id);
   n:=1;
 END IF;
 INSERT INTO doc_versions(org_id,file_id,version_number,storage_path,file_name,mime_type,size_bytes,checksum,label,notes,created_by)
 VALUES(p_org_id,f.id,n+1,p_version->>'storage_path',p_version->>'file_name',p_version->>'mime_type',(p_version->>'size_bytes')::bigint,p_version->>'checksum',p_version->>'label',p_version->>'notes',p_actor_id) RETURNING * INTO v;
 UPDATE files SET current_version_id=v.id,storage_path=v.storage_path,file_name=v.file_name,mime_type=v.mime_type,size_bytes=v.size_bytes,checksum=v.checksum,metadata=metadata-'preview'-'search',updated_at=now() WHERE org_id=p_org_id AND id=f.id RETURNING * INTO f;
 INSERT INTO outbox(org_id,job_type,payload)
 SELECT p_org_id,'index_file',jsonb_build_object('fileId',f.id,'storagePath',f.storage_path)
 WHERE f.mime_type IN ('application/pdf','image/jpeg','image/png','image/heic','image/heif','image/tiff','text/plain','text/csv');
 INSERT INTO outbox(org_id,job_type,payload)
 SELECT p_org_id,'generate_file_preview',jsonb_build_object('fileId',f.id,'storagePath',f.storage_path)
 WHERE f.mime_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/tiff');

 INSERT INTO document_upload_commits(org_id,storage_path,file_id) VALUES(p_org_id,v.storage_path,f.id) ON CONFLICT DO NOTHING;
 INSERT INTO audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES(p_org_id,p_actor_id,'insert','doc_version',v.id,to_jsonb(v));
 INSERT INTO events(org_id,event_type,entity_type,entity_id,payload) VALUES(p_org_id,'file_version_created','file',f.id,jsonb_build_object('version_number',v.version_number,'actor_id',p_actor_id));
 RETURN to_jsonb(v)||jsonb_build_object('is_current',true);
END $$;
REVOKE ALL ON FUNCTION public.commit_document_version(uuid,uuid,uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_document_version(uuid,uuid,uuid,jsonb,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.promote_document_version(p_org_id uuid,p_file_id uuid,p_version_id uuid,p_actor_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE f public.files; v public.doc_versions;
BEGIN
 SELECT * INTO f FROM files WHERE org_id=p_org_id AND id=p_file_id FOR UPDATE;
 SELECT * INTO v FROM doc_versions WHERE org_id=p_org_id AND file_id=p_file_id AND id=p_version_id;
 IF f.id IS NULL OR v.id IS NULL THEN RAISE EXCEPTION 'Version not found'; END IF;
 UPDATE files SET current_version_id=v.id,storage_path=v.storage_path,file_name=v.file_name,mime_type=v.mime_type,size_bytes=v.size_bytes,checksum=v.checksum,metadata=metadata-'preview'-'search',updated_at=now() WHERE org_id=p_org_id AND id=f.id RETURNING * INTO f;
 INSERT INTO outbox(org_id,job_type,payload)
 SELECT p_org_id,'index_file',jsonb_build_object('fileId',f.id,'storagePath',f.storage_path)
 WHERE f.mime_type IN ('application/pdf','image/jpeg','image/png','image/heic','image/heif','image/tiff','text/plain','text/csv');
 INSERT INTO outbox(org_id,job_type,payload)
 SELECT p_org_id,'generate_file_preview',jsonb_build_object('fileId',f.id,'storagePath',f.storage_path)
 WHERE f.mime_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/tiff');

 INSERT INTO audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES(p_org_id,p_actor_id,'update','file',f.id,to_jsonb(f));
 INSERT INTO events(org_id,event_type,entity_type,entity_id,payload) VALUES(p_org_id,'file_version_restored','file',f.id,jsonb_build_object('version_id',v.id,'actor_id',p_actor_id));
END $$;
REVOKE ALL ON FUNCTION public.promote_document_version(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.promote_document_version(uuid,uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_document_version(p_org_id uuid,p_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE f public.files; v public.doc_versions;
BEGIN
 SELECT * INTO v FROM doc_versions WHERE org_id=p_org_id AND id=p_version_id;
 IF v.id IS NULL THEN RETURN NULL; END IF;
 IF v.storage_path IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(p_org_id::text||v.storage_path,0)); END IF;
 SELECT * INTO f FROM files WHERE org_id=p_org_id AND id=v.file_id FOR UPDATE;
 IF f.current_version_id=v.id THEN RAISE EXCEPTION 'Cannot delete current version'; END IF;
 DELETE FROM doc_versions WHERE org_id=p_org_id AND id=v.id;
 IF v.storage_path IS NOT NULL THEN
 INSERT INTO document_blob_tombstones(org_id,storage_path) VALUES(p_org_id,v.storage_path) ON CONFLICT DO NOTHING;
 INSERT INTO outbox(org_id,job_type,payload) VALUES(p_org_id,'delete_file_blob',jsonb_build_object('storagePath',v.storage_path));
 END IF;
 RETURN to_jsonb(v);
END $$;
REVOKE ALL ON FUNCTION public.delete_document_version(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.delete_document_version(uuid,uuid) TO service_role;

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
      OR left(f.folder_path,char_length(p_old_path)+1) = p_old_path || '/'
    );
  GET DIAGNOSTICS v_files = ROW_COUNT;

  UPDATE public.project_file_folders pff
  SET path = p_new_path || substring(pff.path FROM char_length(p_old_path) + 1)
  WHERE pff.org_id = p_org_id
    AND pff.project_id = p_project_id
    AND (
      pff.path = p_old_path
      OR left(pff.path,char_length(p_old_path)+1) = p_old_path || '/'
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
      OR left(pfp.path,char_length(p_old_path)+1) = p_old_path || '/'
    );
  GET DIAGNOSTICS v_permissions = ROW_COUNT;

  RETURN QUERY SELECT v_files, v_folders, v_permissions;
END;
$$;


CREATE TABLE public.file_share_visits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 share_link_id uuid NOT NULL REFERENCES public.file_share_links(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes'
);
CREATE INDEX file_share_visits_org_link ON public.file_share_visits(org_id,share_link_id);
ALTER TABLE public.file_share_visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.file_share_visits FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.file_share_visits TO service_role;

CREATE OR REPLACE FUNCTION public.claim_file_share_visit(p_token text,p_visit_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE l public.file_share_links; g public.file_share_visits;
BEGIN
 SELECT * INTO l FROM file_share_links WHERE token=p_token FOR UPDATE;
 IF l.id IS NULL OR l.revoked_at IS NOT NULL OR l.expires_at<=now() THEN RETURN NULL; END IF;
 IF p_visit_id IS NOT NULL THEN
   SELECT * INTO g FROM file_share_visits WHERE id=p_visit_id AND org_id=l.org_id AND share_link_id=l.id AND expires_at>now();
   IF g.id IS NULL THEN RETURN NULL; END IF;
 ELSE
   IF l.max_uses IS NOT NULL AND l.use_count>=l.max_uses THEN RETURN NULL; END IF;
   UPDATE file_share_links SET use_count=use_count+1 WHERE id=l.id AND org_id=l.org_id;
   INSERT INTO file_share_visits(org_id,share_link_id,expires_at) VALUES(l.org_id,l.id,least(now()+interval '15 minutes',coalesce(l.expires_at,'infinity'::timestamptz))) RETURNING * INTO g;
 END IF;
 RETURN jsonb_build_object('link_id',l.id,'visit_id',g.id);
END $$;
REVOKE ALL ON FUNCTION public.claim_file_share_visit(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_file_share_visit(text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.patch_document_artifact(p_org_id uuid,p_file_id uuid,p_storage_path text,p_kind text,p_value jsonb,p_checksum text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF p_kind NOT IN ('preview','search') OR jsonb_typeof(p_value)<>'object' THEN RAISE EXCEPTION 'Invalid document artifact'; END IF;
 UPDATE files SET metadata=jsonb_set(coalesce(metadata,'{}'),ARRAY[p_kind],p_value),
   checksum=coalesce(p_checksum,checksum)
 WHERE org_id=p_org_id AND id=p_file_id AND storage_path=p_storage_path;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n=1;
END $$;
REVOKE ALL ON FUNCTION public.patch_document_artifact(uuid,uuid,text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.patch_document_artifact(uuid,uuid,text,text,jsonb,text) TO service_role;

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
        OR left(pff.path,char_length(p.parent_path)+1)=p.parent_path||'/'
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
        OR left(f.folder_path,char_length(p.parent_path)+1)=p.parent_path||'/'
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
    AND left(f.folder_path,char_length(p_old_path)+1)=p_old_path||'/';
  GET DIAGNOSTICS v_files = ROW_COUNT;
  RETURN v_files;
END;
$$;


-- The transfer table is introduced by the following migration. PL/pgSQL
-- resolves it on invocation; no cleanup job can run before that table exists.
CREATE OR REPLACE FUNCTION public.expire_document_transfer(p_org_id uuid,p_transfer_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE transfer record;
BEGIN
 SELECT * INTO transfer FROM document_upload_transfers WHERE org_id=p_org_id AND id=p_transfer_id;
 IF NOT FOUND THEN RETURN false; END IF;
 IF transfer.expires_at>now() THEN RAISE EXCEPTION 'Upload has not expired'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_org_id::text||transfer.storage_path,0));
 IF EXISTS(SELECT 1 FROM document_upload_commits WHERE org_id=p_org_id AND storage_path=transfer.storage_path)
 OR EXISTS(SELECT 1 FROM files WHERE org_id=p_org_id AND storage_path=transfer.storage_path)
 OR EXISTS(SELECT 1 FROM doc_versions WHERE org_id=p_org_id AND storage_path=transfer.storage_path) THEN RETURN false; END IF;
 UPDATE document_upload_transfers SET cancelled_at=coalesce(cancelled_at,now()) WHERE org_id=p_org_id AND id=p_transfer_id;
 INSERT INTO document_blob_tombstones(org_id,storage_path) VALUES(p_org_id,transfer.storage_path) ON CONFLICT DO NOTHING;
 -- Sweep again after outstanding single-PUT requests have had time to finish.
 IF now()<transfer.expires_at+interval '1 day' THEN
 INSERT INTO outbox(org_id,job_type,payload,run_at,dedupe_key)
 VALUES(p_org_id,'cleanup_document_transfer',jsonb_build_object('transfer_id',p_transfer_id),transfer.expires_at+interval '1 day','cleanup_document_transfer:final:'||p_transfer_id::text)
 ON CONFLICT DO NOTHING;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.expire_document_transfer(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.expire_document_transfer(uuid,uuid) TO service_role;

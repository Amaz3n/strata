-- Pending deployment: atomic document mutations and short-lived, actor-owned undo receipts.
CREATE TABLE public.document_mutation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('move', 'archive', 'restore')),
  project_ids uuid[] NOT NULL DEFAULT '{}',
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  undone_at timestamptz,
  undo_result jsonb
);
CREATE INDEX document_mutation_receipts_expiry_idx ON public.document_mutation_receipts(expires_at);
CREATE INDEX document_mutation_receipts_actor_idx ON public.document_mutation_receipts(org_id, actor_id, created_at DESC);
ALTER TABLE public.document_mutation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_mutation_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_mutation_receipts TO service_role;

-- Keep receipts small and independent of storage metadata. Visibility is intentionally
-- untouched: moving only adopts the target folder's explicit sharing flags.
CREATE FUNCTION public.document_mutation_file_state(p_file public.files) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', p_file.id, 'project_id', p_file.project_id, 'folder_path', p_file.folder_path,
    'share_with_clients', p_file.share_with_clients, 'share_with_subs', p_file.share_with_subs,
    'archived_at', p_file.archived_at, 'updated_at', p_file.updated_at
  );
$$;
REVOKE ALL ON FUNCTION public.document_mutation_file_state(public.files) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_mutation_file_state(public.files) TO service_role;

-- p_scopes comes ONLY from the permission-checked server read, never from the client.
-- Verify scopes again under row locks so a concurrent project reassignment cannot
-- turn an authorized file into an unauthorized mutation between read and write.
CREATE FUNCTION public.mutate_documents(
  p_org_id uuid, p_actor_id uuid, p_file_ids uuid[], p_scopes jsonb,
  p_kind text, p_folder_path text DEFAULT NULL, p_apply_folder_defaults boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_ids uuid[];
  v_file public.files%ROWTYPE;
  v_after public.files%ROWTYPE;
  v_path text;
  v_clients boolean;
  v_subs boolean;
  v_entries jsonb := '[]'::jsonb;
  v_files jsonb := '[]'::jsonb;
  v_projects uuid[] := '{}';
  v_receipt uuid;
BEGIN
  IF p_org_id IS NULL OR p_actor_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('move','archive','restore') THEN
    RAISE EXCEPTION 'Invalid document mutation';
  END IF;
  SELECT coalesce(array_agg(DISTINCT id ORDER BY id), '{}') INTO v_ids FROM unnest(p_file_ids) id WHERE id IS NOT NULL;
  IF cardinality(v_ids) > 500 THEN RAISE EXCEPTION 'Select at most 500 files'; END IF;
  IF cardinality(v_ids) = 0 THEN RETURN jsonb_build_object('receiptId', NULL, 'projectIds', '[]'::jsonb, 'files', '[]'::jsonb); END IF;
  v_path := nullif(regexp_replace('/' || trim(both '/' FROM btrim(coalesce(p_folder_path,''))), '/+', '/', 'g'), '/');
  IF length(v_path) > 4096 THEN RAISE EXCEPTION 'Folder path is too long'; END IF;
  PERFORM f.id FROM public.files f WHERE f.org_id = p_org_id AND f.id = ANY(v_ids) ORDER BY f.id FOR UPDATE;
  IF (SELECT count(*) FROM public.files f WHERE f.org_id=p_org_id AND f.id=ANY(v_ids)) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'One or more selected files are unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.files f WHERE f.org_id=p_org_id AND f.id=ANY(v_ids)
    AND (NOT coalesce(p_scopes ? f.id::text, false) OR (p_scopes ->> f.id::text) IS DISTINCT FROM f.project_id::text)) THEN
    RAISE EXCEPTION 'File project scope changed; refresh and try again';
  END IF;
  PERFORM p.id FROM public.project_file_folder_permissions p WHERE p.org_id=p_org_id AND p.path=v_path
    AND p.project_id IN (SELECT f.project_id FROM public.files f WHERE f.org_id=p_org_id AND f.id=ANY(v_ids)) FOR SHARE;

  FOR v_file IN SELECT f.* FROM public.files f WHERE f.org_id=p_org_id AND f.id=ANY(v_ids) ORDER BY f.id LOOP
    IF (p_kind='move' AND nullif(v_file.folder_path,'/') IS NOT DISTINCT FROM v_path)
      OR (p_kind='archive' AND v_file.archived_at IS NOT NULL)
      OR (p_kind='restore' AND v_file.archived_at IS NULL) THEN CONTINUE; END IF;
    v_clients := v_file.share_with_clients;
    v_subs := v_file.share_with_subs;
    IF p_kind='move' AND p_apply_folder_defaults AND v_path IS NOT NULL AND v_file.project_id IS NOT NULL THEN
      SELECT p.share_with_clients, p.share_with_subs INTO v_clients, v_subs
        FROM public.project_file_folder_permissions p WHERE p.org_id=p_org_id AND p.project_id=v_file.project_id AND p.path=v_path;
      v_clients := coalesce(v_clients,false);
      v_subs := coalesce(v_subs,false);
    END IF;
    UPDATE public.files SET
      folder_path=CASE WHEN p_kind='move' THEN v_path ELSE folder_path END,
      share_with_clients=v_clients, share_with_subs=v_subs,
      archived_at=CASE WHEN p_kind='archive' THEN clock_timestamp() WHEN p_kind='restore' THEN NULL ELSE archived_at END,
      updated_at=clock_timestamp()
      WHERE org_id=p_org_id AND id=v_file.id RETURNING * INTO v_after;
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'before', public.document_mutation_file_state(v_file), 'after', public.document_mutation_file_state(v_after)));
    v_files := v_files || jsonb_build_array(public.document_mutation_file_state(v_after));
    IF v_file.project_id IS NOT NULL AND NOT v_file.project_id=ANY(v_projects) THEN v_projects := array_append(v_projects,v_file.project_id); END IF;
    INSERT INTO public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
      VALUES(p_org_id,p_actor_id,'update','file',v_file.id,to_jsonb(v_file),to_jsonb(v_after),'document_mutation');
    INSERT INTO public.events(org_id,event_type,entity_type,entity_id,payload)
      VALUES(p_org_id,CASE p_kind WHEN 'move' THEN 'file_moved' WHEN 'archive' THEN 'file_archived' ELSE 'file_restored' END,
        'file',v_file.id,jsonb_build_object('actor_id',p_actor_id,'file_name',v_file.file_name,'folder_path',v_after.folder_path));
    INSERT INTO public.outbox(org_id,job_type,payload) VALUES(p_org_id,'reindex_search',jsonb_build_object('entity_type','file','entity_id',v_file.id));
  END LOOP;
  IF jsonb_array_length(v_entries)=0 THEN RETURN jsonb_build_object('receiptId',NULL,'projectIds','[]'::jsonb,'files','[]'::jsonb); END IF;
  IF p_kind='move' AND v_path IS NOT NULL THEN
    INSERT INTO public.project_file_folders(org_id,project_id,path,created_by)
      SELECT p_org_id,id,v_path,p_actor_id FROM unnest(v_projects) id ON CONFLICT(org_id,project_id,path) DO NOTHING;
  END IF;
  INSERT INTO public.document_mutation_receipts(org_id,actor_id,kind,project_ids,entries)
    VALUES(p_org_id,p_actor_id,p_kind,v_projects,v_entries) RETURNING id INTO v_receipt;
  RETURN jsonb_build_object('receiptId',v_receipt,'projectIds',to_jsonb(v_projects),'files',v_files);
END;
$$;
REVOKE ALL ON FUNCTION public.mutate_documents(uuid,uuid,uuid[],jsonb,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_documents(uuid,uuid,uuid[],jsonb,text,text,boolean) TO service_role;

CREATE FUNCTION public.undo_document_mutation(p_org_id uuid,p_actor_id uuid,p_receipt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_receipt public.document_mutation_receipts%ROWTYPE;
  v_entry jsonb;
  v_file public.files%ROWTYPE;
  v_after public.files%ROWTYPE;
  v_files jsonb := '[]'::jsonb;
  v_result jsonb;
BEGIN
  SELECT * INTO v_receipt FROM public.document_mutation_receipts
    WHERE id=p_receipt_id AND org_id=p_org_id AND actor_id=p_actor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Undo receipt is unavailable'; END IF;
  IF v_receipt.undone_at IS NOT NULL THEN RETURN v_receipt.undo_result; END IF;
  IF v_receipt.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'The undo window has expired'; END IF;
  PERFORM f.id FROM public.files f WHERE f.org_id=p_org_id
    AND f.id IN (SELECT (e->'before'->>'id')::uuid FROM jsonb_array_elements(v_receipt.entries) e) ORDER BY f.id FOR UPDATE;
  -- Validate the entire selection before restoring any row.
  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_receipt.entries) LOOP
    SELECT * INTO v_file FROM public.files WHERE org_id=p_org_id AND id=(v_entry->'before'->>'id')::uuid;
    IF NOT FOUND OR public.document_mutation_file_state(v_file) IS DISTINCT FROM v_entry->'after' THEN
      RAISE EXCEPTION 'A file changed after this operation; undo would overwrite newer work';
    END IF;
  END LOOP;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_receipt.entries) LOOP
    SELECT * INTO v_file FROM public.files WHERE org_id=p_org_id AND id=(v_entry->'before'->>'id')::uuid;
    UPDATE public.files SET folder_path=v_entry->'before'->>'folder_path',
      share_with_clients=(v_entry->'before'->>'share_with_clients')::boolean,
      share_with_subs=(v_entry->'before'->>'share_with_subs')::boolean,
      archived_at=(v_entry->'before'->>'archived_at')::timestamptz, updated_at=clock_timestamp()
      WHERE org_id=p_org_id AND id=v_file.id RETURNING * INTO v_after;
    v_files := v_files || jsonb_build_array(public.document_mutation_file_state(v_after));
    INSERT INTO public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
      VALUES(p_org_id,p_actor_id,'update','file',v_file.id,to_jsonb(v_file),to_jsonb(v_after),'document_mutation_undo');
    INSERT INTO public.events(org_id,event_type,entity_type,entity_id,payload)
      VALUES(p_org_id,'file_mutation_undone','file',v_file.id,jsonb_build_object('actor_id',p_actor_id,'receipt_id',p_receipt_id,'kind',v_receipt.kind));
    INSERT INTO public.outbox(org_id,job_type,payload) VALUES(p_org_id,'reindex_search',jsonb_build_object('entity_type','file','entity_id',v_file.id));
  END LOOP;
  v_result := jsonb_build_object('receiptId',NULL,'projectIds',to_jsonb(v_receipt.project_ids),'files',v_files);
  UPDATE public.document_mutation_receipts SET undone_at=clock_timestamp(),undo_result=v_result WHERE id=p_receipt_id AND org_id=p_org_id;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.undo_document_mutation(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_document_mutation(uuid,uuid,uuid) TO service_role;

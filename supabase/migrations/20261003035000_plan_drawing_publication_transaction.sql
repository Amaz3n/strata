-- STAGED, UNAPPLIED. No application consumer is activated by this migration.
-- External copy precedes this transaction; durable attempt/cleanup coordination
-- and drawing processor ownership remain required before consumer cutover.
create index files_generated_plan_destination_idx on public.files(org_id,project_id,storage_path)
  where source='generated' and metadata->>'source_plan_version_id' is not null;
create index outbox_drawing_revision_receipt_idx on public.outbox
  (org_id,(payload->>'draftRevisionId'),(payload->>'sourceFileId'),id)
  where job_type='process_drawing_set';
create function public.publish_plan_drawing_copy(p_org_id uuid,p_project_id uuid,p_plan_version_id uuid,p_actor_id uuid,p_copy jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_version public.house_plan_versions%rowtype; v_source public.files%rowtype;
 v_file public.files%rowtype; v_set_id uuid; v_revision_id uuid; v_job_id bigint; v_job_status text;
 v_attempt uuid; v_path text; v_size bigint; v_actor uuid; v_metadata jsonb; v_state jsonb; v_manifest jsonb; v_seq bigint; v_receipt jsonb;
begin
 v_pkg:=public.lock_starts_release_write_scope(p_org_id);
 if v_pkg.id is not null then
   if v_pkg.project_id is distinct from p_project_id or public.starts_release_plan_version(v_pkg) is distinct from p_plan_version_id then
     raise exception 'Starts drawing publication scope mismatch' using errcode='42501';
   end if;
   select (payload->>'actor_id')::uuid into v_actor from public.outbox
     where id=(current_setting('request.headers',true)::jsonb->>'x-starts-job-id')::bigint;
   if v_actor is null or v_actor is distinct from p_actor_id then raise exception 'Starts drawing publication actor mismatch' using errcode='42501'; end if;
 end if;
 if p_actor_id is null or jsonb_typeof(p_copy) is distinct from 'object' then raise exception 'Drawing copy evidence is required'; end if;
 v_attempt:=(p_copy->>'attempt_id')::uuid; v_path:=p_copy->>'storage_path'; v_size:=(p_copy->>'size_bytes')::bigint;
 if v_attempt is null or v_size is null or v_size<=0 or nullif(p_copy->>'source_etag','') is null or nullif(p_copy->>'etag','') is null
   or length(p_copy->>'source_etag')>512 or length(p_copy->>'etag')>512 then raise exception 'Drawing copy evidence is incomplete'; end if;
 -- Project lock serializes canonical-set creation and competing publication.
 select metadata into v_metadata from public.projects where org_id=p_org_id and id=p_project_id for update;
 if not found then raise exception 'Drawing project not found'; end if;
 v_metadata:=coalesce(v_metadata,'{}');v_state:=coalesce(v_metadata->'plan_instantiation','{}');v_manifest:=v_state->'drawing_copy_attempt';
 if jsonb_typeof(v_metadata)<>'object' or jsonb_typeof(v_state)<>'object' or jsonb_typeof(v_manifest) is distinct from 'object'
   or v_manifest->>'attempt_id' is distinct from v_attempt::text or v_manifest->>'plan_version_id' is distinct from p_plan_version_id::text
   or v_manifest->>'actor_id' is distinct from p_actor_id::text or v_manifest->>'storage_path' is distinct from v_path
   or (v_manifest->>'size_bytes')::bigint is distinct from v_size or v_manifest->>'source_etag' is distinct from p_copy->>'source_etag'
   or (v_manifest->>'status' in ('reserved','published')) is not true then raise exception 'Drawing copy was not reserved with this evidence'; end if;
 v_seq:=coalesce((v_state->>'seq')::bigint,0);
 if v_seq<0 or v_seq>=9007199254740991 then raise exception 'Instantiation sequence requires repair'; end if;
 select * into v_version from public.house_plan_versions where org_id=p_org_id and id=p_plan_version_id and status='released' for share;
 if not found then raise exception 'Released drawing plan version not found'; end if;
 select * into v_source from public.files where org_id=p_org_id and id=(v_version.bundle_snapshot->>'drawing_source_file_id')::uuid for share;
 if not found then raise exception 'Frozen plan PDF not found'; end if;
 if v_manifest->>'source_file_id' is distinct from v_source.id::text then raise exception 'Drawing reserved source differs from frozen plan'; end if;
 if v_path is distinct from p_org_id::text||'/projects/'||p_project_id::text||'/plans/'||p_plan_version_id::text||'/'||v_attempt::text||'/'||v_source.file_name
   or '..'=any(string_to_array(v_path,'/')) or (v_source.size_bytes is not null and v_source.size_bytes<>v_size) then
   raise exception 'Drawing copy destination or size differs from source';
 end if;
 select * into v_file from public.files where org_id=p_org_id and project_id=p_project_id and storage_path=v_path
   and source='generated' and metadata->>'source_plan_version_id' is not null order by id limit 1 for update;
 if found then
   if v_file.metadata->>'source_plan_version_id' is distinct from p_plan_version_id::text
     or v_file.metadata->>'source_file_id' is distinct from v_source.id::text
     or v_file.metadata->>'plan_copy_attempt_id' is distinct from v_attempt::text
     or v_file.metadata->>'source_storage_etag' is distinct from p_copy->>'source_etag'
     or v_file.metadata->>'storage_etag' is distinct from p_copy->>'etag'
     or v_file.size_bytes is distinct from v_size or v_file.uploaded_by is distinct from p_actor_id then raise exception 'Drawing attempt was already published with different evidence'; end if;
   select r.id,r.drawing_set_id into v_revision_id,v_set_id from public.drawing_revisions r
     join public.drawing_sets s on s.org_id=r.org_id and s.project_id=r.project_id and s.id=r.drawing_set_id
     where r.org_id=p_org_id and r.project_id=p_project_id and r.source_file_id=v_file.id order by r.id limit 1;
   select id,status into v_job_id,v_job_status from public.outbox where org_id=p_org_id and job_type='process_drawing_set'
     and payload->>'draftRevisionId'=v_revision_id::text and payload->>'sourceFileId'=v_file.id::text
     and payload->>'drawingSetId'=v_set_id::text and payload->>'projectId'=p_project_id::text
     and payload->>'orgId'=p_org_id::text and payload->>'storagePath'=v_path order by id limit 1;
   if v_revision_id is null or v_job_id is null then raise exception 'Drawing publication receipt is incomplete'; end if;
   if v_job_status='failed' then raise exception 'Drawing processing failed; retry the processor before replaying publication'; end if;
   perform public.lock_starts_release_write_scope(p_org_id);
   if v_manifest->>'status' is distinct from 'published' or v_manifest->>'etag' is distinct from p_copy->>'etag'
     or v_manifest->'receipt' is distinct from jsonb_build_object('file_id',v_file.id,'drawing_set_id',v_set_id,'revision_id',v_revision_id,'job_id',v_job_id::text) then raise exception 'Drawing publication manifest is incomplete'; end if;
   return jsonb_build_object('file_id',v_file.id,'drawing_set_id',v_set_id,'revision_id',v_revision_id,'job_id',v_job_id::text,'replayed',true);
 end if;
 if v_manifest->>'status'='published' then raise exception 'Published drawing attempt receipt requires repair'; end if;
 if exists(select 1 from public.drawing_revisions where org_id=p_org_id and project_id=p_project_id and status in ('processing','draft')) then
   raise exception 'A drawing revision is already pending review for this project';
 end if;
 insert into public.files(org_id,project_id,file_name,storage_path,mime_type,size_bytes,checksum,visibility,category,folder_path,source,uploaded_by,metadata)
 values(p_org_id,p_project_id,v_source.file_name,v_path,coalesce(v_source.mime_type,'application/pdf'),v_size,v_source.checksum,'private','plans','/plans','generated',p_actor_id,
   jsonb_build_object('source_plan_version_id',p_plan_version_id,'source_file_id',v_source.id,'plan_copy_attempt_id',v_attempt,'source_storage_etag',p_copy->>'source_etag','storage_etag',p_copy->>'etag')) returning * into v_file;
 select id into v_set_id from public.drawing_sets where org_id=p_org_id and project_id=p_project_id order by created_at,id limit 1 for update;
 if found then
   update public.drawing_sets set source_file_id=v_file.id,status='ready',processing_stage='ready' where org_id=p_org_id and id=v_set_id;
 else
   insert into public.drawing_sets(org_id,project_id,title,source_file_id,status,processing_stage,created_by)
     values(p_org_id,p_project_id,'Construction Drawings',v_file.id,'ready','ready',p_actor_id) returning id into v_set_id;
 end if;
 insert into public.drawing_revisions(org_id,project_id,drawing_set_id,revision_label,issuance_type,status,processing_stage,issued_date,source_file_id,created_by)
   values(p_org_id,p_project_id,v_set_id,'Plan v'||v_version.version_number,'revision','processing','queued',current_date,v_file.id,p_actor_id) returning id into v_revision_id;
 perform public.lock_starts_release_write_scope(p_org_id);
 insert into public.outbox(org_id,job_type,payload,run_at) values(p_org_id,'process_drawing_set',jsonb_build_object(
   'drawingSetId',v_set_id,'projectId',p_project_id,'sourceFileId',v_file.id,'storagePath',v_path,'draftRevisionId',v_revision_id,'orgId',p_org_id),now()) returning id into v_job_id;
 v_receipt:=jsonb_build_object('file_id',v_file.id,'drawing_set_id',v_set_id,'revision_id',v_revision_id,'job_id',v_job_id::text);
 update public.projects set metadata=v_metadata||jsonb_build_object('plan_instantiation',v_state||jsonb_build_object('seq',v_seq+1,
   'drawing_copy_attempt',v_manifest||jsonb_build_object('status','published','etag',p_copy->>'etag','receipt',v_receipt,'published_at',clock_timestamp()))) where org_id=p_org_id and id=p_project_id;
 perform public.lock_starts_release_write_scope(p_org_id);
 return jsonb_build_object('file_id',v_file.id,'drawing_set_id',v_set_id,'revision_id',v_revision_id,'job_id',v_job_id::text,'replayed',false);
end $$;
revoke all on function public.publish_plan_drawing_copy(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.publish_plan_drawing_copy(uuid,uuid,uuid,uuid,jsonb) to service_role;

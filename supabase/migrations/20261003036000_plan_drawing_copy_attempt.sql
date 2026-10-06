-- STAGED, UNAPPLIED. Stored within the existing project instantiation ledger.
-- Every ledger writer must increment seq to prevent whole-metadata CAS writes
-- from erasing a reservation or publication receipt.
create function public.reserve_plan_drawing_copy(p_org_id uuid,p_project_id uuid,p_plan_version_id uuid,p_actor_id uuid,p_source_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_metadata jsonb; v_state jsonb; v_attempt jsonb; v_seq bigint;
 v_version public.house_plan_versions%rowtype; v_source public.files%rowtype; v_actor uuid; v_id uuid; v_size bigint; v_etag text;
begin
 v_pkg:=public.lock_starts_release_write_scope(p_org_id);
 if v_pkg.id is not null then
   if v_pkg.project_id is distinct from p_project_id or public.starts_release_plan_version(v_pkg) is distinct from p_plan_version_id then raise exception 'Starts drawing reservation scope mismatch' using errcode='42501'; end if;
   select (payload->>'actor_id')::uuid into v_actor from public.outbox where id=(current_setting('request.headers',true)::jsonb->>'x-starts-job-id')::bigint;
   if v_actor is null or v_actor is distinct from p_actor_id then raise exception 'Starts drawing reservation actor mismatch' using errcode='42501'; end if;
 end if;
 v_size:=(p_source_evidence->>'size_bytes')::bigint; v_etag:=p_source_evidence->>'source_etag';
 if p_actor_id is null or jsonb_typeof(p_source_evidence) is distinct from 'object' or v_size is null or v_size<=0 or nullif(v_etag,'') is null or length(v_etag)>512 then raise exception 'Drawing source evidence is required'; end if;
 select metadata into v_metadata from public.projects where org_id=p_org_id and id=p_project_id for update;
 if not found then raise exception 'Drawing project not found'; end if;
 v_metadata:=coalesce(v_metadata,'{}');v_state:=coalesce(v_metadata->'plan_instantiation','{}');
 if jsonb_typeof(v_metadata)<>'object' or jsonb_typeof(v_state)<>'object' then raise exception 'Instantiation metadata requires repair'; end if;
 select * into v_version from public.house_plan_versions where org_id=p_org_id and id=p_plan_version_id and status='released' for share;
 if not found then raise exception 'Released drawing plan version not found'; end if;
 select * into v_source from public.files where org_id=p_org_id and id=(v_version.bundle_snapshot->>'drawing_source_file_id')::uuid for share;
 if not found or (v_source.size_bytes is not null and v_source.size_bytes<>v_size) then raise exception 'Drawing source evidence differs from file record'; end if;
 if nullif(btrim(v_source.file_name),'') is null or '..'=any(string_to_array(v_source.file_name,'/')) then raise exception 'Drawing source filename requires repair'; end if;
 v_attempt:=v_state->'drawing_copy_attempt';
 if v_attempt is not null then
   if jsonb_typeof(v_attempt)<>'object' or v_attempt->>'plan_version_id' is distinct from p_plan_version_id::text
     or v_attempt->>'source_file_id' is distinct from v_source.id::text or v_attempt->>'actor_id' is distinct from p_actor_id::text
     or v_attempt->>'source_etag' is distinct from v_etag or (v_attempt->>'size_bytes')::bigint is distinct from v_size
     or (v_attempt->>'status' in ('reserved','published')) is not true or nullif(v_attempt->>'attempt_id','') is null then
     raise exception 'Existing drawing copy attempt differs; recover it before reserving another';
   end if;
   if v_attempt->>'storage_path' is distinct from p_org_id::text||'/projects/'||p_project_id::text||'/plans/'||p_plan_version_id::text||'/'||(v_attempt->>'attempt_id')::uuid::text||'/'||v_source.file_name then raise exception 'Drawing copy attempt destination requires repair'; end if;
   if v_attempt->>'status'='published' and (nullif(v_attempt->>'etag','') is null or jsonb_typeof(v_attempt->'receipt') is distinct from 'object'
     or nullif(v_attempt->'receipt'->>'file_id','') is null or nullif(v_attempt->'receipt'->>'drawing_set_id','') is null
     or nullif(v_attempt->'receipt'->>'revision_id','') is null or nullif(v_attempt->'receipt'->>'job_id','') is null) then raise exception 'Published drawing copy receipt requires repair'; end if;
   perform public.lock_starts_release_write_scope(p_org_id);
   return v_attempt;
 end if;
 if exists(select 1 from public.drawing_revisions where org_id=p_org_id and project_id=p_project_id and status in ('processing','draft')) then raise exception 'A drawing revision is already pending review for this project'; end if;
 v_seq:=coalesce((v_state->>'seq')::bigint,0);
 if v_seq<0 or v_seq>=9007199254740991 then raise exception 'Instantiation sequence requires repair'; end if;
 v_id:=gen_random_uuid();
 v_attempt:=jsonb_build_object('attempt_id',v_id,'plan_version_id',p_plan_version_id,'source_file_id',v_source.id,'actor_id',p_actor_id,
   'storage_path',p_org_id::text||'/projects/'||p_project_id::text||'/plans/'||p_plan_version_id::text||'/'||v_id::text||'/'||v_source.file_name,
   'size_bytes',v_size,'source_etag',v_etag,'status','reserved','reserved_at',clock_timestamp());
 update public.projects set metadata=v_metadata||jsonb_build_object('plan_instantiation',v_state||jsonb_build_object('seq',v_seq+1,'drawing_copy_attempt',v_attempt)) where org_id=p_org_id and id=p_project_id;
 perform public.lock_starts_release_write_scope(p_org_id);
 return v_attempt;
end $$;
revoke all on function public.reserve_plan_drawing_copy(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_plan_drawing_copy(uuid,uuid,uuid,uuid,jsonb) to service_role;

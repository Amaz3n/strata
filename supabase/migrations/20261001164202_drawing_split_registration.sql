-- At most eight page identities, versions and pre-PUT intents per transaction.
-- Preserve the single-page collision and calibration rules used by legacy jobs.
create function public.register_drawing_split_batch(p_org_id uuid,p_revision_id uuid,p_pages jsonb)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare p jsonb; r public.drawing_revisions%rowtype; s public.drawing_sheets%rowtype;
 v public.drawing_sheet_versions%rowtype; prior public.drawing_sheet_versions%rowtype;
 v_page_index integer; number text; fallback text; metadata jsonb; calibration jsonb; is_new boolean;
 results jsonb:='[]'; intent jsonb; target uuid;
begin
 if jsonb_typeof(p_pages)<>'array' or jsonb_array_length(p_pages) not between 1 and 8 then raise exception 'Invalid split batch size'; end if;
 select * into r from public.drawing_revisions where id=p_revision_id and org_id=p_org_id for update;
 if not found or r.status not in ('processing','draft') then raise exception 'Drawing revision unavailable'; end if;
 for p in select value from jsonb_array_elements(p_pages) loop
  v_page_index:=(p->>'pageIndex')::integer;
  if p->>'projectId' is distinct from r.project_id::text or p->>'drawingSetId' is distinct from r.drawing_set_id::text
   or p->>'sourceFileId' is distinct from r.source_file_id::text or v_page_index<0 then raise exception 'Split page source mismatch'; end if;
  if exists(select 1 from public.drawing_deleted_pages d where d.org_id=p_org_id and d.revision_id=p_revision_id and d.page_index=v_page_index) then
   results:=results||jsonb_build_array(jsonb_build_object('pageIndex',v_page_index,'state','deleted')); continue;
  end if;
  select * into v from public.drawing_sheet_versions where org_id=p_org_id and drawing_revision_id=p_revision_id and drawing_sheet_versions.page_index=v_page_index;
  if not found then
   number:=p->'metadata'->'proposed'->>'sheet_number'; target:=nullif(p->>'targetSheetId','')::uuid;
   if number is null or length(number)>50 then raise exception 'Invalid proposed sheet number'; end if;
   if target is not null then
    if v_page_index<>0 or r.total_pages<>1 then raise exception 'A single-sheet replacement requires a one-page PDF'; end if;
    select * into s from public.drawing_sheets where id=target and org_id=p_org_id and project_id=r.project_id for update;
    if not found then raise exception 'Target drawing sheet unavailable'; end if;
   else
    select * into s from public.drawing_sheets where org_id=p_org_id and project_id=r.project_id and sheet_number=number for update;
   end if;
   is_new:=not found;
   if is_new then
    insert into public.drawing_sheets(org_id,project_id,drawing_set_id,sheet_number,sheet_title,discipline,current_revision_id,sort_order,share_with_clients,share_with_subs)
    values(p_org_id,r.project_id,r.drawing_set_id,number,p->'metadata'->'proposed'->>'sheet_title',p->'metadata'->'proposed'->>'discipline',null,v_page_index,false,false)
    on conflict(project_id,sheet_number) where sheet_number is not null do nothing returning * into s;
    if not found then
     select * into s from public.drawing_sheets where org_id=p_org_id and project_id=r.project_id and sheet_number=number for update;
     if not found then raise exception 'Drawing sheet collision'; end if;
     is_new:=false;
    end if;
   end if;
   if exists(select 1 from public.drawing_sheet_versions where org_id=p_org_id and drawing_sheet_id=s.id and drawing_revision_id=p_revision_id) then
    if target is not null then raise exception 'Target sheet already has a revision page'; end if;
    fallback:=p->>'tentativeSheetNumber';
    if fallback=number then fallback:=left(fallback,50-length('-P'||(v_page_index+1)::text))||'-P'||(v_page_index+1)::text; end if;
    select * into s from public.drawing_sheets where org_id=p_org_id and project_id=r.project_id and sheet_number=fallback for update;
    is_new:=not found;
    if is_new then
     insert into public.drawing_sheets(org_id,project_id,drawing_set_id,sheet_number,sheet_title,discipline,current_revision_id,sort_order,share_with_clients,share_with_subs)
     values(p_org_id,r.project_id,r.drawing_set_id,fallback,p->'metadata'->'proposed'->>'sheet_title',p->'metadata'->'proposed'->>'discipline',null,v_page_index,false,false)
     on conflict(project_id,sheet_number) where sheet_number is not null do nothing returning * into s;
     if not found then select * into s from public.drawing_sheets where org_id=p_org_id and project_id=r.project_id and sheet_number=fallback for update; is_new:=false; end if;
    end if;
   end if;
   metadata:=(p->'metadata')||jsonb_build_object('is_new_sheet',is_new); calibration:=null;
   if not is_new then
    select * into prior from public.drawing_sheet_versions where org_id=p_org_id and drawing_sheet_id=s.id and extracted_metadata->'calibration' is not null order by created_at desc limit 1;
    if jsonb_typeof(prior.extracted_metadata->'calibration'->'feet_per_image_px')='number' and (prior.extracted_metadata->'calibration'->>'feet_per_image_px')::numeric>0 then
     calibration:=(prior.extracted_metadata->'calibration')||jsonb_build_object('carried_from_version_id',prior.id,'carried_at',clock_timestamp());
     metadata:=metadata||jsonb_build_object('calibration',calibration);
    end if;
   end if;
   insert into public.drawing_sheet_versions(org_id,drawing_sheet_id,drawing_revision_id,file_id,page_index,page_text,extracted_metadata)
   values(p_org_id,s.id,p_revision_id,r.source_file_id,v_page_index,p->>'pageText',metadata) returning * into v;
  end if;
  intent:=public.reserve_drawing_split_page(p_org_id,p_revision_id,p->>'sourceHash',v_page_index,v.id);
  results:=results||jsonb_build_array(intent||jsonb_build_object('pageIndex',v_page_index,'sheetId',v.drawing_sheet_id,'versionId',v.id));
 end loop;
 return results;
end $$;
revoke all on function public.register_drawing_split_batch(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.register_drawing_split_batch(uuid,uuid,jsonb) to service_role;

alter table public.drawing_revisions add column first_viewable_at timestamptz;
create function public.mark_drawing_first_viewable(p_org_id uuid,p_revision_id uuid) returns timestamptz
language plpgsql set search_path=public,pg_catalog as $$
declare started timestamptz;
begin
 update public.drawing_revisions set first_viewable_at=clock_timestamp()
 where id=p_revision_id and org_id=p_org_id and first_viewable_at is null and status in ('processing','draft') returning created_at into started;
 return started;
end $$;
create function public.update_drawing_render_progress(p_org_id uuid,p_revision_id uuid) returns jsonb
language plpgsql set search_path=public,pg_catalog as $$
declare r public.drawing_revisions%rowtype; rendered integer; deleted integer; ready boolean;
begin
 select * into r from public.drawing_revisions where id=p_revision_id and org_id=p_org_id for update;
 if not found then return null; end if;
 select count(distinct v.page_index) into rendered from public.drawing_sheet_versions v
 where v.org_id=p_org_id and v.drawing_revision_id=p_revision_id and public.drawing_manifest_complete(v.tile_manifest)
 and (v.artifact_id is null or exists(select 1 from public.drawing_artifacts a where a.id=v.artifact_id and a.org_id=p_org_id and a.state='active'));
 select count(*) into deleted from public.drawing_deleted_pages d where d.org_id=p_org_id and d.revision_id=p_revision_id and d.page_index>=0 and d.page_index<r.total_pages
 and not exists(select 1 from public.drawing_sheet_versions v where v.org_id=p_org_id and v.drawing_revision_id=p_revision_id and v.page_index=d.page_index);
 ready:=coalesce(r.total_pages>0 and rendered+deleted>=r.total_pages and public.drawing_revision_manifest_complete(p_org_id,p_revision_id),false);
 if r.status in ('processing','draft') then
  update public.drawing_revisions set processed_pages=rendered,
   status=case when ready then 'draft' else status end,
   processing_stage=case when ready then 'ready' else processing_stage end
  where id=p_revision_id and org_id=p_org_id;
 end if;
 return jsonb_build_object('rendered_pages',rendered,'deleted_pages',deleted,'ready',ready,'became_ready',ready and r.status='processing','created_at',r.created_at);
end $$;
revoke all on function public.mark_drawing_first_viewable(uuid,uuid),public.update_drawing_render_progress(uuid,uuid) from public,anon,authenticated;
grant execute on function public.mark_drawing_first_viewable(uuid,uuid),public.update_drawing_render_progress(uuid,uuid) to service_role;

create or replace function public.claim_drawing_jobs(job_types text[], limit_value integer default 3)
returns table(job_id bigint, org_id uuid, job_type text, payload jsonb, retry_count integer, claim_token uuid)
language plpgsql set search_path = public, pg_catalog as $$
begin
  if limit_value < 1 or limit_value > 6 then raise exception 'Invalid drawing claim limit'; end if;
  if exists (select 1 from unnest(job_types) t where t not in
    ('cleanup_drawing_storage','process_drawing_set','split_drawing_chunk','process_drawing_page','enrich_drawing_metadata',
     'generate_drawing_tiles','backfill_drawing_page_text','extract_drawing_vectors','detect_drawing_changes'))
  then raise exception 'Not a drawing job type'; end if;
  return query
  with picked as (
    select o.id from public.outbox o where o.status = 'pending' and o.job_type = any(job_types)
    and o.run_at <= clock_timestamp() order by o.priority desc, o.created_at asc
    limit limit_value for update skip locked
  ) update public.outbox o set status='processing', updated_at=clock_timestamp(),
      drawing_claim_token=gen_random_uuid(), drawing_lease_expires_at=clock_timestamp()+interval '3 minutes'
    from picked where o.id=picked.id
    returning o.id,o.org_id,o.job_type,o.payload||jsonb_build_object('drawingEnqueuedAt',o.created_at),o.retry_count,o.drawing_claim_token;
end $$;


create function public.retry_drawing_revision_pipeline(p_org_id uuid,p_revision_id uuid) returns boolean
language plpgsql set search_path=public,pg_catalog as $$
declare r public.drawing_revisions%rowtype; coordinator bigint; prior_payload jsonb;
begin
 perform 1 from public.outbox where org_id=p_org_id and payload->>'draftRevisionId'=p_revision_id::text order by id for update;
 select * into r from public.drawing_revisions where id=p_revision_id and org_id=p_org_id for update;
 if not found or r.status='published' or r.source_file_id is null then raise exception 'Drawing revision cannot be retried'; end if;
 update public.outbox o set status='pending',retry_count=0,run_at=clock_timestamp(),last_error=null,
 drawing_claim_token=null,drawing_lease_expires_at=null,updated_at=clock_timestamp()
 where o.org_id=p_org_id and o.payload->>'draftRevisionId'=p_revision_id::text
 and ((o.job_type='process_drawing_page' and not exists(
  select 1 from public.drawing_sheet_versions v where v.org_id=p_org_id and v.id=nullif(o.payload->>'versionId','')::uuid
   and public.drawing_manifest_complete(v.tile_manifest) and (v.artifact_id is null or exists(select 1 from public.drawing_artifacts a where a.org_id=p_org_id and a.id=v.artifact_id and a.state='active'))))
 or (o.job_type='enrich_drawing_metadata' and o.status in ('failed','pending','processing') and exists(
  select 1 from public.drawing_sheet_versions v where v.org_id=p_org_id and v.id=nullif(o.payload->>'sheetVersionId','')::uuid and not coalesce((v.extracted_metadata->>'identity_reviewed')::boolean,false))))
 and not exists(select 1 from public.drawing_deleted_pages d where d.org_id=p_org_id and d.revision_id=p_revision_id and d.page_index=nullif(o.payload->>'pageIndex','')::integer);
 select payload into prior_payload from public.outbox where org_id=p_org_id and payload->>'draftRevisionId'=p_revision_id::text and job_type='process_drawing_set' order by created_at desc,id desc limit 1;
 -- Old coordinators/chunks must not compete with the new attempt.
 update public.outbox set status='completed',drawing_claim_token=null,drawing_lease_expires_at=null,last_error='Superseded by manual retry'
 where org_id=p_org_id and payload->>'draftRevisionId'=p_revision_id::text and job_type in ('process_drawing_set','split_drawing_chunk') and status in ('pending','processing','failed');
 insert into public.outbox(org_id,job_type,payload,run_at) values(p_org_id,'process_drawing_set',coalesce(prior_payload,'{}')||jsonb_build_object(
 'orgId',p_org_id,'projectId',r.project_id,'drawingSetId',r.drawing_set_id,'sourceFileId',r.source_file_id,'draftRevisionId',r.id),clock_timestamp()) returning id into coordinator;
 update public.drawing_revisions set status='processing',processing_stage='queued',error_message=null where id=p_revision_id and org_id=p_org_id;
 return true;
end $$;
revoke all on function public.retry_drawing_revision_pipeline(uuid,uuid) from public,anon,authenticated;
grant execute on function public.retry_drawing_revision_pipeline(uuid,uuid) to service_role;

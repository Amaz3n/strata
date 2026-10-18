-- Render receipts outlive the version that produced them. All new worker writes
-- use ownership headers; old workers must drain before consumers are deployed.
alter table public.drawing_artifacts add column render_output jsonb;
alter table public.drawing_artifacts add column writer_claim_token uuid;
alter table public.drawing_artifacts add column retired_at timestamptz;

create function public.drawing_manifest_complete(m jsonb) returns boolean
language sql immutable set search_path=public,pg_catalog as $$
 select coalesce(jsonb_typeof(m)='object' and not(m ? 'Partial')
  and jsonb_typeof(m->'Image')='object'
  and m->'Image'->>'Format' in ('webp','jpg','png')
  and (m->>'Levels') ~ '^[1-9][0-9]*$'
  and (m->'Image'->>'TileSize') ~ '^[1-9][0-9]*$'
  and (m->'Image'->'Size'->>'Width') ~ '^[1-9][0-9]*$'
  and (m->'Image'->'Size'->>'Height') ~ '^[1-9][0-9]*$',false)
$$;
create trigger drawing_worker_artifact_fence before insert or update on public.drawing_artifacts
 for each row execute function public.fence_drawing_worker_write();

create or replace function public.reserve_drawing_artifact(p_org_id uuid,p_version_id uuid,p_fingerprint text,p_recipe text)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare a public.drawing_artifacts%rowtype; v public.drawing_sheet_versions%rowtype; g uuid;
 token uuid:=nullif(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-drawing-claim-token','')::uuid;
begin
 select * into v from public.drawing_sheet_versions where id=p_version_id and org_id=p_org_id for update;
 if not found then raise exception 'Drawing version missing'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||p_fingerprint||p_recipe,0));
 if v.artifact_id is not null then
  select * into a from public.drawing_artifacts where id=v.artifact_id and org_id=p_org_id for update;
  if a.fingerprint=p_fingerprint and a.recipe=p_recipe then
   if a.state='active' and public.drawing_manifest_complete(a.render_output->'tile_manifest') then return to_jsonb(a); end if;
   if a.state='building' and a.writer_version_id=p_version_id and a.writer_claim_token is not distinct from token and a.writer_until>clock_timestamp() then
    update public.drawing_artifacts set writer_until=clock_timestamp()+interval '3 minutes' where id=a.id returning * into a;
    return to_jsonb(a);
   end if;
  end if;
 end if;
 select * into a from public.drawing_artifacts where org_id=p_org_id and fingerprint=p_fingerprint and recipe=p_recipe
  and state='active' and public.drawing_manifest_complete(render_output->'tile_manifest') order by created_at limit 1 for update;
 if not found then
  g:=gen_random_uuid();
  insert into public.drawing_artifacts(org_id,fingerprint,recipe,generation,storage_prefix,writer_version_id,writer_claim_token)
   values(p_org_id,p_fingerprint,p_recipe,g,p_org_id::text||'/artifacts/'||g::text,p_version_id,token) returning * into a;
 end if;
 update public.drawing_sheet_versions set artifact_id=a.id,tile_manifest=null,tile_manifest_path=null,tiles_base_path=null,tile_base_url=null,tile_levels=null,thumbnail_url=null where id=p_version_id and org_id=p_org_id;
 return to_jsonb(a);
end $$;

create function public.renew_drawing_artifact_writer(p_org_id uuid,p_artifact_id uuid,p_version_id uuid)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare token uuid:=nullif(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-drawing-claim-token','')::uuid;
begin
 update public.drawing_artifacts set writer_until=clock_timestamp()+interval '3 minutes'
 where id=p_artifact_id and org_id=p_org_id and state='building' and writer_version_id=p_version_id
 and writer_claim_token is not distinct from token and writer_until>clock_timestamp()
 and exists(select 1 from public.drawing_sheet_versions where id=p_version_id and org_id=p_org_id and artifact_id=p_artifact_id);
 if not found then raise exception 'Artifact writer expired'; end if;
 return true;
end $$;
create or replace function public.activate_drawing_artifact(p_org_id uuid,p_artifact_id uuid,p_version_id uuid)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare a public.drawing_artifacts%rowtype; v public.drawing_sheet_versions%rowtype;
begin
 perform public.renew_drawing_artifact_writer(p_org_id,p_artifact_id,p_version_id);
 select * into a from public.drawing_artifacts where id=p_artifact_id and org_id=p_org_id for update;
 select * into v from public.drawing_sheet_versions where id=p_version_id and org_id=p_org_id and artifact_id=p_artifact_id;
 if not found or not public.drawing_manifest_complete(v.tile_manifest)
  or v.tiles_base_path is distinct from a.storage_prefix
  or v.tile_manifest_path is distinct from a.storage_prefix||'/manifest.json'
  or v.tile_levels is distinct from (v.tile_manifest->>'Levels')::integer
  or v.image_width is distinct from (v.tile_manifest->'Image'->'Size'->>'Width')::integer
  or v.image_height is distinct from (v.tile_manifest->'Image'->'Size'->>'Height')::integer
 then raise exception 'Artifact is incomplete'; end if;
 update public.drawing_artifacts set state='active',writer_until=clock_timestamp(),render_output=jsonb_build_object(
 'id',v.id,'tile_manifest',v.tile_manifest,'tile_base_url',v.tile_base_url,'tile_levels',v.tile_levels,
 'thumbnail_url',v.thumbnail_url,'image_width',v.image_width,'image_height',v.image_height,
 'tile_manifest_path',v.tile_manifest_path,'tiles_base_path',v.tiles_base_path,
 'page_text',v.page_text,'extracted_metadata',v.extracted_metadata) where id=a.id;
 return true;
end $$;
create or replace function public.retire_drawing_artifact(p_org_id uuid,p_artifact_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare a public.drawing_artifacts%rowtype;
begin
 select * into a from public.drawing_artifacts where id=p_artifact_id and org_id=p_org_id for update;
 if not found then return jsonb_build_object('state','missing','retired',false); end if;
 if exists(select 1 from public.drawing_sheet_versions where artifact_id=a.id and org_id=p_org_id) then return jsonb_build_object('state','referenced','retired',false); end if;
 if a.writer_until>clock_timestamp() then return jsonb_build_object('state','writing','retired',false,'retry_after',a.writer_until); end if;
 update public.drawing_artifacts set state='deleting',retired_at=coalesce(retired_at,clock_timestamp()) where id=a.id;
 return jsonb_build_object('state','deleting','storage_prefix',a.storage_prefix,'generation',a.generation,'retired',true);
end $$;
-- Tombstones stay queryable after deletion: a later cleanup sweep must rescan
-- retired prefixes to remove a PUT that was already in flight at lease loss.
create index drawing_artifact_retired_scan on public.drawing_artifacts(retired_at) where retired_at is not null;
revoke all on function public.drawing_manifest_complete(jsonb),public.renew_drawing_artifact_writer(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.drawing_manifest_complete(jsonb),public.renew_drawing_artifact_writer(uuid,uuid,uuid) to service_role;

-- Failure evidence and lease release are one transaction: crashes cannot leave
-- a permanently processing revision or vision_pending flag after the last retry.
create or replace function public.transition_drawing_job_lease(p_id bigint,p_token uuid,p_action text,p_error text default null)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype;
begin
 select * into v_job from public.outbox where id=p_id and status='processing'
  and drawing_claim_token=p_token and drawing_lease_expires_at>clock_timestamp() for update;
 if not found then return false; end if;
 if p_action='heartbeat' then
  update public.outbox set updated_at=clock_timestamp(),drawing_lease_expires_at=clock_timestamp()+interval '3 minutes' where id=p_id;
 elsif p_action='release' then
  update public.outbox set status='pending',drawing_claim_token=null,drawing_lease_expires_at=null,updated_at=clock_timestamp() where id=p_id;
 elsif p_action='complete' then
  update public.outbox set status='completed',last_error=null,drawing_claim_token=null,drawing_lease_expires_at=null,updated_at=clock_timestamp() where id=p_id;
 elsif p_action='retry' then
  if v_job.retry_count+1>=3 then
   if v_job.job_type in ('process_drawing_set','split_drawing_chunk','process_drawing_page') then
    update public.drawing_revisions set processing_stage='failed',error_message=coalesce(p_error,'Drawing processing failed')
     where id=nullif(v_job.payload->>'draftRevisionId','')::uuid and org_id=v_job.org_id and status<>'published';
   elsif v_job.job_type='enrich_drawing_metadata' then
    update public.drawing_sheet_versions set extracted_metadata=jsonb_set(coalesce(extracted_metadata,'{}'),'{sheet_detection}',
     coalesce(extracted_metadata->'sheet_detection','{}')||jsonb_build_object('vision_pending',false,'confidence','low','vision_error',coalesce(p_error,'Verify the sheet identity manually.')))
     where id=nullif(v_job.payload->>'sheetVersionId','')::uuid and org_id=v_job.org_id;
   end if;
  end if;
  update public.outbox set status=case when retry_count+1>=3 then 'failed' else 'pending' end,
   run_at=case when retry_count+1>=3 then run_at else clock_timestamp()+make_interval(secs=>(power(2,retry_count+1)*60)::integer) end,
   retry_count=retry_count+1,last_error=p_error,drawing_claim_token=null,drawing_lease_expires_at=null,updated_at=clock_timestamp() where id=p_id;
 else raise exception 'Invalid drawing lease transition'; end if;
 return true;
end $$;

create unique index drawing_artifact_org_identity on public.drawing_artifacts(org_id,id);
alter table public.drawing_sheet_versions add constraint drawing_version_artifact_org_fk
 foreign key(org_id,artifact_id) references public.drawing_artifacts(org_id,id);
create function public.guard_drawing_artifact_reference() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare a public.drawing_artifacts%rowtype;
begin
 if new.artifact_id is null then return new; end if;
 if tg_op='UPDATE' and new.artifact_id is not distinct from old.artifact_id then return new; end if;
 select * into a from public.drawing_artifacts where id=new.artifact_id and org_id=new.org_id for update;
 if not found or a.state not in ('building','active') then raise exception 'Drawing artifact unavailable'; end if;
 if a.state='building' and (a.writer_version_id is distinct from new.id or a.writer_until<=clock_timestamp()) then raise exception 'Drawing artifact writer mismatch'; end if;
 if a.state='active' and not public.drawing_manifest_complete(a.render_output->'tile_manifest') then raise exception 'Drawing artifact incomplete'; end if;
 return new;
end $$;
create trigger drawing_artifact_reference_guard before insert or update of artifact_id,org_id on public.drawing_sheet_versions
 for each row execute function public.guard_drawing_artifact_reference();
revoke all on function public.guard_drawing_artifact_reference() from public,anon,authenticated;

create function public.guard_drawing_metadata_review() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare headers jsonb:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb; job_type text; revision_status text;
begin
 if headers->>'x-drawing-job-id' is null then return new; end if;
 select o.job_type into job_type from public.outbox o where id=(headers->>'x-drawing-job-id')::bigint;
 if job_type<>'enrich_drawing_metadata' then return new; end if;
 select status into revision_status from public.drawing_revisions where id=old.drawing_revision_id and org_id=old.org_id for share;
 if revision_status is null or revision_status not in ('processing','draft')
  or coalesce((old.extracted_metadata->>'identity_reviewed')::boolean,false)
 then return old; end if;
 return new;
end $$;
create trigger drawing_metadata_review_guard before update of extracted_metadata on public.drawing_sheet_versions
 for each row execute function public.guard_drawing_metadata_review();
revoke all on function public.guard_drawing_metadata_review() from public,anon,authenticated;
create function public.guard_drawing_sheet_enrichment() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare headers jsonb:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb; j public.outbox%rowtype; v public.drawing_sheet_versions%rowtype; revision_status text;
begin
 if headers->>'x-drawing-job-id' is null then return new; end if;
 select * into j from public.outbox where id=(headers->>'x-drawing-job-id')::bigint;
 if j.job_type<>'enrich_drawing_metadata' then return new; end if;
 select * into v from public.drawing_sheet_versions where id=nullif(j.payload->>'sheetVersionId','')::uuid and org_id=old.org_id;
 if not found then return old; end if;
 select status into revision_status from public.drawing_revisions where id=v.drawing_revision_id and org_id=old.org_id for share;
 if revision_status is null or revision_status not in ('processing','draft') or coalesce((v.extracted_metadata->>'identity_reviewed')::boolean,false) then return old; end if;
 return new;
end $$;
create trigger drawing_sheet_enrichment_guard before update on public.drawing_sheets for each row execute function public.guard_drawing_sheet_enrichment();
revoke all on function public.guard_drawing_sheet_enrichment() from public,anon,authenticated;

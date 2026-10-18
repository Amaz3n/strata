create table public.drawing_deleted_pages (
 org_id uuid not null references public.orgs(id),revision_id uuid not null,page_index integer not null,sheet_id uuid not null,
 primary key(org_id,revision_id,page_index)
);
alter table public.drawing_deleted_pages enable row level security;
revoke all on public.drawing_deleted_pages from public,anon,authenticated;
grant all on public.drawing_deleted_pages to service_role;
create table public.drawing_deletion_operations (
 id uuid primary key,org_id uuid not null references public.orgs(id),project_id uuid not null references public.projects(id),user_id uuid not null,
 kind text not null check(kind in ('set','sheets','discard','revision')),target_ids uuid[] not null,
 deleted_sheet_ids uuid[] not null default '{}',artifact_ids uuid[] not null default '{}',
 retained_legacy_paths jsonb not null default '[]',status text not null default 'committed',created_at timestamptz not null default now()
);
alter table public.drawing_deletion_operations enable row level security;
revoke all on public.drawing_deletion_operations from anon,authenticated;
grant all on public.drawing_deletion_operations to service_role;
create index drawing_deletion_operations_project on public.drawing_deletion_operations(org_id,project_id);
create index drawing_abandoned_uploads_scan on public.drawing_abandoned_uploads(org_id,not_before);
create index drawing_deletion_operations_actor on public.drawing_deletion_operations(user_id);
alter table public.drawing_revisions add column if not exists cancelled_at timestamptz;
create function public.delete_drawings_transaction(p_id uuid,p_org_id uuid,p_project_id uuid,p_user_id uuid,p_kind text,p_target_ids uuid[])
returns jsonb language plpgsql security invoker set search_path=public,pg_catalog as $$
declare receipt drawing_deletion_operations; sheets uuid[]; revisions uuid[]; artifacts uuid[]; legacy jsonb; targets uuid[]; expected integer;
begin
 select array_agg(distinct x order by x) into targets from unnest(p_target_ids) x;
 if coalesce(array_length(targets,1),0)=0 or array_length(targets,1)>1000 then raise exception 'Choose between 1 and 1000 targets'; end if;
 perform 1 from projects where id=p_project_id and org_id=p_org_id for update;
 if not found then raise exception 'Project not found'; end if;
 select * into receipt from drawing_deletion_operations where id=p_id for update;
 if found then
  if receipt.org_id<>p_org_id or receipt.project_id<>p_project_id or receipt.user_id<>p_user_id or receipt.kind<>p_kind or receipt.target_ids<>targets then raise exception 'Deletion operation conflicts with original request'; end if;
  return to_jsonb(receipt);
 end if;
 if p_kind='set' then
  select count(*) into expected from drawing_sets where org_id=p_org_id and project_id=p_project_id and id=any(targets);
  if expected<>array_length(targets,1) then raise exception 'Drawing set not found'; end if;
  select coalesce(array_agg(id),'{}') into sheets from drawing_sheets where org_id=p_org_id and project_id=p_project_id and drawing_set_id=any(targets);
  select coalesce(array_agg(id),'{}') into revisions from drawing_revisions where org_id=p_org_id and project_id=p_project_id and drawing_set_id=any(targets);
 elsif p_kind='sheets' then
  select count(*) into expected from drawing_sheets where org_id=p_org_id and project_id=p_project_id and id=any(targets);
  if expected<>array_length(targets,1) then raise exception 'Drawing sheet not found'; end if;
  sheets:=targets;revisions:='{}';
 elsif p_kind in ('discard','revision') then
  select count(*) into expected from drawing_revisions where org_id=p_org_id and project_id=p_project_id and id=any(targets);
  if expected<>array_length(targets,1) then raise exception 'Revision not found'; end if;
  if exists(select 1 from drawing_revisions where id=any(targets) and status='published') then raise exception 'Published revision history cannot be discarded'; end if;
  revisions:=targets;
  select coalesce(array_agg(distinct v.drawing_sheet_id),'{}') into sheets from drawing_sheet_versions v join drawing_sheets s on s.id=v.drawing_sheet_id where v.org_id=p_org_id and v.drawing_revision_id=any(targets) and s.current_revision_id is null;
 else raise exception 'Invalid deletion kind'; end if;
 -- Deletion wins admission against late finalization on the same project lock.
 with cancelled as (
  update drawing_upload_operations set status='cancelled' where org_id=p_org_id and project_id=p_project_id and status='reserved'
  and (p_kind='set' or (p_kind='sheets' and intent->>'targetSheetId'=any(targets::text[]))) returning *
 ) insert into drawing_abandoned_uploads(org_id,operation_id,generation,storage_path,multipart_upload_id)
 select org_id,id,generation,storage_path,multipart_upload_id from cancelled where nullif(intent->>'sourceFileId','') is null on conflict do nothing;
 perform 1 from outbox where org_id=p_org_id and status='processing' and (payload->>'draftRevisionId'=any(revisions::text[]) or payload->>'revisionId'=any(revisions::text[]) or payload->>'sheetId'=any(sheets::text[]) or payload->>'drawingSheetId'=any(sheets::text[])) order by id for update;
 perform 1 from drawing_revisions where org_id=p_org_id and id=any(revisions) order by id for update;
 perform 1 from drawing_sheets where org_id=p_org_id and id=any(sheets) order by id for update;
 select coalesce(array_agg(distinct artifact_id) filter(where artifact_id is not null),'{}'),
 coalesce(jsonb_agg(distinct tiles_base_path) filter(where artifact_id is null and tiles_base_path is not null),'[]')
 into artifacts,legacy from drawing_sheet_versions where org_id=p_org_id and (drawing_sheet_id=any(sheets) or drawing_revision_id=any(revisions));
 insert into drawing_deleted_pages(org_id,revision_id,page_index,sheet_id)
 select org_id,drawing_revision_id,page_index,drawing_sheet_id from drawing_sheet_versions where org_id=p_org_id and drawing_sheet_id=any(sheets) and page_index is not null on conflict do nothing;
 update drawing_revisions set cancelled_at=clock_timestamp() where org_id=p_org_id and id=any(revisions);
 update outbox set status='failed',last_error='Drawing target deleted',drawing_claim_token=null,drawing_lease_expires_at=null
 where org_id=p_org_id and job_type=any(array['process_drawing_set','split_drawing_chunk','process_drawing_page','enrich_drawing_metadata','generate_drawing_tiles','extract_drawing_vectors','backfill_drawing_page_text','detect_drawing_changes'])
 and (payload->>'draftRevisionId'=any(revisions::text[]) or payload->>'revisionId'=any(revisions::text[]) or payload->>'sheetId'=any(sheets::text[]) or payload->>'drawingSheetId'=any(sheets::text[]));
 if p_kind in ('set','sheets') then
  insert into audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data)
  select p_org_id,p_user_id,'delete','drawing_sheet',id,to_jsonb(s) from drawing_sheets s where s.org_id=p_org_id and s.id=any(sheets);
 end if;
 if p_kind in ('discard','revision') then
  delete from drawing_sheet_versions where org_id=p_org_id and drawing_revision_id=any(revisions);
  delete from drawing_sheets s where org_id=p_org_id and id=any(sheets) and current_revision_id is null and not exists(select 1 from drawing_sheet_versions v where v.drawing_sheet_id=s.id);
 else
  delete from drawing_sheet_versions where org_id=p_org_id and drawing_sheet_id=any(sheets);
  delete from drawing_sheets where org_id=p_org_id and id=any(sheets);
 end if;
 delete from drawing_revisions where org_id=p_org_id and id=any(revisions);
 if p_kind='set' then delete from drawing_sets where org_id=p_org_id and project_id=p_project_id and id=any(targets); end if;
 insert into drawing_deletion_operations(id,org_id,project_id,user_id,kind,target_ids,deleted_sheet_ids,artifact_ids,retained_legacy_paths)
 values(p_id,p_org_id,p_project_id,p_user_id,p_kind,targets,sheets,artifacts,legacy) returning * into receipt;
 insert into outbox(org_id,job_type,payload,run_at) values(p_org_id,'cleanup_drawing_storage',jsonb_build_object('orgId',p_org_id,'deletionOperationId',p_id),now());
 insert into audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data) values(p_org_id,p_user_id,'delete','drawing_deletion',p_id,jsonb_build_object('kind',p_kind,'target_ids',targets,'project_id',p_project_id));
 insert into events(org_id,event_type,entity_type,entity_id,payload) values(p_org_id,'drawings_deleted','drawing_deletion',p_id,jsonb_build_object('project_id',p_project_id,'kind',p_kind,'sheet_count',coalesce(array_length(sheets,1),0)));
 return to_jsonb(receipt);
end $$;
revoke all on function public.delete_drawings_transaction(uuid,uuid,uuid,uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.delete_drawings_transaction(uuid,uuid,uuid,uuid,text,uuid[]) to service_role;

create function public.queue_drawing_storage_reconciliation() returns integer language plpgsql security invoker set search_path=public,pg_catalog as $$
declare n integer;
begin
 with expired as (
  update drawing_upload_operations set status='expired' where id in(select id from drawing_upload_operations where status='reserved' and expires_at<=now() limit 100 for update skip locked)
  returning *
 ) insert into drawing_abandoned_uploads(org_id,operation_id,generation,storage_path,multipart_upload_id)
 select org_id,id,generation,storage_path,multipart_upload_id from expired where nullif(intent->>'sourceFileId','') is null on conflict do nothing;
 insert into outbox(org_id,job_type,payload,run_at)
 select o.org_id,'cleanup_drawing_storage',jsonb_build_object('orgId',o.org_id),now()
 from (select distinct org_id from (select org_id from drawing_storage_cleanup_candidates(null,100) union select org_id from drawing_abandoned_uploads where not_before<=now()) candidates order by org_id limit 20) o
 where not exists(select 1 from outbox j where j.org_id=o.org_id and j.job_type='cleanup_drawing_storage' and j.status in ('pending','processing'));
 get diagnostics n=row_count;return n;
end $$;
revoke all on function public.queue_drawing_storage_reconciliation() from public,anon,authenticated;
grant execute on function public.queue_drawing_storage_reconciliation() to service_role;

create function public.fence_deleted_drawing_page() returns trigger language plpgsql set search_path=public,pg_catalog as $$
begin
 if exists(select 1 from drawing_deleted_pages where org_id=new.org_id and revision_id=new.drawing_revision_id and page_index=new.page_index) then raise exception 'Drawing page was deleted' using errcode='40001'; end if;
 return new;
end $$;
create trigger drawing_deleted_page_fence before insert or update on public.drawing_sheet_versions for each row execute function public.fence_deleted_drawing_page();

create table public.drawing_cleanup_failures (
 org_id uuid not null references public.orgs(id),kind text not null,entity_id uuid not null,
 attempts integer not null default 1,last_failed_at timestamptz not null default now(),
 primary key(org_id,kind,entity_id)
);
alter table public.drawing_cleanup_failures enable row level security;
revoke all on public.drawing_cleanup_failures from public,anon,authenticated;
grant all on public.drawing_cleanup_failures to service_role;
create function public.record_drawing_cleanup_failure(p_org_id uuid,p_kind text,p_entity_id uuid)
returns void language plpgsql security invoker set search_path=public,pg_catalog as $$
begin
 insert into drawing_cleanup_failures(org_id,kind,entity_id) values(p_org_id,p_kind,p_entity_id)
 on conflict(org_id,kind,entity_id) do update set attempts=drawing_cleanup_failures.attempts+1,last_failed_at=now();
 -- Back off this prefix without starving independent cleanup candidates.
 if p_kind='artifact' then update drawing_artifacts set last_cleanup_at=now() where org_id=p_org_id and id=p_entity_id;
 elsif p_kind='split' then update drawing_split_pages set last_cleanup_at=now() where org_id=p_org_id and id=p_entity_id;
 elsif p_kind='upload' then update drawing_abandoned_uploads set not_before=now()+interval '1 hour' where org_id=p_org_id and id=p_entity_id;
 else raise exception 'Invalid cleanup candidate'; end if;
end $$;
revoke all on function public.record_drawing_cleanup_failure(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.record_drawing_cleanup_failure(uuid,text,uuid) to service_role;

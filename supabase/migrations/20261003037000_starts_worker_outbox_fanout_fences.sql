-- STAGED, UNAPPLIED. Starts claims cannot author unscoped child jobs or alter
-- other workers' claims. Ordinary authorized server writers retain behavior.
create index schedule_assignments_home_vendor_scope_idx on public.schedule_assignments(org_id,project_id,company_id,schedule_item_id) where company_id is not null;
create function public.fence_starts_worker_outbox_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype;
 v_file public.files%rowtype; v_set_project uuid; v_revision public.drawing_revisions%rowtype;
begin
 if current_user in ('anon','authenticated') and (
   (tg_op<>'DELETE' and new.job_type='process_drawing_set') or (tg_op<>'INSERT' and old.job_type='process_drawing_set')) then
   raise exception 'Drawing jobs require authorized server writers' using errcode='42501';
 end if;
 v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
   if tg_op='DELETE' then return old; end if;return new;
 end if;
 if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
 if coalesce(v_headers->>'x-starts-job-id','')!~'^[1-9][0-9]{0,18}$'
   or coalesce(v_headers->>'x-starts-claim-token','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid starts worker context' using errcode='40001'; end if;
 select * into v_job from public.outbox where id=(v_headers->>'x-starts-job-id')::bigint
   and start_claim_token=(v_headers->>'x-starts-claim-token')::uuid and status='processing'
   and start_job_lease_expires_at>clock_timestamp() for update;
 if not found then raise exception 'Starts worker lease lost' using errcode='40001'; end if;
 -- Claim transitions must remain possible after package finalization. The active
 -- claim, immutable payload and limited state transitions fence this own row.
 if tg_op='UPDATE' and old.id=v_job.id then
   if (to_jsonb(new)-array['status','retry_count','last_error','run_at','updated_at','start_claim_token','start_job_lease_expires_at'])
     is distinct from (to_jsonb(old)-array['status','retry_count','last_error','run_at','updated_at','start_claim_token','start_job_lease_expires_at'])
     then raise exception 'Starts worker cannot replace its job identity or payload' using errcode='42501'; end if;
   if new.start_claim_token=old.start_claim_token and new.status='processing' and new.retry_count=old.retry_count
     and new.start_job_lease_expires_at>clock_timestamp() then return new; end if;
   if new.start_claim_token is null and new.start_job_lease_expires_at is null
     and new.status in ('pending','completed','failed') and new.retry_count in (old.retry_count,old.retry_count+1) then return new; end if;
   raise exception 'Invalid starts claim transition' using errcode='42501';
 end if;
 if tg_op<>'INSERT' then raise exception 'Starts worker cannot mutate other jobs' using errcode='42501'; end if;
 v_pkg:=public.lock_starts_release_write_scope(new.org_id);
 if new.status is distinct from 'pending' or new.retry_count is distinct from 0 or new.start_claim_token is not null or new.start_job_lease_expires_at is not null then
   raise exception 'Starts child jobs must enter the pending queue' using errcode='42501'; end if;
 if new.job_type='start_release_trade_notice' then
   if new.payload->>'start_package_id' is distinct from v_pkg.id::text
     or new.payload->>'actor_id' is distinct from v_job.payload->>'actor_id' or nullif(new.payload->>'actor_id','') is null then
     raise exception 'Starts trade notice scope mismatch' using errcode='42501'; end if;
   perform 1 from public.companies where org_id=v_pkg.org_id and id=(new.payload->>'company_id')::uuid for share;
   if not found then raise exception 'Starts trade notice vendor mismatch' using errcode='42501'; end if;
   perform 1 from public.schedule_assignments a join public.schedule_items i on i.id=a.schedule_item_id and i.org_id=a.org_id
     where a.org_id=v_pkg.org_id and a.project_id=v_pkg.project_id and i.project_id=v_pkg.project_id
       and a.company_id=(new.payload->>'company_id')::uuid for share of a,i;
   if not found then raise exception 'Starts trade notice vendor is not assigned to this home' using errcode='42501'; end if;
 elsif new.job_type='process_drawing_set' then
   if new.payload->>'projectId' is distinct from v_pkg.project_id::text or new.payload->>'orgId' is distinct from v_pkg.org_id::text then raise exception 'Starts drawing job scope mismatch' using errcode='42501'; end if;
   select * into v_file from public.files where org_id=v_pkg.org_id and id=(new.payload->>'sourceFileId')::uuid for share;
   if not found or v_file.project_id is distinct from v_pkg.project_id
     or v_file.storage_path is distinct from new.payload->>'storagePath'
     or v_file.metadata->>'source_plan_version_id' is distinct from public.starts_release_plan_version(v_pkg)::text then raise exception 'Starts drawing job file mismatch' using errcode='42501'; end if;
   select project_id into v_set_project from public.drawing_sets where org_id=v_pkg.org_id and id=(new.payload->>'drawingSetId')::uuid for share;
   if not found or v_set_project is distinct from v_pkg.project_id then raise exception 'Starts drawing job set mismatch' using errcode='42501'; end if;
   select * into v_revision from public.drawing_revisions where org_id=v_pkg.org_id and id=(new.payload->>'draftRevisionId')::uuid for share;
   if not found or v_revision.project_id is distinct from v_pkg.project_id or v_revision.drawing_set_id is distinct from (new.payload->>'drawingSetId')::uuid
     or v_revision.source_file_id is distinct from v_file.id then raise exception 'Starts drawing job revision mismatch' using errcode='42501'; end if;
 else raise exception 'Starts worker cannot enqueue this job family' using errcode='42501'; end if;
 return new;
end $$;
create trigger starts_worker_outbox_fence before insert or update or delete on public.outbox
 for each row execute function public.fence_starts_worker_outbox_write();
revoke all on function public.fence_starts_worker_outbox_write() from public,anon,authenticated;

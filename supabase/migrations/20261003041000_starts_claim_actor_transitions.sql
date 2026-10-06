-- STAGED, UNAPPLIED. Requires core actor scope and outbox fanout fences.
-- No worker activation. Release heartbeats require current actor access;
-- retry/defer and verified completion remain ownership-only bookkeeping.
create or replace function public.transition_starts_package_lease(p_org_id uuid,p_job_id bigint,p_token uuid,p_action text)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_held text; v_held_at timestamptz;
  v_headers text:=current_setting('request.headers',true);
begin
  if current_user in ('anon','authenticated') then raise exception 'Starts lease control requires service role' using errcode='42501'; end if;
  if p_action is null or p_action not in ('acquire','heartbeat','clear') then raise exception 'Invalid package lease transition'; end if;
  -- The lock order matches the write fences: job, then package. Reclaim waits
  -- for this transaction, so identity cannot change between validation/write.
  select * into v_job from public.outbox where id=p_job_id and org_id=p_org_id and job_type='start_release'
    and status='processing' and start_claim_token=p_token and start_job_lease_expires_at>clock_timestamp() for update;
  if not found then return false; end if;
  select * into v_pkg from public.start_packages where org_id=p_org_id and id=(v_job.payload->>'start_package_id')::uuid for update;
  if not found then return false; end if;
  if v_pkg.metadata is not null and jsonb_typeof(v_pkg.metadata)<>'object' then raise exception 'Invalid package metadata' using errcode='22023'; end if;
  v_held:=v_pkg.metadata->>'release_lease_token';
  begin v_held_at:=(v_pkg.metadata->>'release_lease_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then v_held_at:=null;
  end;
  if p_action='clear' then
    if v_held is distinct from p_token::text then return false; end if;
  else
    if v_pkg.status is distinct from 'releasing' then return false; end if;
    perform public.assert_starts_release_actor(v_job,v_pkg);
    if p_action='heartbeat' then
      if v_held is distinct from p_token::text or v_held_at is null or v_held_at<=clock_timestamp()-interval '5 minutes' then return false; end if;
    elsif v_held is not null and v_held is distinct from p_token::text and v_held_at>clock_timestamp()-interval '5 minutes' then return false;
    end if;
  end if;
  -- Only after validating and locking ownership, narrowly suppress worker
  -- headers for this lease-only control write. Preserve and restore them in
  -- this transaction; never change shared client or session authorization.
  perform set_config('request.headers','{}',true);
  update public.start_packages set metadata=coalesce(metadata,'{}')||case when p_action='clear'
    then jsonb_build_object('release_lease_token',null,'release_lease_at',null)
    else jsonb_build_object('release_lease_token',p_token::text,'release_lease_at',clock_timestamp()) end
    where id=v_pkg.id and org_id=p_org_id;
  perform set_config('request.headers',coalesce(v_headers,''),true);
  return true;
end $$;
revoke all on function public.transition_starts_package_lease(uuid,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.transition_starts_package_lease(uuid,bigint,uuid,text) to service_role;

create function public.lock_starts_claim_transition_scope(p_job public.outbox,p_action text)
returns public.start_packages language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype;
begin
 if p_job.job_type<>'start_release' then return null; end if;
 if coalesce(p_job.payload->>'start_package_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   if p_action in ('heartbeat','complete') then raise exception 'Invalid starts package identity' using errcode='42501'; end if;
   return null;
 end if;
 select * into v_pkg from public.start_packages where org_id=p_job.org_id
   and id=(p_job.payload->>'start_package_id')::uuid for update;
 if p_action='heartbeat' then
   if not found or v_pkg.status is distinct from 'releasing' then raise exception 'Start package no longer releasing' using errcode='40001'; end if;
   perform public.assert_starts_release_actor(p_job,v_pkg);
 elsif p_action='complete' then
   if not found or v_pkg.status is distinct from 'released' then raise exception 'Starts completion requires a durably released package' using errcode='42501'; end if;
 end if;
 return v_pkg;
end $$;
revoke all on function public.lock_starts_claim_transition_scope(public.outbox,text) from public,anon,authenticated;
grant execute on function public.lock_starts_claim_transition_scope(public.outbox,text) to service_role;

create or replace function public.transition_starts_job_lease(p_org_id uuid,p_id bigint,p_token uuid,p_action text,p_error text default null)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_headers text:=current_setting('request.headers',true);
begin
  if p_action is null or p_action not in ('heartbeat','defer','complete','retry') then raise exception 'Invalid starts lease transition'; end if;
  select * into v_job from public.outbox where id=p_id and org_id=p_org_id
    and job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice')
    and status='processing' and start_claim_token=p_token
    and start_job_lease_expires_at>clock_timestamp() for update;
  if not found then return false; end if;
  v_pkg:=public.lock_starts_claim_transition_scope(v_job,p_action);
  if p_action<>'heartbeat' and v_job.job_type='start_release'
    and v_pkg.metadata->>'release_lease_token'=p_token::text then
    -- Only the still-owned package may be parked after the final failure.
    -- This system recovery step remains available after actor revocation.
    if p_action='retry' and v_job.retry_count+1>=3 and v_pkg.status='releasing' then
      perform set_config('request.headers','{}',true);
      update public.start_packages set status='attention' where org_id=p_org_id and id=v_pkg.id
        and status='releasing' and metadata->>'release_lease_token'=p_token::text;
      perform set_config('request.headers',coalesce(v_headers,''),true);
    end if;
    -- Clear before giving up the claim; later cleanup cannot prove ownership.
    if not public.transition_starts_package_lease(p_org_id,p_id,p_token,'clear') then
      raise exception 'Starts package cleanup lost ownership' using errcode='40001';
    end if;
  end if;

  if v_job.start_job_lease_expires_at<=clock_timestamp() then raise exception 'Starts worker lease lost during transition' using errcode='40001'; end if;
  if p_action='heartbeat' then
    update public.outbox set updated_at=clock_timestamp(),start_job_lease_expires_at=clock_timestamp()+interval '3 minutes' where id=p_id;
  elsif p_action='defer' then
    update public.outbox set status='pending',run_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp(),
      start_claim_token=null,start_job_lease_expires_at=null where id=p_id;
  elsif p_action='complete' then
    update public.outbox set status='completed',last_error=null,updated_at=clock_timestamp(),
      start_claim_token=null,start_job_lease_expires_at=null where id=p_id;
  else
    update public.outbox set status=case when retry_count+1>=3 then 'failed' else 'pending' end,
      retry_count=retry_count+1,last_error=left(p_error,2000),updated_at=clock_timestamp(),
      run_at=case when retry_count+1>=3 then run_at else clock_timestamp()+make_interval(secs => (power(2,retry_count+1)*60)::integer) end,
      start_claim_token=null,start_job_lease_expires_at=null where id=p_id;
  end if;
  return true;
end $$;

revoke all on function public.transition_starts_job_lease(uuid,bigint,uuid,text,text) from public,anon,authenticated;
grant execute on function public.transition_starts_job_lease(uuid,bigint,uuid,text,text) to service_role;

create or replace function public.fence_starts_worker_outbox_write() returns trigger
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
     and new.start_job_lease_expires_at>clock_timestamp() and new.start_job_lease_expires_at<=clock_timestamp()+interval '3 minutes' then
     perform public.lock_starts_claim_transition_scope(v_job,'heartbeat');return new;
   end if;
   if new.start_claim_token is null and new.start_job_lease_expires_at is null
     and new.status in ('pending','completed','failed') and new.retry_count in (old.retry_count,old.retry_count+1) then
     v_pkg:=public.lock_starts_claim_transition_scope(v_job,case when new.status='completed' then 'complete' else 'retry' end);
     if v_job.job_type='start_release' and v_pkg.metadata->>'release_lease_token'=v_job.start_claim_token::text then
       raise exception 'Starts claim transition requires package lease cleanup first' using errcode='42501';
     end if;
     return new;
   end if;
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
create or replace function public.recover_starts_job_leases(p_limit integer default 500)
returns integer language plpgsql set search_path=public,pg_catalog as $$
declare v_count integer:=0; v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_headers jsonb;
begin
  if current_user in ('anon','authenticated') then raise exception 'Starts recovery requires service role' using errcode='42501'; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is not null or v_headers->>'x-starts-claim-token' is not null then raise exception 'Starts recovery requires an unscoped service client' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>500 then raise exception 'Invalid starts recovery limit'; end if;
  for v_job in select * from public.outbox where status='processing' and start_claim_token is not null
    and job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice')
    and coalesce(start_job_lease_expires_at,updated_at+interval '3 minutes')<=clock_timestamp()
    order by start_job_lease_expires_at nulls first,id limit p_limit for update skip locked
  loop
    if v_job.job_type='start_release' then
      select * into v_pkg from public.start_packages where org_id=v_job.org_id
        and id=case when coalesce(v_job.payload->>'start_package_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_job.payload->>'start_package_id')::uuid else null end for update;
      if found and v_pkg.metadata->>'release_lease_token'=v_job.start_claim_token::text then
        update public.start_packages set status=case when v_job.retry_count+1>=3 and status='releasing' then 'attention' else status end,
          metadata=metadata||jsonb_build_object('release_lease_token',null,'release_lease_at',null)
          where id=v_pkg.id and org_id=v_job.org_id;
      end if;
    end if;
    update public.outbox set status=case when retry_count+1>=3 then 'failed' else 'pending' end,
      retry_count=retry_count+1,last_error='Starts worker lease expired',run_at=clock_timestamp(),updated_at=clock_timestamp(),
      start_claim_token=null,start_job_lease_expires_at=null where id=v_job.id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

revoke all on function public.recover_starts_job_leases(integer) from public,anon,authenticated;
grant execute on function public.recover_starts_job_leases(integer) to service_role;

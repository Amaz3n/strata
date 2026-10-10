-- Starts: job claim leases, write fences on the core, generated artifacts, packages, purchasing, PO regeneration, land posting and drawing records; release scope, actor transitions, outbox fan-out, confirmation and notification delivery recovery; house-plan drawing publication and copy attempts; the purchasing readiness index.
--
-- Consolidated before deploy (2026-10-09) from 20 unapplied migrations, in their
-- original order; each section is marked with the file it came from.

-- ==== 20261003023000_starts_job_claim_leases ====
-- STAGED: do not activate starts lease consumers until this migration is approved,
-- deployed and verified, and legacy starts workers have been drained. This adds
-- claim ownership only; domain write fencing and atomic release commit follow.
alter table public.outbox add column start_claim_token uuid;
alter table public.outbox add column start_job_lease_expires_at timestamptz;
create index outbox_start_lease_expiry_idx on public.outbox(start_job_lease_expires_at,id)
  where status='processing' and start_claim_token is not null;

create function public.claim_starts_jobs(p_limit integer default 2)
returns table(job_id bigint,org_id uuid,job_type text,payload jsonb,retry_count integer,claim_token uuid)
language plpgsql set search_path=public,pg_catalog as $$
begin
  if p_limit is null or p_limit<1 or p_limit>6 then raise exception 'Invalid starts claim limit'; end if;
  return query with picked as (
    select o.id from public.outbox o
    where o.status='pending' and o.run_at<=clock_timestamp()
      and o.job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice')
    order by o.priority desc,o.created_at,o.id limit p_limit for update skip locked
  ), changed as (update public.outbox o set status='processing',updated_at=clock_timestamp(),
      start_claim_token=gen_random_uuid(),start_job_lease_expires_at=clock_timestamp()+interval '3 minutes'
    from picked where o.id=picked.id
    returning o.id,o.org_id,o.job_type,o.payload,o.retry_count,o.start_claim_token,o.priority,o.created_at)
  select c.id,c.org_id,c.job_type,c.payload,c.retry_count,c.start_claim_token from changed c
    order by c.priority desc,c.created_at,c.id;
end $$;

create function public.transition_starts_job_lease(p_org_id uuid,p_id bigint,p_token uuid,p_action text,p_error text default null)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype;
begin
  if p_action is null or p_action not in ('heartbeat','defer','complete','retry') then raise exception 'Invalid starts lease transition'; end if;
  select * into v_job from public.outbox where id=p_id and org_id=p_org_id
    and job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice')
    and status='processing' and start_claim_token=p_token
    and start_job_lease_expires_at>clock_timestamp() for update;
  if not found then return false; end if;
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

create function public.recover_starts_job_leases(p_limit integer default 500)
returns integer language plpgsql set search_path=public,pg_catalog as $$
declare v_count integer:=0; v_job public.outbox%rowtype;
begin
  if p_limit is null or p_limit<1 or p_limit>500 then raise exception 'Invalid starts recovery limit'; end if;
  for v_job in select * from public.outbox where status='processing' and start_claim_token is not null
    and job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice')
    and coalesce(start_job_lease_expires_at,updated_at+interval '3 minutes')<=clock_timestamp()
    order by start_job_lease_expires_at nulls first,id limit p_limit for update skip locked
  loop
    update public.outbox set status=case when retry_count+1>=3 then 'failed' else 'pending' end,
      retry_count=retry_count+1,last_error='Starts worker lease expired',run_at=clock_timestamp(),updated_at=clock_timestamp(),
      start_claim_token=null,start_job_lease_expires_at=null where id=v_job.id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

-- The existing outbox table grants browser roles broad org-member writes.
-- Starts jobs must be server-authored so a browser cannot spoof an actor,
-- reset a processing job or replace ownership through direct table writes.
create function public.guard_starts_job_browser_writes() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
begin
  if current_user in ('anon','authenticated') and (
    (tg_op<>'DELETE' and (new.job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice') or new.start_claim_token is not null))
    or (tg_op<>'INSERT' and (old.job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice') or old.start_claim_token is not null))
  ) then raise exception 'Starts jobs must be changed through authorized server actions' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger starts_job_browser_write_guard before insert or update or delete on public.outbox
  for each row execute function public.guard_starts_job_browser_writes();

revoke all on function public.guard_starts_job_browser_writes() from public,anon,authenticated;
revoke all on function public.claim_starts_jobs(integer) from public,anon,authenticated;
revoke all on function public.transition_starts_job_lease(uuid,bigint,uuid,text,text) from public,anon,authenticated;
revoke all on function public.recover_starts_job_leases(integer) from public,anon,authenticated;
grant execute on function public.claim_starts_jobs(integer) to service_role;
grant execute on function public.transition_starts_job_lease(uuid,bigint,uuid,text,text) to service_role;
grant execute on function public.recover_starts_job_leases(integer) to service_role;

-- ==== 20261003024000_starts_core_write_fences ====
-- STAGED, UNAPPLIED. Requires starts_job_claim_leases. Do not activate consumers
-- until package lease RPCs, artifact/financial fences and cutover tests are ready.
create function public.fence_starts_core_worker_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_acquiring boolean:=false;
begin
  if current_user in ('anon','authenticated') and tg_table_name in ('start_packages','start_release_steps','start_package_gates')
    then raise exception 'Starts records require authorized server actions' using errcode='42501'; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
  if tg_op='DELETE' then raise exception 'Starts workers cannot delete core records' using errcode='42501'; end if;
  if coalesce(v_headers->>'x-starts-job-id','') !~ '^[1-9][0-9]{0,18}$'
    or coalesce(v_headers->>'x-starts-claim-token','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'Invalid starts worker context' using errcode='40001'; end if;
  select * into v_job from public.outbox where id=(v_headers->>'x-starts-job-id')::bigint
    and start_claim_token=(v_headers->>'x-starts-claim-token')::uuid
    and status='processing' and start_job_lease_expires_at>clock_timestamp() for update;
  if not found or v_job.job_type<>'start_release' then raise exception 'Starts worker lease lost' using errcode='40001'; end if;
  if new.org_id is distinct from v_job.org_id then raise exception 'Starts worker organization mismatch' using errcode='42501'; end if;
  select * into v_pkg from public.start_packages where org_id=v_job.org_id
    and id=(v_job.payload->>'start_package_id')::uuid for update;
  if not found or v_pkg.status<>'releasing' then raise exception 'Start package no longer releasing' using errcode='40001'; end if;
  if tg_table_name='start_packages' then
    if new.id is distinct from v_pkg.id then raise exception 'Starts worker package mismatch' using errcode='42501'; end if;
    -- Allow only metadata lease acquisition by a fresh owner when the previous
    -- package lease is absent or stale. This cannot smuggle domain edits.
    if tg_op='UPDATE' then
      v_acquiring:=new.metadata->>'release_lease_token'=v_job.start_claim_token::text
        and (old.metadata->>'release_lease_token' is null
          or (old.metadata->>'release_lease_at')::timestamptz<=clock_timestamp()-interval '5 minutes')
        and (to_jsonb(new)-'metadata'-'updated_at')=(to_jsonb(old)-'metadata'-'updated_at')
        and (coalesce(new.metadata,'{}')-'release_lease_token'-'release_lease_at')
          =(coalesce(old.metadata,'{}')-'release_lease_token'-'release_lease_at');
    end if;
  elsif tg_table_name in ('start_release_steps','start_package_gates') then
    if new.start_package_id is distinct from v_pkg.id then raise exception 'Starts worker package mismatch' using errcode='42501'; end if;
  elsif tg_table_name='projects' then
    if new.id is distinct from v_pkg.project_id then raise exception 'Starts worker project mismatch' using errcode='42501'; end if;
  elsif tg_table_name='lots' then
    if new.id is distinct from v_pkg.lot_id then raise exception 'Starts worker lot mismatch' using errcode='42501'; end if;
  else raise exception 'Unsupported starts fence table'; end if;
  if not coalesce(v_acquiring,false) and (v_pkg.metadata->>'release_lease_token' is distinct from v_job.start_claim_token::text
    or v_pkg.metadata->>'release_lease_at' is null
    or (v_pkg.metadata->>'release_lease_at')::timestamptz<=clock_timestamp()-interval '5 minutes')
    then raise exception 'Start package lease lost' using errcode='40001'; end if;
  return new;
end $$;

create trigger starts_worker_package_fence before insert or update or delete on public.start_packages
  for each row execute function public.fence_starts_core_worker_write();
create trigger starts_worker_step_fence before insert or update or delete on public.start_release_steps
  for each row execute function public.fence_starts_core_worker_write();
create trigger starts_worker_gate_fence before insert or update or delete on public.start_package_gates
  for each row execute function public.fence_starts_core_worker_write();
create trigger starts_worker_project_fence before insert or update or delete on public.projects
  for each row execute function public.fence_starts_core_worker_write();
create trigger starts_worker_lot_fence before insert or update or delete on public.lots
  for each row execute function public.fence_starts_core_worker_write();
revoke all on function public.fence_starts_core_worker_write() from public,anon,authenticated;

-- ==== 20261003025000_starts_generated_artifact_fences ====
-- STAGED, UNAPPLIED. Extends core fences to generated schedule, budget and
-- inspection rows. Financial postings, drawing artifacts and event/fanout
-- fencing remain required before any starts claim-token activation.
create function public.lock_starts_release_write_scope(p_org_id uuid) returns public.start_packages
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype;
begin
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then return null; end if;
  if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
  if coalesce(v_headers->>'x-starts-job-id','') !~ '^[1-9][0-9]{0,18}$'
    or coalesce(v_headers->>'x-starts-claim-token','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then raise exception 'Invalid starts worker context' using errcode='40001'; end if;
  select * into v_job from public.outbox where id=(v_headers->>'x-starts-job-id')::bigint
    and start_claim_token=(v_headers->>'x-starts-claim-token')::uuid and status='processing'
    and start_job_lease_expires_at>clock_timestamp() for update;
  if not found or v_job.job_type<>'start_release' then raise exception 'Starts worker lease lost' using errcode='40001'; end if;
  if p_org_id is distinct from v_job.org_id then raise exception 'Starts worker organization mismatch' using errcode='42501'; end if;
  select * into v_pkg from public.start_packages where org_id=v_job.org_id
    and id=(v_job.payload->>'start_package_id')::uuid for update;
  if not found or v_pkg.status<>'releasing' then raise exception 'Start package no longer releasing' using errcode='40001'; end if;
  if v_pkg.metadata->>'release_lease_token' is distinct from v_job.start_claim_token::text
    or v_pkg.metadata->>'release_lease_at' is null
    or (v_pkg.metadata->>'release_lease_at')::timestamptz<=clock_timestamp()-interval '5 minutes'
    then raise exception 'Start package lease lost' using errcode='40001'; end if;
  return v_pkg;
end $$;

create function public.fence_starts_generated_artifact_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_rows jsonb[]; v_row jsonb; v_parent uuid; v_item text; v_headers jsonb;
begin
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
  if tg_op='INSERT' then v_rows:=array[to_jsonb(new)];
  elsif tg_op='DELETE' then v_rows:=array[to_jsonb(old)];
  else v_rows:=array[to_jsonb(old),to_jsonb(new)]; end if;
  v_pkg:=public.lock_starts_release_write_scope((v_rows[1]->>'org_id')::uuid);
  if v_pkg.id is null then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  -- Both ancestries are checked on UPDATE; moving someone else's row into the
  -- worker's home must not bypass authorization by changing its parent first.
  foreach v_row in array v_rows loop
    if (v_row->>'org_id')::uuid is distinct from v_pkg.org_id then raise exception 'Starts worker organization mismatch' using errcode='42501'; end if;
    if tg_table_name='budget_lines' then
      select project_id into v_parent from public.budgets where org_id=v_pkg.org_id and id=(v_row->>'budget_id')::uuid for share;
      if not found or v_parent is distinct from v_pkg.project_id then raise exception 'Starts worker budget mismatch' using errcode='42501'; end if;
    elsif tg_table_name='inspection_items' then
      select project_id into v_parent from public.inspections where org_id=v_pkg.org_id and id=(v_row->>'inspection_id')::uuid for share;
      if not found or v_parent is distinct from v_pkg.project_id then raise exception 'Starts worker inspection mismatch' using errcode='42501'; end if;
    else
      if (v_row->>'project_id')::uuid is distinct from v_pkg.project_id then raise exception 'Starts worker project mismatch' using errcode='42501'; end if;
      if tg_table_name='schedule_assignments' then
        select project_id into v_parent from public.schedule_items where org_id=v_pkg.org_id and id=(v_row->>'schedule_item_id')::uuid for share;
        if not found or v_parent is distinct from v_pkg.project_id then raise exception 'Starts worker schedule mismatch' using errcode='42501'; end if;
      elsif tg_table_name='schedule_dependencies' then
        foreach v_item in array array[v_row->>'item_id',v_row->>'depends_on_item_id'] loop
          select project_id into v_parent from public.schedule_items where org_id=v_pkg.org_id and id=v_item::uuid for share;
          if not found or v_parent is distinct from v_pkg.project_id then raise exception 'Starts worker dependency mismatch' using errcode='42501'; end if;
        end loop;
      end if;
    end if;
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

do $$ declare v_table text; begin
  foreach v_table in array array['schedule_items','schedule_assignments','schedule_dependencies','budgets','budget_lines','inspections','inspection_items'] loop
    execute format('create trigger starts_generated_worker_fence before insert or update or delete on public.%I for each row execute function public.fence_starts_generated_artifact_write()',v_table);
  end loop;
end $$;
revoke all on function public.lock_starts_release_write_scope(uuid) from public,anon,authenticated;
revoke all on function public.fence_starts_generated_artifact_write() from public,anon,authenticated;
grant execute on function public.lock_starts_release_write_scope(uuid) to service_role;

-- ==== 20261003030000_starts_package_lease_rpc ====
-- STAGED, UNAPPLIED. Requires starts claim/core migrations. This is narrowly
-- scoped lease control, not release finalization or consumer activation.
create function public.transition_starts_package_lease(p_org_id uuid,p_job_id bigint,p_token uuid,p_action text)
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
    if v_held is distinct from p_token::text or v_pkg.status is null or v_pkg.status not in ('releasing','released','attention') then return false; end if;
  else
    if v_pkg.status is distinct from 'releasing' then return false; end if;
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

-- ==== 20261003031000_starts_purchasing_write_fences ====
-- STAGED, UNAPPLIED. Requires generated-artifact release-scope helper.
-- This fences purchasing domain records; ledger/land postings remain separate.
create function public.fence_starts_purchasing_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_pkg public.start_packages%rowtype; v_rows jsonb[]; v_row jsonb;
  v_project uuid; v_lot uuid; v_company uuid; v_type text;
begin
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
  if tg_op='INSERT' then v_rows:=array[to_jsonb(new)];
  elsif tg_op='DELETE' then v_rows:=array[to_jsonb(old)];
  else v_rows:=array[to_jsonb(old),to_jsonb(new)]; end if;
  v_pkg:=public.lock_starts_release_write_scope((v_rows[1]->>'org_id')::uuid);
  if v_pkg.id is null then raise exception 'Starts worker scope unavailable' using errcode='40001'; end if;
  foreach v_row in array v_rows loop
    if (v_row->>'org_id')::uuid is distinct from v_pkg.org_id then raise exception 'Starts worker organization mismatch' using errcode='42501'; end if;
    v_company:=null;
    if tg_table_name='commitment_lines' then
      select project_id,company_id,commitment_type into v_project,v_company,v_type from public.commitments
        where org_id=v_pkg.org_id and id=(v_row->>'commitment_id')::uuid for share;
      if not found or v_project is distinct from v_pkg.project_id or v_type is distinct from 'purchase_order'
        then raise exception 'Starts worker purchase order mismatch' using errcode='42501'; end if;
      if v_row->>'budget_line_id' is not null then
        select b.project_id into v_project from public.budget_lines bl join public.budgets b on b.id=bl.budget_id and b.org_id=bl.org_id
          where bl.org_id=v_pkg.org_id and bl.id=(v_row->>'budget_line_id')::uuid for share of bl,b;
        if not found or v_project is distinct from v_pkg.project_id then raise exception 'Starts worker budget line mismatch' using errcode='42501'; end if;
      end if;
    else
      if (v_row->>'project_id')::uuid is distinct from v_pkg.project_id then raise exception 'Starts worker project mismatch' using errcode='42501'; end if;
      if tg_table_name='po_generation_runs' then
        if (v_row->>'lot_id')::uuid is distinct from v_pkg.lot_id then raise exception 'Starts worker lot mismatch' using errcode='42501'; end if;
      elsif tg_table_name='po_generation_exceptions' then
        select project_id,lot_id into v_project,v_lot from public.po_generation_runs
          where org_id=v_pkg.org_id and id=(v_row->>'run_id')::uuid for share;
        if not found or v_project is distinct from v_pkg.project_id or v_lot is distinct from v_pkg.lot_id
          then raise exception 'Starts worker generation run mismatch' using errcode='42501'; end if;
      elsif tg_table_name='commitments' then
        if v_row->>'commitment_type' is distinct from 'purchase_order' then raise exception 'Starts worker cannot change non-PO commitments' using errcode='42501'; end if;
        v_company:=(v_row->>'company_id')::uuid;
      elsif tg_table_name='project_vendors' then v_company:=(v_row->>'company_id')::uuid;
      else raise exception 'Unsupported purchasing fence table'; end if;
    end if;
    if tg_table_name in ('commitments','commitment_lines','project_vendors') then
      perform 1 from public.companies where org_id=v_pkg.org_id and id=v_company for share;
      if not found then raise exception 'Starts worker vendor mismatch' using errcode='42501'; end if;
    end if;
  end loop;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
do $$ declare v_table text; begin
  foreach v_table in array array['po_generation_runs','po_generation_exceptions','commitments','commitment_lines','project_vendors'] loop
    execute format('create trigger starts_purchasing_worker_fence before insert or update or delete on public.%I for each row execute function public.fence_starts_purchasing_write()',v_table);
  end loop;
end $$;
revoke all on function public.fence_starts_purchasing_write() from public,anon,authenticated;

-- ==== 20261003032000_po_regeneration_fenced_children ====
-- STAGED, UNAPPLIED. Preserve starts ancestry fences during PO regeneration.
-- Replaces the existing serialized commit RPC; claim consumers remain inactive.
-- Restrict source-run probes/locks to the generated set at national scale.
create index commitments_generation_run_idx on public.commitments
  (org_id,(metadata->>'source_generation_run_id'),id)
  where metadata->>'source_generation_run_id' is not null;
create index budgets_generation_run_idx on public.budgets
  (org_id,(metadata->>'source_generation_run_id'),id)
  where metadata->>'source_generation_run_id' is not null;

create or replace function public.run_po_generation_commit(
  p_org_id uuid,
  p_run_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_run public.po_generation_runs%rowtype;
  v_project_id uuid;
  v_worker_package public.start_packages%rowtype;
  v_prior_run_id uuid;
  v_prior_run public.po_generation_runs%rowtype;
  v_budget_id uuid;
  v_budget_version integer;
  v_budget_line jsonb;
  v_po jsonb;
  v_line jsonb;
  v_commitment_id uuid;
  v_budget_line_id uuid;
  v_commitment_ids uuid[] := '{}';
  v_exception jsonb;
begin
  -- All starts writes take job/package locks before domain row locks. Taking
  -- run locks first would invert the trigger's ownership lock order.
  v_worker_package:=public.lock_starts_release_write_scope(p_org_id);
  select project_id into v_project_id from public.po_generation_runs
    where org_id=p_org_id and id=p_run_id;
  if not found then raise exception 'PO generation run is not commit-ready'; end if;
  if v_worker_package.id is not null
    and v_worker_package.project_id is distinct from v_project_id then
    raise exception 'Starts worker project mismatch' using errcode='42501';
  end if;

  -- Serialize before locking either run. Otherwise competing requests can
  -- hold each other's new/prior run while waiting for this project lock.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_project_id::text, 0));
  select * into v_run from public.po_generation_runs
    where org_id=p_org_id and id=p_run_id for update;
  if not found or v_run.mode<>'commit' or v_run.status<>'running'
    or v_run.project_id is distinct from v_project_id then
    raise exception 'PO generation run is not commit-ready';
  end if;
  if v_worker_package.id is not null
    and v_worker_package.lot_id is distinct from v_run.lot_id then
    raise exception 'Starts worker lot mismatch' using errcode='42501';
  end if;

  v_prior_run_id := nullif(p_payload->>'prior_run_id', '')::uuid;
  if v_prior_run_id is not null then
    select * into v_prior_run from public.po_generation_runs
      where org_id=p_org_id and id=v_prior_run_id for update;
    if not found or v_prior_run.id=v_run.id
      or v_prior_run.project_id is distinct from v_run.project_id
      or v_prior_run.lot_id is distinct from v_run.lot_id
      or v_prior_run.mode<>'commit'
      or v_prior_run.status not in ('succeeded','succeeded_with_exceptions') then
      raise exception 'Prior PO generation run is not replaceable for this home';
    end if;
    -- Lock the records before checking status/bills, retaining these locks
    -- through replacement. Approval updates and bill FK key-share acquisition
    -- must finish before the check or wait until the replacement commits.
    perform 1 from public.commitments where org_id=p_org_id
      and metadata->>'source_generation_run_id'=v_prior_run_id::text
      order by id for update;
    perform 1 from public.budgets where org_id=p_org_id
      and metadata->>'source_generation_run_id'=v_prior_run_id::text
      order by id for update;
    if exists (select 1 from public.commitments where org_id=p_org_id
        and metadata->>'source_generation_run_id'=v_prior_run_id::text
        and project_id is distinct from v_run.project_id)
      or exists (select 1 from public.budgets where org_id=p_org_id
        and metadata->>'source_generation_run_id'=v_prior_run_id::text
        and project_id is distinct from v_run.project_id) then
      raise exception 'Prior PO generation artifacts belong to another home';
    end if;
    if exists (
      select 1 from public.commitments c
      where c.org_id = p_org_id
        and c.metadata->>'source_generation_run_id' = v_prior_run_id::text
        and (c.status <> 'draft' or exists (
          select 1 from public.vendor_bills vb
          where vb.org_id = p_org_id and vb.commitment_id = c.id
        ))
    ) then
      raise exception 'Generated purchase orders have progressed; use the VPO workflow';
    end if;
    -- Delete fenced children while their parent still exists. FK cascades run
    -- after the parent is gone and cannot establish ownership from ancestry.
    delete from public.commitment_lines cl using public.commitments c
      where cl.org_id=p_org_id and c.org_id=p_org_id and cl.commitment_id=c.id
        and c.metadata->>'source_generation_run_id'=v_prior_run_id::text;
    delete from public.commitments where org_id = p_org_id
      and metadata->>'source_generation_run_id' = v_prior_run_id::text;
    delete from public.budget_lines bl using public.budgets b
      where bl.org_id=p_org_id and b.org_id=p_org_id and bl.budget_id=b.id
        and b.metadata->>'source_generation_run_id'=v_prior_run_id::text;
    delete from public.budgets where org_id = p_org_id
      and metadata->>'source_generation_run_id' = v_prior_run_id::text;
    update public.po_generation_runs set status = 'superseded', completed_at = now()
      where org_id = p_org_id and id = v_prior_run_id;
  end if;

  select coalesce(max(version), 0) + 1 into v_budget_version
  from public.budgets where org_id = p_org_id and project_id = v_run.project_id;
  insert into public.budgets (org_id, project_id, version, status, total_cents, metadata)
  values (
    p_org_id, v_run.project_id, v_budget_version, 'draft',
    coalesce((p_payload->>'total_cents')::integer, 0),
    jsonb_build_object('source', 'po_generation', 'source_generation_run_id', p_run_id)
  ) returning id into v_budget_id;

  for v_budget_line in select value from jsonb_array_elements(coalesce(p_payload->'budget_lines', '[]'))
  loop
    insert into public.budget_lines (
      org_id, budget_id, cost_code_id, description, amount_cents, sort_order, cost_type, metadata
    ) values (
      p_org_id, v_budget_id, nullif(v_budget_line->>'cost_code_id', '')::uuid,
      v_budget_line->>'description', (v_budget_line->>'amount_cents')::integer,
      coalesce((v_budget_line->>'sort_order')::integer, 0),
      nullif(v_budget_line->>'cost_type', '')::public.cost_type,
      jsonb_build_object('source', 'po_generation', 'source_generation_run_id', p_run_id)
    );
  end loop;

  for v_po in select value from jsonb_array_elements(coalesce(p_payload->'purchase_orders', '[]'))
  loop
    insert into public.commitments (
      org_id, project_id, company_id, title, status, total_cents, currency,
      contract_number, scope, issued_at, commitment_type, metadata
    ) values (
      p_org_id, v_run.project_id, (v_po->>'company_id')::uuid, v_po->>'title', 'draft',
      (v_po->>'total_cents')::integer, 'usd', nullif(v_po->>'contract_number', ''),
      nullif(v_po->>'scope', ''), now(), 'purchase_order',
      jsonb_build_object(
        'source', 'po_generation',
        'source_generation_run_id', p_run_id,
        'source_agreement_ids', coalesce(v_po->'source_agreement_ids', '[]'::jsonb)
      )
    ) returning id into v_commitment_id;
    v_commitment_ids := array_append(v_commitment_ids, v_commitment_id);

    insert into public.project_vendors (org_id, project_id, company_id, role, scope, status, notes)
    values (
      p_org_id, v_run.project_id, (v_po->>'company_id')::uuid, 'subcontractor',
      nullif(v_po->>'scope', ''), 'active', concat('Generated from PO run ', p_run_id::text)
    )
    on conflict (project_id, company_id) do update set
      status = 'active',
      scope = coalesce(public.project_vendors.scope, excluded.scope),
      notes = coalesce(public.project_vendors.notes, excluded.notes);

    for v_line in select value from jsonb_array_elements(coalesce(v_po->'lines', '[]'))
    loop
      select bl.id into v_budget_line_id from public.budget_lines bl
      where bl.org_id = p_org_id and bl.budget_id = v_budget_id
        and bl.cost_code_id is not distinct from nullif(v_line->>'cost_code_id', '')::uuid
        and bl.cost_type is not distinct from nullif(v_line->>'cost_type', '')::public.cost_type
      order by bl.sort_order limit 1;

      insert into public.commitment_lines (
        org_id, commitment_id, cost_code_id, budget_line_id, description,
        quantity, unit, unit_cost_cents, scheduled_value_cents, sort_order, metadata
      ) values (
        p_org_id, v_commitment_id, nullif(v_line->>'cost_code_id', '')::uuid,
        v_budget_line_id, v_line->>'description', (v_line->>'quantity')::numeric,
        v_line->>'unit', (v_line->>'unit_cost_cents')::integer,
        (v_line->>'total_cents')::integer, coalesce((v_line->>'sort_order')::integer, 0),
        coalesce(v_line->'metadata', '{}'::jsonb) || jsonb_build_object(
          'source_generation_run_id', p_run_id,
          'source_agreement_id', v_line->>'source_agreement_id'
        )
      );
    end loop;
  end loop;

  for v_exception in select value from jsonb_array_elements(coalesce(p_payload->'exceptions', '[]'))
  loop
    insert into public.po_generation_exceptions (
      org_id, run_id, project_id, cost_code_id, source_kind, source_ref,
      description, quantity, uom, reason, candidates
    ) values (
      p_org_id, p_run_id, v_run.project_id,
      nullif(v_exception->>'cost_code_id', '')::uuid,
      v_exception->>'source_kind', coalesce(v_exception->'source_ref', '{}'::jsonb),
      v_exception->>'description', nullif(v_exception->>'quantity', '')::numeric,
      nullif(v_exception->>'uom', ''), v_exception->>'reason',
      coalesce(v_exception->'candidates', '[]'::jsonb)
    );
  end loop;

  -- The payload only carries exceptions that are not already open for the same
  -- source line, so the run's status comes from the summary's true count rather
  -- than from how many rows this run happened to need to insert.
  update public.po_generation_runs set
    status = case when coalesce(
        (p_payload->'summary'->>'exception_count')::integer,
        jsonb_array_length(coalesce(p_payload->'exceptions', '[]'))
      ) > 0
      then 'succeeded_with_exceptions' else 'succeeded' end,
    summary = coalesce(p_payload->'summary', '{}'::jsonb), completed_at = now()
  where org_id = p_org_id and id = p_run_id;

  return jsonb_build_object('run_id', p_run_id, 'budget_id', v_budget_id,
    'commitment_ids', to_jsonb(v_commitment_ids));
end;
$$;

revoke all on function public.run_po_generation_commit(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.run_po_generation_commit(uuid, uuid, jsonb) to service_role;

-- ==== 20261003033000_starts_land_posting_fences ====
-- STAGED, UNAPPLIED. Starts workers may post only their home's land transfer.
-- Ordinary Books callers retain existing policies and journal constraints.
create function public.fence_starts_land_posting_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_pkg public.start_packages%rowtype; v_rows jsonb[]; v_row jsonb;
 v_entry public.journal_entries%rowtype; v_actor uuid; v_code text;
begin
 v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
   if tg_op='DELETE' then return old; end if; return new;
 end if;
 if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
 if tg_op='INSERT' then v_rows:=array[to_jsonb(new)];
 elsif tg_op='DELETE' then v_rows:=array[to_jsonb(old)];
 else v_rows:=array[to_jsonb(old),to_jsonb(new)]; end if;
 v_pkg:=public.lock_starts_release_write_scope((v_rows[1]->>'org_id')::uuid);
 select (payload->>'actor_id')::uuid into v_actor from public.outbox where id=(v_headers->>'x-starts-job-id')::bigint;
 if v_actor is null then raise exception 'Starts posting actor missing' using errcode='42501'; end if;
 foreach v_row in array v_rows loop
   if (v_row->>'org_id')::uuid is distinct from v_pkg.org_id then raise exception 'Starts posting organization mismatch' using errcode='42501'; end if;
   if tg_table_name='journal_entries' then
     v_entry:=jsonb_populate_record(null::public.journal_entries,v_row);
   else
     if tg_table_name='journal_lines' then
       select * into v_entry from public.journal_entries where org_id=v_pkg.org_id and id=(v_row->>'entry_id')::uuid for share;
     else
       if v_row->>'source_type' is distinct from 'inventory_event'
         or (v_row->>'project_id')::uuid is distinct from v_pkg.project_id
         or (v_row->>'incurred_on')::date is distinct from v_pkg.scheduled_start_date
         or v_row->'metadata'->>'lot_id' is distinct from v_pkg.lot_id::text
         or v_row->'metadata'->>'journal_entry_id' is distinct from v_row->>'source_id'
         or v_row->>'status' is distinct from 'posted'
         or (v_row->>'is_billable')::boolean is distinct from false
         or ((v_row->>'cost_cents')::bigint>0) is not true then
         raise exception 'Starts job-cost transfer mismatch' using errcode='42501';
       end if;
       select * into v_entry from public.journal_entries where org_id=v_pkg.org_id and id=(v_row->>'source_id')::uuid for share;
     end if;
     if not found then raise exception 'Starts posting parent missing' using errcode='42501'; end if;
   end if;
   if v_entry.source_type is distinct from 'inventory_start'
     or v_entry.source_id is distinct from v_pkg.lot_id
     or v_entry.posting_key is distinct from 'inventory_start:'||v_pkg.lot_id::text
     or v_entry.entry_date is distinct from v_pkg.scheduled_start_date
     or v_entry.created_by is distinct from v_actor then
     raise exception 'Starts journal transfer mismatch' using errcode='42501';
   end if;
   if tg_table_name='job_cost_entries' then
     if v_entry.status is distinct from 'posted' or (v_row->>'cost_cents')::bigint is distinct from
       (select sum(debit_cents) from public.journal_lines where org_id=v_pkg.org_id and entry_id=v_entry.id and project_id=v_pkg.project_id) then
       raise exception 'Starts job-cost amount mismatch' using errcode='42501';
     end if;
   end if;
   if tg_table_name='journal_lines' then
     if v_row->'dimensions'->>'lot_id' is distinct from v_pkg.lot_id::text then raise exception 'Starts journal lot mismatch' using errcode='42501'; end if;
     select code into v_code from public.gl_accounts where org_id=v_pkg.org_id and id=(v_row->>'account_id')::uuid and active and account_type='asset' for share;
     if not found then raise exception 'Starts inventory account missing' using errcode='42501'; end if;
     if ((v_code='1160' and (v_row->>'project_id')::uuid=v_pkg.project_id and (v_row->>'debit_cents')::bigint>0 and (v_row->>'credit_cents')::bigint=0)
       or (v_code='1120' and v_row->>'project_id' is null and (v_row->>'credit_cents')::bigint>0 and (v_row->>'debit_cents')::bigint=0)) is not true then
       raise exception 'Starts inventory line mismatch' using errcode='42501';
     end if;
   end if;
 end loop;
 if tg_op='DELETE' then raise exception 'Starts worker cannot delete land postings' using errcode='42501'; end if;
 return new;
end $$;
do $$ declare v_table text; begin
 foreach v_table in array array['journal_entries','journal_lines','job_cost_entries'] loop
   execute format('create trigger starts_land_posting_worker_fence before insert or update or delete on public.%I for each row execute function public.fence_starts_land_posting_write()',v_table);
 end loop;
end $$;
revoke all on function public.fence_starts_land_posting_write() from public,anon,authenticated;

create or replace function public.transfer_books_land_to_start(p_org_id uuid,p_lot_id uuid,p_date date,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare worker_package public.start_packages%rowtype; lot public.lots%rowtype; land uuid; cip uuid; amount bigint; policy integer; result_id uuid; key text; dimensions jsonb;
begin
 worker_package:=public.lock_starts_release_write_scope(p_org_id);
 if worker_package.id is not null and (worker_package.lot_id is distinct from p_lot_id or worker_package.scheduled_start_date is distinct from p_date) then
   raise exception 'Starts land transfer scope mismatch' using errcode='42501';
 end if;
 select * into lot from public.lots where org_id=p_org_id and id=p_lot_id for update;
 if not found then raise exception 'Lot not found'; end if;
 if worker_package.id is not null and lot.project_id is distinct from worker_package.project_id then raise exception 'Starts land transfer home mismatch' using errcode='42501'; end if;
 if lot.books_acquisition_entry_id is null then return jsonb_build_object('status','not_tracked'); end if;
 if lot.project_id is null then raise exception 'Land must be assigned to its project before start'; end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=lot.project_id and books_inventory_enabled and books_inventory_effective_on<=p_date and books_inventory_completed_on is null and books_inventory_sold_on is null for update;
 if not found then raise exception 'Adopt the project inventory policy before releasing an owned-lot start'; end if;
 key:='inventory_start:'||lot.id;
 select e.id into result_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key=key and e.status='posted';
 if result_id is not null then
   if not exists(select 1 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id
     where e.org_id=p_org_id and e.id=result_id and e.entry_date=p_date and e.source_type='inventory_start' and e.source_id=lot.id
       and l.project_id=lot.project_id and l.dimensions->>'lot_id'=lot.id::text and l.debit_cents>0)
     or not exists(select 1 from public.job_cost_entries j where j.org_id=p_org_id and j.project_id=lot.project_id
       and j.source_type='inventory_event' and j.source_id=result_id::text and j.incurred_on=p_date and j.status='posted'
       and j.cost_cents=(select sum(l.debit_cents) from public.journal_lines l where l.org_id=p_org_id and l.entry_id=result_id and l.project_id=lot.project_id)) then
     raise exception 'Existing land transfer does not match this home, date or job-cost receipt';
   end if;
   return jsonb_build_object('status','posted','id',result_id);
 end if;
 select id into land from public.gl_accounts where org_id=p_org_id and code='1120' and active;
 select id into cip from public.gl_accounts where org_id=p_org_id and code='1160' and active;
 if land is null or cip is null then raise exception 'Inventory accounts are missing'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id;
 select coalesce(sum(l.debit_cents-l.credit_cents),0) into amount from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.account_id=land and l.dimensions->>'lot_id'=lot.id::text and e.status in('posted','reversed') and e.entry_date<=p_date;
 if amount<=0 then raise exception 'The owned lot has no positive recorded basis at the start date'; end if;
 dimensions:=jsonb_build_object('lot_id',lot.id,'community_id',lot.community_id,'division_id',lot.division_id,'acquisition_entry_id',lot.books_acquisition_entry_id);
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Transfer land into home construction','posting_key',key,'projection_version',1,'policy_version',policy,'source_type','inventory_start','source_id',lot.id,'created_by',p_actor_id),
 jsonb_build_array(jsonb_build_object('line_no',1,'account_id',cip,'project_id',lot.project_id,'debit_cents',amount,'credit_cents',0,'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',land,'debit_cents',0,'credit_cents',amount,'dimensions',dimensions)));
 insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata) values(p_org_id,lot.project_id,'inventory_event',result_id,p_date,amount,'posted',false,jsonb_build_object('lot_id',lot.id,'journal_entry_id',result_id));
 return jsonb_build_object('status','posted','id',result_id,'amount_cents',amount);
end;
$$;
revoke all on function public.transfer_books_land_to_start(uuid,uuid,date,uuid) from public,anon,authenticated;
grant execute on function public.transfer_books_land_to_start(uuid,uuid,date,uuid) to service_role;

-- ==== 20261003033500_starts_release_lot_plan_scope ====
-- STAGED, UNAPPLIED. Plan posture is pinned on the lot, not the start package.
create function public.starts_release_plan_version(p_package public.start_packages) returns uuid
language plpgsql set search_path=public,pg_catalog as $$
declare v_plan uuid;
begin
 select house_plan_version_id into v_plan from public.lots where org_id=p_package.org_id and id=p_package.lot_id
   and community_id=p_package.community_id and project_id=p_package.project_id for share;
 if not found or v_plan is null then raise exception 'Starts lot has no matching pinned plan scope' using errcode='42501'; end if;
 return v_plan;
end $$;
revoke all on function public.starts_release_plan_version(public.start_packages) from public,anon,authenticated;
grant execute on function public.starts_release_plan_version(public.start_packages) to service_role;

-- ==== 20261003034000_starts_drawing_record_fences ====
-- STAGED, UNAPPLIED. Database drawing/file ownership only: R2 writes and
-- drawing processor fanout still need their own durable ownership protocol.
create function public.fence_starts_drawing_record_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_pkg public.start_packages%rowtype; v_rows jsonb[]; v_row jsonb;
 v_project uuid; v_version uuid; v_source uuid; v_expected_source uuid; v_path text; v_position integer:=0;
begin
 v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
   if tg_op='DELETE' then return old; end if; return new;
 end if;
 if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
 if tg_op='INSERT' then v_rows:=array[to_jsonb(new)];
 elsif tg_op='DELETE' then v_rows:=array[to_jsonb(old)];
 else v_rows:=array[to_jsonb(old),to_jsonb(new)]; end if;
 v_pkg:=public.lock_starts_release_write_scope((v_rows[1]->>'org_id')::uuid);
 foreach v_row in array v_rows loop
   v_position:=v_position+1;
   if (v_row->>'org_id')::uuid is distinct from v_pkg.org_id or v_pkg.project_id is null
     or (v_row->>'project_id')::uuid is distinct from v_pkg.project_id then
     raise exception 'Starts drawing home mismatch' using errcode='42501';
   end if;
   if tg_table_name='files' then
     v_version:=(v_row->'metadata'->>'source_plan_version_id')::uuid;
     v_source:=(v_row->'metadata'->>'source_file_id')::uuid;
     if v_version is distinct from public.starts_release_plan_version(v_pkg) or v_version is null then raise exception 'Starts drawing plan mismatch' using errcode='42501'; end if;
     select (bundle_snapshot->>'drawing_source_file_id')::uuid into v_expected_source from public.house_plan_versions
       where org_id=v_pkg.org_id and id=v_version and status in ('released','superseded') for share;
     if not found or v_expected_source is null or v_source is distinct from v_expected_source then raise exception 'Starts drawing source snapshot mismatch' using errcode='42501'; end if;
     perform 1 from public.files where org_id=v_pkg.org_id and id=v_source for share;
     if not found then raise exception 'Starts drawing source file missing' using errcode='42501'; end if;
     v_path:=v_row->>'storage_path';
     if v_path is null or left(v_path,length(v_pkg.org_id::text||'/projects/'||v_pkg.project_id::text||'/plans/'||v_version::text||'/'))
         <>v_pkg.org_id::text||'/projects/'||v_pkg.project_id::text||'/plans/'||v_version::text||'/'
       or '..'=any(string_to_array(v_path,'/'))
       or v_row->>'source' is distinct from 'generated' or v_row->>'visibility' is distinct from 'private'
       or v_row->>'category' is distinct from 'plans' then raise exception 'Starts drawing file destination mismatch' using errcode='42501'; end if;
   else
     select project_id into v_project from public.files where org_id=v_pkg.org_id and id=(v_row->>'source_file_id')::uuid for share;
     if not found or v_project is distinct from v_pkg.project_id then raise exception 'Starts drawing project file mismatch' using errcode='42501'; end if;
     -- Existing canonical sets may still point to a manually uploaded PDF.
     -- Preserve that old ancestry check while requiring the new source to be
     -- the claimed plan's generated file, rather than any file in the home.
     if tg_op='INSERT' or (tg_op='UPDATE' and v_position=2) then
       perform 1 from public.files f join public.house_plan_versions v on v.org_id=f.org_id and v.id=public.starts_release_plan_version(v_pkg)
         where f.org_id=v_pkg.org_id and f.id=(v_row->>'source_file_id')::uuid
           and f.metadata->>'source_plan_version_id'=v.id::text
           and f.metadata->>'source_file_id'=v.bundle_snapshot->>'drawing_source_file_id'
           and f.source='generated' and f.category='plans' and f.visibility='private' for share of f,v;
       if not found then raise exception 'Starts drawing generated source mismatch' using errcode='42501'; end if;
     end if;
     if tg_table_name='drawing_revisions' then
       select project_id into v_project from public.drawing_sets where org_id=v_pkg.org_id and id=(v_row->>'drawing_set_id')::uuid for share;
       if not found or v_project is distinct from v_pkg.project_id then raise exception 'Starts drawing set mismatch' using errcode='42501'; end if;
     end if;
   end if;
 end loop;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
do $$ declare v_table text; begin
 foreach v_table in array array['files','drawing_sets','drawing_revisions'] loop
   execute format('create trigger starts_drawing_record_worker_fence before insert or update or delete on public.%I for each row execute function public.fence_starts_drawing_record_write()',v_table);
 end loop;
end $$;
revoke all on function public.fence_starts_drawing_record_write() from public,anon,authenticated;

-- ==== 20261003035000_plan_drawing_publication_transaction ====
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

-- ==== 20261003036000_plan_drawing_copy_attempt ====
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

-- ==== 20261003037000_starts_worker_outbox_fanout_fences ====
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

-- ==== 20261003038000_starts_release_actor_scope ====
-- STAGED, UNAPPLIED. Authorization at each locked generated-write scope.
-- Core/package transition authorization and non-header interactive RPC callers
-- remain separate work; this does not activate the claim consumers.
create function public.assert_starts_release_actor(p_job public.outbox,p_package public.start_packages)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_actor uuid; v_members uuid[]; v_roles uuid[]; v_base text[]; v_grants text[]; v_denies text[]; v_effective text[];
 v_assigned boolean; v_division uuid; v_lot_community uuid; v_lot_project uuid; v_divisions uuid[];
begin
 if p_job.org_id is distinct from p_package.org_id or p_job.job_type<>'start_release' then raise exception 'Starts actor scope mismatch' using errcode='42501'; end if;
 v_actor:=(p_job.payload->>'actor_id')::uuid;
 if v_actor is null then raise exception 'Starts actor missing' using errcode='42501'; end if;
 perform 1 from public.permissions where key='start.release' for share;
 if not found then raise exception 'Starts release permission is not registered' using errcode='42501'; end if;
 -- Parent UPDATE locks also block FK-backed insertion of a new override while
 -- permission facts are being used. Existing override/role rows are share locked.
 perform 1 from public.memberships where org_id=p_job.org_id and user_id=v_actor and status='active' order by id for update;
 select array_agg(id order by id),array_agg(distinct role_id),bool_or(division_scope='assigned') into v_members,v_roles,v_assigned
   from public.memberships where org_id=p_job.org_id and user_id=v_actor and status='active';
 if v_members is null then raise exception 'Starts actor is no longer an active organization member' using errcode='42501'; end if;
 perform 1 from public.role_permissions where role_id=any(v_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(v_members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into v_base from public.role_permissions where role_id=any(v_roles);
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into v_grants,v_denies
   from public.membership_permission_overrides where membership_id=any(v_members);
 select coalesce(array_agg(distinct x),'{}') into v_effective from unnest(v_base||v_grants) x where not(x=any(v_denies));
 if 'start.release'=any(v_denies) or not('start.release'=any(v_effective) or '*'=any(v_effective)) then raise exception 'Starts actor no longer has release permission' using errcode='42501'; end if;
 -- Mirrors fetchOrgPermissions division scope: a base org.admin role bypasses
 -- assignment scope; grants/denies still govern the requested release permission.
 v_assigned:=v_assigned and not('org.admin'=any(v_base));
 if v_assigned then
   perform 1 from public.membership_divisions where membership_id=any(v_members) order by membership_id,division_id for share;
   select coalesce(array_agg(distinct division_id),'{}') into v_divisions from public.membership_divisions where membership_id=any(v_members);
 end if;
 select division_id into v_division from public.communities where org_id=p_job.org_id and id=p_package.community_id for share;
 if not found then raise exception 'Starts community not found in organization' using errcode='42501'; end if;
 if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts community is outside actor division access' using errcode='42501'; end if;
 select division_id,community_id,project_id into v_division,v_lot_community,v_lot_project from public.lots where org_id=p_job.org_id and id=p_package.lot_id for share;
 if not found or v_lot_community is distinct from p_package.community_id then raise exception 'Starts lot ancestry differs from package' using errcode='42501'; end if;
 if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts lot is outside actor division access' using errcode='42501'; end if;
 if p_package.project_id is not null then
   if v_lot_project is distinct from p_package.project_id then raise exception 'Starts lot home ancestry differs from package' using errcode='42501'; end if;
   select division_id into v_division from public.projects where org_id=p_job.org_id and id=p_package.project_id for share;
   if not found then raise exception 'Starts home not found in organization' using errcode='42501'; end if;
   if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts home is outside actor division access' using errcode='42501'; end if;
 end if;
end $$;
revoke all on function public.assert_starts_release_actor(public.outbox,public.start_packages) from public,anon,authenticated;
grant execute on function public.assert_starts_release_actor(public.outbox,public.start_packages) to service_role;

create or replace function public.lock_starts_release_write_scope(p_org_id uuid) returns public.start_packages
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype;
begin
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then return null; end if;
  if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
  if coalesce(v_headers->>'x-starts-job-id','') !~ '^[1-9][0-9]{0,18}$'
    or coalesce(v_headers->>'x-starts-claim-token','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then raise exception 'Invalid starts worker context' using errcode='40001'; end if;
  select * into v_job from public.outbox where id=(v_headers->>'x-starts-job-id')::bigint
    and start_claim_token=(v_headers->>'x-starts-claim-token')::uuid and status='processing'
    and start_job_lease_expires_at>clock_timestamp() for update;
  if not found or v_job.job_type<>'start_release' then raise exception 'Starts worker lease lost' using errcode='40001'; end if;
  if p_org_id is distinct from v_job.org_id then raise exception 'Starts worker organization mismatch' using errcode='42501'; end if;
  select * into v_pkg from public.start_packages where org_id=v_job.org_id
    and id=(v_job.payload->>'start_package_id')::uuid for update;
  if not found or v_pkg.status<>'releasing' then raise exception 'Start package no longer releasing' using errcode='40001'; end if;
  if v_pkg.metadata->>'release_lease_token' is distinct from v_job.start_claim_token::text
    or v_pkg.metadata->>'release_lease_at' is null
    or (v_pkg.metadata->>'release_lease_at')::timestamptz<=clock_timestamp()-interval '5 minutes'
    then raise exception 'Start package lease lost' using errcode='40001'; end if;
  perform public.assert_starts_release_actor(v_job,v_pkg);
  return v_pkg;
end $$;

-- ==== 20261003040000_starts_core_actor_scope ====
-- STAGED, UNAPPLIED. Requires actor scope migration. No consumer activation.
-- Acquisition, renewal and domain writes require current actor permission.
-- Clear is ownership-only cleanup: an active claim may remove its own lease
-- after revocation, without modifying domain state or another worker's lease.
create or replace function public.fence_starts_core_worker_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_acquiring boolean:=false;
begin
  if current_user in ('anon','authenticated') and tg_table_name in ('start_packages','start_release_steps','start_package_gates')
    then raise exception 'Starts records require authorized server actions' using errcode='42501'; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
  if tg_op='DELETE' then raise exception 'Starts workers cannot delete core records' using errcode='42501'; end if;
  if coalesce(v_headers->>'x-starts-job-id','') !~ '^[1-9][0-9]{0,18}$'
    or coalesce(v_headers->>'x-starts-claim-token','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'Invalid starts worker context' using errcode='40001'; end if;
  select * into v_job from public.outbox where id=(v_headers->>'x-starts-job-id')::bigint
    and start_claim_token=(v_headers->>'x-starts-claim-token')::uuid
    and status='processing' and start_job_lease_expires_at>clock_timestamp() for update;
  if not found or v_job.job_type<>'start_release' then raise exception 'Starts worker lease lost' using errcode='40001'; end if;
  if new.org_id is distinct from v_job.org_id then raise exception 'Starts worker organization mismatch' using errcode='42501'; end if;
  select * into v_pkg from public.start_packages where org_id=v_job.org_id
    and id=(v_job.payload->>'start_package_id')::uuid for update;
  if not found or v_pkg.status<>'releasing' then raise exception 'Start package no longer releasing' using errcode='40001'; end if;
  if tg_table_name='start_packages' then
    if new.id is distinct from v_pkg.id then raise exception 'Starts worker package mismatch' using errcode='42501'; end if;
    -- Allow only metadata lease acquisition by a fresh owner when the previous
    -- package lease is absent or stale. This cannot smuggle domain edits.
    if tg_op='UPDATE' then
      v_acquiring:=new.metadata->>'release_lease_token'=v_job.start_claim_token::text
        and (old.metadata->>'release_lease_token' is null
          or (old.metadata->>'release_lease_at')::timestamptz<=clock_timestamp()-interval '5 minutes')
        and (to_jsonb(new)-'metadata'-'updated_at')=(to_jsonb(old)-'metadata'-'updated_at')
        and (coalesce(new.metadata,'{}')-'release_lease_token'-'release_lease_at')
          =(coalesce(old.metadata,'{}')-'release_lease_token'-'release_lease_at');
    end if;
  elsif tg_table_name in ('start_release_steps','start_package_gates') then
    if new.start_package_id is distinct from v_pkg.id then raise exception 'Starts worker package mismatch' using errcode='42501'; end if;
  elsif tg_table_name='projects' then
    if new.id is distinct from v_pkg.project_id then raise exception 'Starts worker project mismatch' using errcode='42501'; end if;
  elsif tg_table_name='lots' then
    if new.id is distinct from v_pkg.lot_id then raise exception 'Starts worker lot mismatch' using errcode='42501'; end if;
  else raise exception 'Unsupported starts fence table'; end if;
  if not coalesce(v_acquiring,false) and (v_pkg.metadata->>'release_lease_token' is distinct from v_job.start_claim_token::text
    or v_pkg.metadata->>'release_lease_at' is null
    or (v_pkg.metadata->>'release_lease_at')::timestamptz<=clock_timestamp()-interval '5 minutes')
    then raise exception 'Start package lease lost' using errcode='40001'; end if;
  perform public.assert_starts_release_actor(v_job,v_pkg);
  -- Workers operate on a home already linked before release. They cannot
  -- change the scope facts used to authorize this transaction.
  if tg_table_name in ('start_packages','projects','lots') then
    if tg_op<>'UPDATE' then raise exception 'Starts worker core identity must already exist' using errcode='42501'; end if;
    if new.id is distinct from old.id or new.org_id is distinct from old.org_id then
      raise exception 'Starts worker core identity is immutable' using errcode='42501';
    end if;
    if tg_table_name='start_packages' and
      (to_jsonb(new)->'project_id' is distinct from to_jsonb(old)->'project_id'
       or to_jsonb(new)->'lot_id' is distinct from to_jsonb(old)->'lot_id'
       or to_jsonb(new)->'community_id' is distinct from to_jsonb(old)->'community_id') then
      raise exception 'Starts worker package ancestry is immutable' using errcode='42501';
    end if;
    if tg_table_name in ('projects','lots') and to_jsonb(new)->'division_id' is distinct from to_jsonb(old)->'division_id' then
      raise exception 'Starts worker division is immutable' using errcode='42501';
    end if;
    if tg_table_name='lots' and
      (to_jsonb(new)->'project_id' is distinct from to_jsonb(old)->'project_id'
       or to_jsonb(new)->'community_id' is distinct from to_jsonb(old)->'community_id'
       or to_jsonb(new)->'house_plan_version_id' is distinct from to_jsonb(old)->'house_plan_version_id') then
      raise exception 'Starts worker lot ancestry and plan are immutable' using errcode='42501';
    end if;
  end if;
  return new;
end $$;

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
    if v_held is distinct from p_token::text or v_pkg.status is null or v_pkg.status not in ('releasing','released','attention') then return false; end if;
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

-- ==== 20261003041000_starts_claim_actor_transitions ====
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

-- ==== 20261003043000_purchasing_readiness_scope_index ====
-- STAGED, UNAPPLIED. Supports bounded starts price-book existence probes.
-- Review production index deployment/lock budget before applying.
create index vendor_price_agreements_active_readiness_scope_idx
 on public.vendor_price_agreements(org_id,community_id,division_id)
 where status='active';

-- ==== 20261003045000_starts_confirmation_recovery ====
-- STAGED, UNAPPLIED. Operator recovery must not rebuild a released house.
-- This service-only RPC is not enabled until actual-schema and QA acceptance.
create index outbox_start_release_package_idx on public.outbox(org_id,(payload->>'start_package_id'),id)
 where job_type='start_release';
create function public.retry_start_confirmation(p_org_id uuid,p_package_id uuid,p_job_id bigint,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_actor_job public.outbox%rowtype;
 v_before jsonb; v_after jsonb; v_headers jsonb; v_event_id uuid; v_audit_id bigint;
begin
 if current_user in ('anon','authenticated') then raise exception 'Confirmation recovery requires service role' using errcode='42501'; end if;
 if p_org_id is null or p_package_id is null or p_job_id is null or p_job_id<=0 or p_actor_id is null
   or p_reason is null or length(btrim(p_reason))<10 or length(btrim(p_reason))>1000 then raise exception 'Invalid confirmation recovery request'; end if;
 v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 if v_headers->>'x-starts-job-id' is not null or v_headers->>'x-starts-claim-token' is not null then
   raise exception 'Confirmation recovery cannot run inside a worker claim' using errcode='42501'; end if;
 -- Match worker job -> package lock order. Reuse this exact failed job; never
 -- insert replacement jobs when history was pruned or is ambiguous.
 select * into v_job from public.outbox where org_id=p_org_id and id=p_job_id
   and job_type='start_release' and payload->>'start_package_id'=p_package_id::text for update;
 if not found then raise exception 'Confirmation job unavailable in package' using errcode='42501'; end if;
 if v_job.status is distinct from 'failed' or v_job.start_claim_token is not null or v_job.start_job_lease_expires_at is not null then
   raise exception 'Only unclaimed failed confirmation jobs can be retried' using errcode='40001'; end if;
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.project_id is null or v_pkg.released_at is null
   or v_pkg.released_by is null or v_pkg.actual_start_date is null then
   raise exception 'Confirmation recovery requires a released home and original release evidence' using errcode='42501'; end if;
 if exists(select 1 from public.outbox where org_id=p_org_id and job_type='start_release'
   and payload->>'start_package_id'=p_package_id::text and id<>p_job_id and status in ('pending','processing')) then
   raise exception 'Another confirmation attempt is active' using errcode='40001'; end if;
 -- The coordinator authorizes recovery; confirmation still records released_by
 -- as the original release actor. Do not manufacture missing historical actors.
 v_actor_job:=v_job;
 v_actor_job.payload:=v_job.payload||jsonb_build_object('actor_id',p_actor_id);
 perform public.assert_starts_release_actor(v_actor_job,v_pkg);
 v_before:=jsonb_build_object('job_id',v_job.id::text,'status',v_job.status,'retry_count',v_job.retry_count,'actor_id',v_job.payload->>'actor_id');
 update public.outbox set status='pending',retry_count=0,last_error=null,run_at=clock_timestamp(),updated_at=clock_timestamp(),payload=v_actor_job.payload
   where id=v_job.id and org_id=p_org_id returning * into v_job;
 v_after:=jsonb_build_object('job_id',v_job.id::text,'status',v_job.status,'retry_count',v_job.retry_count,'actor_id',p_actor_id,
   'reason',btrim(p_reason),'released_by',v_pkg.released_by,'project_id',v_pkg.project_id,'released_at',v_pkg.released_at,'actual_start_date',v_pkg.actual_start_date);
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
   values(p_org_id,p_actor_id,'update','start_package',p_package_id,v_before,v_after,'starts.confirmation_recovery') returning id into v_audit_id;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
   values(p_org_id,'start.confirmation_retried','start_package',p_package_id,v_after,'activity') returning id into v_event_id;
 -- Guard against late revocation or source-state changes in trigger side effects.
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.released_by::text is distinct from v_after->>'released_by'
   or v_pkg.project_id::text is distinct from v_after->>'project_id'
   or to_jsonb(v_pkg.released_at) is distinct from v_after->'released_at'
   or to_jsonb(v_pkg.actual_start_date) is distinct from v_after->'actual_start_date' then raise exception 'Release evidence changed during confirmation recovery' using errcode='40001'; end if;
 select * into v_job from public.outbox where id=p_job_id and org_id=p_org_id for update;
 if not found or v_job.status is distinct from 'pending' or v_job.start_claim_token is not null
   or v_job.payload is distinct from v_actor_job.payload then raise exception 'Confirmation intent changed during recovery' using errcode='40001'; end if;
 perform public.assert_starts_release_actor(v_actor_job,v_pkg);
 return jsonb_build_object('job_id',v_job.id::text,'event_id',v_event_id,'audit_id',v_audit_id::text,'status','pending');
end $$;
revoke all on function public.retry_start_confirmation(uuid,uuid,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.retry_start_confirmation(uuid,uuid,bigint,uuid,text) to service_role;

-- ==== 20261003046000_starts_notification_delivery_recovery ====
-- STAGED, UNAPPLIED. Keep both delivery and starts-recovery rollouts disabled.
-- Permanent recovery request identities survive queue retention. Replays never
-- allocate another job; source notifications must still exist and match.
create table public.notification_delivery_recoveries (
 id uuid primary key,
 org_id uuid not null,
 receipt_id uuid not null references public.notification_delivery_receipts(id),
 package_id uuid not null,
 actor_id uuid not null,
 reason text not null check(length(btrim(reason)) between 10 and 1000),
 previous_job_id bigint,
 job_id bigint not null,
 event_id uuid not null,
 audit_id bigint not null,
 consumed_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create index notification_delivery_recoveries_receipt_idx on public.notification_delivery_recoveries(org_id,receipt_id,created_at);
alter table public.notification_delivery_recoveries enable row level security;
create policy notification_delivery_recoveries_service_access on public.notification_delivery_recoveries for all to service_role using(true) with check(true);
revoke all on public.notification_delivery_recoveries from public,anon,authenticated;
grant select,insert on public.notification_delivery_recoveries to service_role;
grant update(consumed_at) on public.notification_delivery_recoveries to service_role;
create function public.guard_notification_delivery_recovery() returns trigger language plpgsql set search_path=public,pg_catalog as $$
begin
 if tg_op='UPDATE' and pg_trigger_depth()>=2 and old.consumed_at is null and new.consumed_at is not null
   and (to_jsonb(new)-'consumed_at')=(to_jsonb(old)-'consumed_at')
   and coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-notification-recovery-id'=new.id::text then return new;end if;
 raise exception 'Delivery recovery evidence is immutable' using errcode='42501';
end $$;
create trigger notification_delivery_recovery_guard before update or delete on public.notification_delivery_recoveries for each row execute function public.guard_notification_delivery_recovery();
revoke all on function public.guard_notification_delivery_recovery() from public,anon,authenticated;

create or replace function public.guard_notification_delivery_receipt() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_note public.notifications%rowtype; v_job public.outbox%rowtype; v_recovery public.notification_delivery_recoveries%rowtype; v_request text;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery receipts require service role' using errcode='42501'; end if;
 if tg_op='DELETE' then raise exception 'Delivery receipts cannot be deleted' using errcode='42501'; end if;
 if tg_op='UPDATE' then
   if (to_jsonb(new)-array['status','completed_at','outbox_job_id']) is distinct from (to_jsonb(old)-array['status','completed_at','outbox_job_id'])
     then raise exception 'Delivery receipt identity is immutable' using errcode='42501'; end if;
   if old.status='completed' and (new.status is distinct from old.status or new.completed_at is distinct from old.completed_at) then raise exception 'Completed delivery receipt is immutable' using errcode='42501'; end if;
   if old.status='failed' and new.status='pending' then
     v_request:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-notification-recovery-id';
     if coalesce(v_request,'')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Failed delivery requires audited recovery' using errcode='42501'; end if;
     select * into v_recovery from public.notification_delivery_recoveries where id=v_request::uuid and org_id=old.org_id and receipt_id=old.id;
     if not found or v_recovery.previous_job_id is distinct from old.outbox_job_id or v_recovery.job_id is distinct from new.outbox_job_id or v_recovery.consumed_at is not null then
       raise exception 'Delivery recovery proof does not match the receipt' using errcode='42501'; end if;
     update public.notification_delivery_recoveries set consumed_at=clock_timestamp() where id=v_recovery.id;
   end if;
   if new.outbox_job_id is distinct from old.outbox_job_id then
     if new.outbox_job_id is null and old.status in ('completed','failed') and new.status=old.status
       and not exists(select 1 from public.outbox where id=old.outbox_job_id) then return new; end if;
     if not(old.status='failed' and new.status='pending' and old.outbox_job_id is null and v_recovery.id is not null)
       then raise exception 'Delivery receipt cannot replace its original job' using errcode='42501'; end if;
   end if;
 end if;
 if new.outbox_job_id is null then raise exception 'Delivery receipt requires its original job' using errcode='42501'; end if;
 select * into v_job from public.outbox where id=new.outbox_job_id for share;
 if not found or v_job.org_id is distinct from new.org_id or v_job.job_type is distinct from new.job_type
   or v_job.payload->>'notificationId' is distinct from new.notification_id::text
   or v_job.payload->>'deliveryReceiptId' is distinct from new.id::text or v_job.status is distinct from new.status
   then raise exception 'Delivery receipt job scope mismatch' using errcode='42501'; end if;
 if tg_op='INSERT' then
   select * into v_note from public.notifications where id=new.notification_id and org_id=new.org_id for share;
   if not found or v_note.user_id is distinct from new.notification_user_id or v_note.notification_type is distinct from new.notification_type
     or encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex') is distinct from new.payload_hash
     then raise exception 'Delivery receipt notification scope mismatch' using errcode='42501'; end if;
 end if;
 if (new.status='completed') is distinct from (new.completed_at is not null) then raise exception 'Invalid delivery completion receipt' using errcode='42501'; end if;
 return new;
end $$;

create function public.assert_starts_actor_permission(p_job public.outbox,p_package public.start_packages,p_permission text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_actor uuid; v_members uuid[]; v_roles uuid[]; v_base text[]; v_grants text[]; v_denies text[]; v_effective text[];
 v_assigned boolean; v_division uuid; v_lot_community uuid; v_lot_project uuid; v_divisions uuid[];
begin
 if p_permission not in ('start.release','start.read') or p_permission is null then raise exception 'Invalid starts permission scope' using errcode='42501'; end if;
 if p_job.org_id is distinct from p_package.org_id or p_job.job_type<>'start_release' then raise exception 'Starts actor scope mismatch' using errcode='42501'; end if;
 v_actor:=(p_job.payload->>'actor_id')::uuid;
 if v_actor is null then raise exception 'Starts actor missing' using errcode='42501'; end if;
 perform 1 from public.permissions where key=p_permission for share;
 if not found then raise exception 'Starts release permission is not registered' using errcode='42501'; end if;
 -- Parent UPDATE locks also block FK-backed insertion of a new override while
 -- permission facts are being used. Existing override/role rows are share locked.
 perform 1 from public.memberships where org_id=p_job.org_id and user_id=v_actor and status='active' order by id for update;
 select array_agg(id order by id),array_agg(distinct role_id),bool_or(division_scope='assigned') into v_members,v_roles,v_assigned
   from public.memberships where org_id=p_job.org_id and user_id=v_actor and status='active';
 if v_members is null then raise exception 'Starts actor is no longer an active organization member' using errcode='42501'; end if;
 perform 1 from public.role_permissions where role_id=any(v_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(v_members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into v_base from public.role_permissions where role_id=any(v_roles);
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into v_grants,v_denies
   from public.membership_permission_overrides where membership_id=any(v_members);
 select coalesce(array_agg(distinct x),'{}') into v_effective from unnest(v_base||v_grants) x where not(x=any(v_denies));
 if p_permission=any(v_denies) or not(p_permission=any(v_effective) or '*'=any(v_effective)) then raise exception 'Starts actor no longer has release permission' using errcode='42501'; end if;
 -- Mirrors fetchOrgPermissions division scope: a base org.admin role bypasses
 -- assignment scope; grants/denies still govern the requested release permission.
 v_assigned:=v_assigned and not('org.admin'=any(v_base));
 if v_assigned then
   perform 1 from public.membership_divisions where membership_id=any(v_members) order by membership_id,division_id for share;
   select coalesce(array_agg(distinct division_id),'{}') into v_divisions from public.membership_divisions where membership_id=any(v_members);
 end if;
 select division_id into v_division from public.communities where org_id=p_job.org_id and id=p_package.community_id for share;
 if not found then raise exception 'Starts community not found in organization' using errcode='42501'; end if;
 if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts community is outside actor division access' using errcode='42501'; end if;
 select division_id,community_id,project_id into v_division,v_lot_community,v_lot_project from public.lots where org_id=p_job.org_id and id=p_package.lot_id for share;
 if not found or v_lot_community is distinct from p_package.community_id then raise exception 'Starts lot ancestry differs from package' using errcode='42501'; end if;
 if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts lot is outside actor division access' using errcode='42501'; end if;
 if p_package.project_id is not null then
   if v_lot_project is distinct from p_package.project_id then raise exception 'Starts lot home ancestry differs from package' using errcode='42501'; end if;
   select division_id into v_division from public.projects where org_id=p_job.org_id and id=p_package.project_id for share;
   if not found then raise exception 'Starts home not found in organization' using errcode='42501'; end if;
   if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts home is outside actor division access' using errcode='42501'; end if;
 end if;
end $$;
revoke all on function public.assert_starts_actor_permission(public.outbox,public.start_packages,text) from public,anon,authenticated;
grant execute on function public.assert_starts_actor_permission(public.outbox,public.start_packages,text) to service_role;
create or replace function public.assert_starts_release_actor(p_job public.outbox,p_package public.start_packages)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
begin perform public.assert_starts_actor_permission(p_job,p_package,'start.release');end $$;
create function public.assert_start_notification_recipient(p_note public.notifications,p_package public.start_packages)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype;v_super uuid;
begin
 select superintendent_id into v_super from public.projects where org_id=p_package.org_id and id=p_package.project_id for share;
 if not found or p_note.org_id is distinct from p_package.org_id or p_note.user_id is null then raise exception 'Notification recipient scope mismatch' using errcode='42501'; end if;
 v_job.org_id:=p_note.org_id;v_job.job_type:='start_release';v_job.payload:=jsonb_build_object('actor_id',p_note.user_id);
 perform public.assert_starts_actor_permission(v_job,p_package,case when p_note.user_id=v_super then 'start.read' else 'start.release' end);
end $$;
revoke all on function public.assert_start_notification_recipient(public.notifications,public.start_packages) from public,anon,authenticated;
grant execute on function public.assert_start_notification_recipient(public.notifications,public.start_packages) to service_role;

create function public.retry_start_notification_delivery(p_org_id uuid,p_package_id uuid,p_receipt_id uuid,p_actor_id uuid,p_request_id uuid,p_reason text)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_actor_job public.outbox%rowtype; v_note public.notifications%rowtype;
 v_receipt public.notification_delivery_receipts%rowtype; v_job public.outbox%rowtype; v_recovery public.notification_delivery_recoveries%rowtype;
 v_headers text:=current_setting('request.headers',true); v_context jsonb; v_previous bigint; v_event uuid; v_audit bigint; v_evidence jsonb; v_source jsonb;v_changed integer;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery recovery requires service role' using errcode='42501'; end if;
 if p_org_id is null or p_package_id is null or p_receipt_id is null or p_actor_id is null or p_request_id is null
   or p_reason is null or length(btrim(p_reason))<10 or length(btrim(p_reason))>1000 then raise exception 'Invalid delivery recovery request'; end if;
 v_context:=coalesce(nullif(v_headers,''),'{}')::jsonb;
 if v_context->>'x-starts-job-id' is not null or v_context->>'x-starts-claim-token' is not null then raise exception 'Delivery recovery cannot run inside a worker claim' using errcode='42501'; end if;
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.project_id is null or v_pkg.released_by is null
   or v_pkg.released_at is null or v_pkg.actual_start_date is null then raise exception 'Delivery recovery requires original released-home evidence' using errcode='42501'; end if;
 v_actor_job.org_id:=p_org_id;v_actor_job.job_type:='start_release';v_actor_job.payload:=jsonb_build_object('start_package_id',p_package_id,'actor_id',p_actor_id);
 perform public.assert_starts_release_actor(v_actor_job,v_pkg);
 v_source:=jsonb_build_object('project_id',v_pkg.project_id,'community_id',v_pkg.community_id,'lot_id',v_pkg.lot_id,'released_by',v_pkg.released_by,'released_at',v_pkg.released_at,'actual_start_date',v_pkg.actual_start_date);
 -- Read identity without locking. Take notification -> job -> receipt locks in
 -- the same order as delivery reservation, completion and retention.
 select * into v_receipt from public.notification_delivery_receipts where org_id=p_org_id and id=p_receipt_id;
 if not found then raise exception 'Delivery receipt unavailable in organization' using errcode='42501'; end if;
 select * into v_note from public.notifications where org_id=p_org_id and id=v_receipt.notification_id for update;
 if not found or v_note.notification_type is distinct from 'start_released' or v_note.payload->>'entity_type' is distinct from 'start_package'
   or v_note.payload->>'entity_id' is distinct from p_package_id::text or v_note.payload->>'project_id' is distinct from v_pkg.project_id::text then
   raise exception 'Original package notification is unavailable' using errcode='42501'; end if;
 if v_receipt.outbox_job_id is not null then perform 1 from public.outbox where id=v_receipt.outbox_job_id and org_id=p_org_id for update; end if;
 select * into v_receipt from public.notification_delivery_receipts where org_id=p_org_id and id=p_receipt_id for update;
 if v_receipt.notification_user_id is distinct from v_note.user_id or v_receipt.notification_type is distinct from v_note.notification_type
   or v_receipt.payload_hash is distinct from encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex') then raise exception 'Notification differs from its delivery receipt' using errcode='42501'; end if;
 perform public.assert_start_notification_recipient(v_note,v_pkg);
 -- A lost response reuses the durable request proof even if the delivery has
 -- completed or its queue row has since been pruned. Authorization still applies.
 select * into v_recovery from public.notification_delivery_recoveries where id=p_request_id;
 if found then
   if v_recovery.consumed_at is null then raise exception 'Recovery proof was not consumed' using errcode='42501'; end if;
   if v_recovery.org_id is distinct from p_org_id or v_recovery.receipt_id is distinct from p_receipt_id or v_recovery.package_id is distinct from p_package_id
     or v_recovery.actor_id is distinct from p_actor_id or v_recovery.reason is distinct from btrim(p_reason) then raise exception 'Recovery request identity belongs to different evidence' using errcode='42501'; end if;
   return jsonb_build_object('request_id',v_recovery.id,'receipt_id',v_recovery.receipt_id,'job_id',v_recovery.job_id::text,'event_id',v_recovery.event_id,'audit_id',v_recovery.audit_id::text,'status',v_receipt.status,'replayed',true);
 end if;
 if v_receipt.status is distinct from 'failed' then raise exception 'Only failed deliveries can be recovered' using errcode='40001'; end if;
 v_previous:=v_receipt.outbox_job_id;
 if v_previous is not null then
   select * into v_job from public.outbox where org_id=p_org_id and id=v_previous for update;
   if not found or v_job.status is distinct from 'failed' or v_job.job_type is distinct from v_receipt.job_type
     or v_job.payload->>'deliveryReceiptId' is distinct from v_receipt.id::text
     or v_job.payload->>'notificationId' is distinct from v_note.id::text then raise exception 'Failed delivery job differs from its receipt' using errcode='42501'; end if;
 else
   if exists(select 1 from public.outbox where org_id=p_org_id and job_type=v_receipt.job_type and lower(payload->>'notificationId')=v_note.id::text) then
     raise exception 'Unreceipted delivery history requires reconciliation' using errcode='42501'; end if;
   insert into public.outbox(org_id,job_type,payload,dedupe_key)
     values(p_org_id,v_receipt.job_type,jsonb_build_object('notificationId',v_note.id,'deliveryReceiptId',v_receipt.id),
       'notification-delivery:v1:'||v_receipt.job_type||':'||v_note.id) returning * into v_job;
 end if;
 v_evidence:=jsonb_build_object('request_id',p_request_id,'receipt_id',p_receipt_id,'previous_job_id',v_previous::text,'job_id',v_job.id::text,
   'actor_id',p_actor_id,'reason',btrim(p_reason),'project_id',v_pkg.project_id,'notification_id',v_note.id,'channel',v_receipt.job_type,'release_evidence',v_source);
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
   values(p_org_id,p_actor_id,'update','start_package',p_package_id,jsonb_build_object('status','failed','receipt_id',p_receipt_id),v_evidence,'starts.notification_delivery_recovery') returning id into v_audit;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
   values(p_org_id,'start.notification_delivery_retried','start_package',p_package_id,v_evidence,'activity') returning id into v_event;
 insert into public.notification_delivery_recoveries(id,org_id,receipt_id,package_id,actor_id,reason,previous_job_id,job_id,event_id,audit_id)
   values(p_request_id,p_org_id,p_receipt_id,p_package_id,p_actor_id,btrim(p_reason),v_previous,v_job.id,v_event,v_audit);
 perform set_config('request.headers',(v_context||jsonb_build_object('x-notification-recovery-id',p_request_id))::text,true);
 if v_previous is not null then
   update public.outbox set status='pending',retry_count=0,last_error=null,run_at=clock_timestamp(),updated_at=clock_timestamp() where id=v_previous and status='failed';
   get diagnostics v_changed=row_count;
   if v_changed<>1 then raise exception 'Failed delivery job changed during recovery' using errcode='40001'; end if;
 else
   update public.notification_delivery_receipts set status='pending',outbox_job_id=v_job.id,completed_at=null where id=p_receipt_id;
 end if;
 perform set_config('request.headers',coalesce(v_headers,''),true);
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
 if not found or v_pkg.status is distinct from 'released' or jsonb_build_object('project_id',v_pkg.project_id,'community_id',v_pkg.community_id,'lot_id',v_pkg.lot_id,'released_by',v_pkg.released_by,'released_at',v_pkg.released_at,'actual_start_date',v_pkg.actual_start_date) is distinct from v_source then raise exception 'Released home changed during delivery recovery' using errcode='40001'; end if;
 perform public.assert_starts_release_actor(v_actor_job,v_pkg);
 select * into v_note from public.notifications where org_id=p_org_id and id=v_note.id for update;
 if not found or v_note.user_id is distinct from v_receipt.notification_user_id or v_note.notification_type is distinct from v_receipt.notification_type
   or encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex') is distinct from v_receipt.payload_hash then raise exception 'Notification changed during recovery' using errcode='40001'; end if;
 perform public.assert_start_notification_recipient(v_note,v_pkg);
 select * into v_receipt from public.notification_delivery_receipts where id=p_receipt_id for update;
 if v_receipt.status is distinct from 'pending' or v_receipt.outbox_job_id is distinct from v_job.id then raise exception 'Delivery intent changed during recovery' using errcode='40001'; end if;
 if not exists(select 1 from public.notification_delivery_recoveries where id=p_request_id and consumed_at is not null) then raise exception 'Recovery proof was not consumed' using errcode='40001'; end if;
 return jsonb_build_object('request_id',p_request_id,'receipt_id',p_receipt_id,'job_id',v_job.id::text,'event_id',v_event,'audit_id',v_audit::text,'status','pending','replayed',false);
end $$;
revoke all on function public.retry_start_notification_delivery(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.retry_start_notification_delivery(uuid,uuid,uuid,uuid,uuid,text) to service_role;

-- ==== 20261003047000_starts_delivery_inspection ====
-- STAGED, UNAPPLIED. Permanent source scope enables bounded operator reads
-- after notification/outbox retention. Both recovery rollout gates remain off.
alter table public.notification_delivery_receipts add column source_entity_type text,
 add column source_entity_id text,add column source_project_id text;
-- ALTER holds the table lock through the migration transaction. Remove the
-- identity guard only for verified historical scope enrichment, then restore it.
drop trigger notification_delivery_receipt_guard on public.notification_delivery_receipts;
update public.notification_delivery_receipts r set source_entity_type=n.payload->>'entity_type',
 source_entity_id=n.payload->>'entity_id',source_project_id=n.payload->>'project_id'
 from public.notifications n where n.org_id=r.org_id and n.id=r.notification_id and n.user_id=r.notification_user_id
 and n.notification_type=r.notification_type and encode(sha256(convert_to(n.payload::text,'UTF8')),'hex')=r.payload_hash;
-- Missing or altered source records remain unresolved; do not infer their home.
create or replace function public.guard_notification_delivery_receipt() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_note public.notifications%rowtype; v_job public.outbox%rowtype; v_recovery public.notification_delivery_recoveries%rowtype; v_request text;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery receipts require service role' using errcode='42501'; end if;
 if tg_op='DELETE' then raise exception 'Delivery receipts cannot be deleted' using errcode='42501'; end if;
 if tg_op='UPDATE' then
   if (to_jsonb(new)-array['status','completed_at','outbox_job_id']) is distinct from (to_jsonb(old)-array['status','completed_at','outbox_job_id'])
     then raise exception 'Delivery receipt identity is immutable' using errcode='42501'; end if;
   if old.status='completed' and (new.status is distinct from old.status or new.completed_at is distinct from old.completed_at) then raise exception 'Completed delivery receipt is immutable' using errcode='42501'; end if;
   if old.status='failed' and new.status='pending' then
     v_request:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-notification-recovery-id';
     if coalesce(v_request,'')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Failed delivery requires audited recovery' using errcode='42501'; end if;
     select * into v_recovery from public.notification_delivery_recoveries where id=v_request::uuid and org_id=old.org_id and receipt_id=old.id;
     if not found or v_recovery.previous_job_id is distinct from old.outbox_job_id or v_recovery.job_id is distinct from new.outbox_job_id or v_recovery.consumed_at is not null then
       raise exception 'Delivery recovery proof does not match the receipt' using errcode='42501'; end if;
     update public.notification_delivery_recoveries set consumed_at=clock_timestamp() where id=v_recovery.id;
   end if;
   if new.outbox_job_id is distinct from old.outbox_job_id then
     if new.outbox_job_id is null and old.status in ('completed','failed') and new.status=old.status
       and not exists(select 1 from public.outbox where id=old.outbox_job_id) then return new; end if;
     if not(old.status='failed' and new.status='pending' and old.outbox_job_id is null and v_recovery.id is not null)
       then raise exception 'Delivery receipt cannot replace its original job' using errcode='42501'; end if;
   end if;
 end if;
 if new.outbox_job_id is null then raise exception 'Delivery receipt requires its original job' using errcode='42501'; end if;
 select * into v_job from public.outbox where id=new.outbox_job_id for share;
 if not found or v_job.org_id is distinct from new.org_id or v_job.job_type is distinct from new.job_type
   or v_job.payload->>'notificationId' is distinct from new.notification_id::text
   or v_job.payload->>'deliveryReceiptId' is distinct from new.id::text or v_job.status is distinct from new.status
   then raise exception 'Delivery receipt job scope mismatch' using errcode='42501'; end if;
 if tg_op='INSERT' then
   select * into v_note from public.notifications where id=new.notification_id and org_id=new.org_id for share;
   if not found or v_note.user_id is distinct from new.notification_user_id or v_note.notification_type is distinct from new.notification_type
     or encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex') is distinct from new.payload_hash
     then raise exception 'Delivery receipt notification scope mismatch' using errcode='42501'; end if;
   new.source_entity_type:=v_note.payload->>'entity_type';
   new.source_entity_id:=v_note.payload->>'entity_id';
   new.source_project_id:=v_note.payload->>'project_id';
 end if;
 if (new.status='completed') is distinct from (new.completed_at is not null) then raise exception 'Invalid delivery completion receipt' using errcode='42501'; end if;
 return new;
end $$;


create trigger notification_delivery_receipt_guard before insert or update or delete on public.notification_delivery_receipts
 for each row execute function public.guard_notification_delivery_receipt();
create index notification_delivery_receipts_package_idx on public.notification_delivery_receipts(org_id,source_entity_id,id)
 where source_entity_type='start_package';
create function public.list_start_notification_deliveries(p_org_id uuid,p_package_id uuid,p_actor_id uuid,p_after uuid default null,p_failed_only boolean default true,p_limit integer default 20)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype;v_job public.outbox%rowtype;v_rows jsonb;v_next uuid;v_more boolean;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery inspection requires service role' using errcode='42501';end if;
 if p_org_id is null or p_package_id is null or p_actor_id is null or p_limit is null or p_limit<1 or p_limit>50 or p_failed_only is null then raise exception 'Invalid delivery inspection request';end if;
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for share;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.project_id is null then raise exception 'Released package unavailable in organization' using errcode='42501';end if;
 v_job.org_id:=p_org_id;v_job.job_type:='start_release';v_job.payload:=jsonb_build_object('actor_id',p_actor_id);
 perform public.assert_starts_release_actor(v_job,v_pkg);
 if p_after is not null and not exists(select 1 from public.notification_delivery_receipts where org_id=p_org_id
   and source_entity_type='start_package' and source_entity_id=p_package_id::text and source_project_id=v_pkg.project_id::text and id=p_after) then
   raise exception 'Delivery cursor belongs to a different package' using errcode='42501';end if;
 with candidates as (
  select r.* from public.notification_delivery_receipts r where r.org_id=p_org_id and r.source_entity_type='start_package'
   and r.source_entity_id=p_package_id::text and r.source_project_id=v_pkg.project_id::text
   and (p_after is null or r.id>p_after) and (not p_failed_only or r.status='failed') order by r.id limit p_limit+1
 ), page as (select * from candidates order by id limit p_limit), items as (
  select r.id,jsonb_build_object('receipt_id',r.id,'recipient_name',coalesce(nullif(u.full_name,''),'Unavailable recipient'),
   'channel',r.job_type,'status',r.status,'job_id',r.outbox_job_id::text,'retry_count',o.retry_count,'error',o.last_error,
   'completed_at',r.completed_at,'source_available',exists(select 1 from public.notifications n where n.org_id=r.org_id and n.id=r.notification_id
     and n.user_id=r.notification_user_id and n.notification_type=r.notification_type and encode(sha256(convert_to(n.payload::text,'UTF8')),'hex')=r.payload_hash)) item
  from page r left join public.outbox o on o.org_id=r.org_id and o.id=r.outbox_job_id left join public.app_users u on u.id=r.notification_user_id
 ) select coalesce(jsonb_agg(item order by id),'[]'),(select id from page order by id desc limit 1),(select count(*)>p_limit from candidates)
   into v_rows,v_next,v_more from items;
 return jsonb_build_object('items',v_rows,'next_cursor',case when v_more then v_next else null end,'has_more',v_more);
end $$;
revoke all on function public.list_start_notification_deliveries(uuid,uuid,uuid,uuid,boolean,integer) from public,anon,authenticated;
grant execute on function public.list_start_notification_deliveries(uuid,uuid,uuid,uuid,boolean,integer) to service_role;

-- ==== 20261003048000_starts_notification_delivery_authorization ====
-- STAGED, UNAPPLIED. Reauthorize receipted jobs immediately before provider send.
-- A database check cannot hold authorization atomic across the external network.
create function public.authorize_start_notification_delivery(p_org_id uuid,p_job_id bigint,p_receipt_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_receipt public.notification_delivery_receipts%rowtype;v_note public.notifications%rowtype;v_job public.outbox%rowtype;v_pkg public.start_packages%rowtype;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery authorization requires service role' using errcode='42501';end if;
 if p_org_id is null or p_job_id is null or p_job_id<=0 or p_receipt_id is null then raise exception 'Invalid delivery authorization request';end if;
 select * into v_receipt from public.notification_delivery_receipts where org_id=p_org_id and id=p_receipt_id;
 if not found or v_receipt.source_entity_type is distinct from 'start_package' or v_receipt.source_entity_id is null then raise exception 'Verified starts delivery scope unavailable' using errcode='42501';end if;
 -- Match recovery's package -> notification -> job -> receipt order. Source
 -- identities are immutable; the final locked receipt must still own this job.
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=v_receipt.source_entity_id::uuid for share;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.project_id::text is distinct from v_receipt.source_project_id then raise exception 'Released home delivery scope changed' using errcode='42501';end if;
 select * into v_note from public.notifications where org_id=p_org_id and id=v_receipt.notification_id for share;
 if not found then raise exception 'Original notification unavailable' using errcode='42501';end if;
 select * into v_job from public.outbox where org_id=p_org_id and id=p_job_id for update;
 if not found or v_job.status is distinct from 'processing' or v_job.job_type is distinct from v_receipt.job_type
   or v_job.payload->>'notificationId' is distinct from v_note.id::text or v_job.payload->>'deliveryReceiptId' is distinct from p_receipt_id::text then raise exception 'Delivery job is no longer owned by receipt' using errcode='40001';end if;
 select * into v_receipt from public.notification_delivery_receipts where org_id=p_org_id and id=p_receipt_id for share;
 if v_receipt.outbox_job_id is distinct from p_job_id or v_receipt.status is distinct from 'processing'
   or v_note.user_id is distinct from v_receipt.notification_user_id or v_note.notification_type is distinct from 'start_released'
   or v_note.notification_type is distinct from v_receipt.notification_type or v_note.payload->>'entity_type' is distinct from 'start_package'
   or v_note.payload->>'entity_id' is distinct from v_pkg.id::text or v_note.payload->>'project_id' is distinct from v_pkg.project_id::text
   or encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex') is distinct from v_receipt.payload_hash then raise exception 'Notification differs from authorized delivery evidence' using errcode='42501';end if;
 perform public.assert_start_notification_recipient(v_note,v_pkg);
 return jsonb_build_object('id',v_note.id,'org_id',v_note.org_id,'user_id',v_note.user_id,'notification_type',v_note.notification_type,'payload',v_note.payload,'created_at',v_note.created_at);
end $$;
revoke all on function public.authorize_start_notification_delivery(uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.authorize_start_notification_delivery(uuid,bigint,uuid) to service_role;

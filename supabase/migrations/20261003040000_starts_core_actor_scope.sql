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

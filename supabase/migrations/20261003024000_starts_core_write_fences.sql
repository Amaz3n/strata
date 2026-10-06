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

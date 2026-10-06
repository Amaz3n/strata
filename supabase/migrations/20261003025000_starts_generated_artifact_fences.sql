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

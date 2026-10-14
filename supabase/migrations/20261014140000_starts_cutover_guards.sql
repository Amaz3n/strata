-- Starts cutover guards: the drawing-copy manifest and the drawing child jobs
-- are server-owned.
--
-- 1. The drawing-copy manifest lives at
--    projects.metadata->'plan_instantiation'->'drawing_copy_attempt'. The
--    `projects_access` policy lets any org member write the row, so a member
--    could forge a `reserved` manifest naming any object under the org's
--    storage prefix and have the abandoned-copy sweep delete it, or wedge a
--    home's release at the drawings step. Browser roles may no longer change
--    that key; reserve/publish/claim/clear are definer or service-role paths
--    and pass. The rest of plan_instantiation (steps, produced, seq) is still
--    written by the interactive instantiation with the member's own client.
-- 2. Defense in depth: the sweep claims only a manifest whose path is exactly
--    the one reserve_plan_drawing_copy builds for its own attempt and source
--    file, whose attempt id is a uuid, and which no file row names. It claims
--    the oldest reservations first and filters in the query, so a handful of
--    young or file-named manifests can no longer fill the window and starve
--    the rest.
-- 3. The eight drawing job types and the claim/lease columns of both worker
--    protocols are server-authored: a member cannot insert, rewrite, complete
--    or delete a drawing child job, nor set a claim token or lease on any row.
--    Mirrors guard_starts_job_browser_writes (20261003048000) and
--    guard_audit_retry_browser_writes (20261011170000).
-- 4. starts_cutover_ready() is the marker the worker's schema-readiness guard
--    probes: it exists only once this migration (the last of the EP07 set) has
--    been applied, so new code on an old schema stays inert instead of failing.
--
-- Requires 20261003048000_starts_release_and_purchasing_fences and
-- 20261010141000_abandoned_plan_drawing_copy_cleanup.

-- ---------------------------------------------------------------------------
-- 1. The manifest.
-- ---------------------------------------------------------------------------

create function public.guard_plan_drawing_copy_manifest_browser_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
    (tg_op = 'INSERT' and new.metadata->'plan_instantiation'->'drawing_copy_attempt' is not null)
    or (tg_op = 'UPDATE' and new.metadata->'plan_instantiation'->'drawing_copy_attempt'
      is distinct from old.metadata->'plan_instantiation'->'drawing_copy_attempt')
  ) then
    raise exception 'Drawing copy state is server-owned' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger projects_plan_drawing_copy_manifest_guard
  before insert or update of metadata on public.projects
  for each row execute function public.guard_plan_drawing_copy_manifest_browser_writes();

revoke all on function public.guard_plan_drawing_copy_manifest_browser_writes() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The sweep.
-- ---------------------------------------------------------------------------

-- Whether a manifest names the destination reserve_plan_drawing_copy would have
-- built for it: the home's own plan folder, its own plan version and attempt,
-- and the file name of the source file it recorded.
create function public.plan_drawing_copy_path_is_canonical(p_org_id uuid, p_project_id uuid, p_attempt jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(case when
    jsonb_typeof(p_attempt) = 'object'
    and p_attempt->>'attempt_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and p_attempt->>'plan_version_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and p_attempt->>'source_file_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then exists (
      select 1 from public.files f
      where f.org_id = p_org_id and f.id = (p_attempt->>'source_file_id')::uuid
        and nullif(btrim(f.file_name), '') is not null
        and p_attempt->>'storage_path' = p_org_id::text || '/projects/' || p_project_id::text || '/plans/'
          || (p_attempt->>'plan_version_id')::uuid::text || '/' || (p_attempt->>'attempt_id')::uuid::text || '/' || f.file_name
    ) end,
    false)
$$;

revoke all on function public.plan_drawing_copy_path_is_canonical(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.plan_drawing_copy_path_is_canonical(uuid, uuid, jsonb) to service_role;

create or replace function public.claim_abandoned_plan_drawing_copies(p_limit integer default 25)
returns table(org_id uuid,project_id uuid,attempt_id uuid,storage_path text)
language plpgsql set search_path=public,pg_catalog as $$
declare v_project public.projects%rowtype; v_state jsonb; v_attempt jsonb; v_seq bigint;
begin
  if current_user in ('anon','authenticated') then raise exception 'Drawing copy cleanup requires service role' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>500 then raise exception 'Invalid drawing copy cleanup limit'; end if;
  for v_project in
    select p.* from public.projects p
    where p.metadata->'plan_instantiation'->'drawing_copy_attempt'->>'status' in ('reserved','abandoned')
      -- Old enough that no copy for it can still be in flight, and no release
      -- of this home is running that would resume it.
      and (p.metadata->'plan_instantiation'->'drawing_copy_attempt'->>'status'='abandoned'
        or coalesce((p.metadata->'plan_instantiation'->'drawing_copy_attempt'->>'reserved_at')::timestamptz,'-infinity')
          <=clock_timestamp()-interval '1 day')
      and not (p.metadata->'plan_instantiation'->'drawing_copy_attempt'->>'status'='reserved'
        and exists(select 1 from public.start_packages s join public.outbox o
          on o.org_id=s.org_id and o.job_type='start_release' and o.payload->>'start_package_id'=s.id::text
          where s.org_id=p.org_id and s.project_id=p.id and o.status='processing'
            and o.start_job_lease_expires_at>clock_timestamp()))
      -- A file naming the path means the copy was published; that is a
      -- manifest to repair, never an object to delete.
      and not exists(select 1 from public.files f where f.org_id=p.org_id
        and f.storage_path=p.metadata->'plan_instantiation'->'drawing_copy_attempt'->>'storage_path')
      -- Only a path this home's own reservation could have built is ever handed
      -- to the storage delete.
      and public.plan_drawing_copy_path_is_canonical(p.org_id,p.id,p.metadata->'plan_instantiation'->'drawing_copy_attempt')
    order by coalesce((p.metadata->'plan_instantiation'->'drawing_copy_attempt'->>'reserved_at')::timestamptz,'-infinity'),p.org_id,p.id
    limit p_limit for update skip locked
  loop
    v_state:=v_project.metadata->'plan_instantiation';
    v_attempt:=v_state->'drawing_copy_attempt';
    if v_attempt->>'status'='reserved' then
      v_seq:=coalesce((v_state->>'seq')::bigint,0);
      update public.projects set metadata=metadata||jsonb_build_object('plan_instantiation',v_state||jsonb_build_object('seq',v_seq+1,
        'drawing_copy_attempt',v_attempt||jsonb_build_object('status','abandoned','abandoned_at',clock_timestamp())))
        where projects.org_id=v_project.org_id and projects.id=v_project.id;
      insert into public.audit_log(org_id,action,entity_type,entity_id,before_data,after_data,source)
        values(v_project.org_id,'update','project',v_project.id,jsonb_build_object('drawing_copy_attempt',v_attempt),
          jsonb_build_object('drawing_copy_attempt',v_attempt||jsonb_build_object('status','abandoned')),'plan_drawing_copy.abandoned');
      insert into public.outbox(org_id,job_type,payload)
        values(v_project.org_id,'reindex_search',jsonb_build_object('entity_type','project','entity_id',v_project.id));
    end if;
    org_id:=v_project.org_id; project_id:=v_project.id;
    attempt_id:=(v_attempt->>'attempt_id')::uuid; storage_path:=v_attempt->>'storage_path';
    return next;
  end loop;
end $$;

create or replace function public.clear_abandoned_plan_drawing_copy(p_org_id uuid,p_project_id uuid,p_attempt_id uuid)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare v_metadata jsonb; v_state jsonb; v_attempt jsonb;
begin
  if current_user in ('anon','authenticated') then raise exception 'Drawing copy cleanup requires service role' using errcode='42501'; end if;
  select metadata into v_metadata from public.projects where org_id=p_org_id and id=p_project_id for update;
  if not found then return false; end if;
  v_state:=v_metadata->'plan_instantiation'; v_attempt:=v_state->'drawing_copy_attempt';
  if v_attempt->>'status' is distinct from 'abandoned' or v_attempt->>'attempt_id' is distinct from p_attempt_id::text then return false; end if;
  if not public.plan_drawing_copy_path_is_canonical(p_org_id,p_project_id,v_attempt) then
    raise exception 'Abandoned drawing copy does not name its own reserved path; repair its manifest instead' using errcode='42501'; end if;
  if exists(select 1 from public.files where org_id=p_org_id and storage_path=v_attempt->>'storage_path') then
    raise exception 'Abandoned drawing copy is referenced by a file; repair its manifest instead' using errcode='42501'; end if;
  update public.projects set metadata=metadata||jsonb_build_object('plan_instantiation',(v_state-'drawing_copy_attempt')
    ||jsonb_build_object('seq',coalesce((v_state->>'seq')::bigint,0)+1)) where org_id=p_org_id and id=p_project_id;
  insert into public.audit_log(org_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,'update','project',p_project_id,jsonb_build_object('drawing_copy_attempt',v_attempt),
      jsonb_build_object('drawing_copy_attempt',null),'plan_drawing_copy.cleared');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','project','entity_id',p_project_id));
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Drawing child jobs and lease columns.
-- ---------------------------------------------------------------------------

create function public.guard_drawing_job_browser_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_types constant text[] := array['process_drawing_set','split_drawing_chunk','process_drawing_page','enrich_drawing_metadata',
    'generate_drawing_tiles','backfill_drawing_page_text','extract_drawing_vectors','detect_drawing_changes'];
begin
  if current_user in ('anon', 'authenticated') and (
    (tg_op <> 'DELETE' and (new.job_type = any(v_types) or new.drawing_claim_token is not null
      or new.drawing_lease_expires_at is not null or new.start_job_lease_expires_at is not null))
    or (tg_op <> 'INSERT' and (old.job_type = any(v_types) or old.drawing_claim_token is not null
      or old.drawing_lease_expires_at is not null or old.start_job_lease_expires_at is not null))
  ) then
    raise exception 'Drawing jobs require authorized server writers' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger drawing_job_browser_write_guard
  before insert or update or delete on public.outbox
  for each row execute function public.guard_drawing_job_browser_writes();

revoke all on function public.guard_drawing_job_browser_writes() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Schema-readiness marker.
-- ---------------------------------------------------------------------------

create function public.starts_cutover_ready()
returns boolean
language sql
immutable
set search_path = ''
as $$ select true $$;

revoke all on function public.starts_cutover_ready() from public, anon, authenticated;
grant execute on function public.starts_cutover_ready() to service_role;

-- Abandoned plan-drawing copies are cleaned up without ever deleting a
-- referenced object.
--
-- Plan instantiation reserves a drawing copy (a manifest on the home's
-- instantiation ledger naming an attempt-unique storage path), copies the plan
-- PDF there, then publishes the file, set, revision and processing job in one
-- transaction. A worker lost between the reservation and the publication
-- leaves a reserved manifest, possibly an orphaned object, and a home whose
-- drawing-copy rollout flag cannot be turned off.
--
-- Cleanup is two transactions around the storage delete:
--   1. claim_abandoned_plan_drawing_copies marks reservations at least a day
--      old, with no live release claim on the home and no file row naming
--      their path, as `abandoned`. Reservation and publication both refuse an
--      abandoned manifest, so nothing can start using that path again.
--   2. After the object is deleted, clear_abandoned_plan_drawing_copy removes
--      the manifest — re-checking, under the home lock, that no file row
--      references the path.
-- A crash between them leaves an `abandoned` manifest that the next sweep
-- claims again; deleting a missing object is a no-op.
--
-- Requires 20261003048000_starts_release_and_purchasing_fences (the
-- reservation and publication functions and their manifest).

create index projects_reserved_plan_drawing_copy_idx on public.projects(org_id,id)
  where metadata->'plan_instantiation'->'drawing_copy_attempt'->>'status' in ('reserved','abandoned');

create function public.claim_abandoned_plan_drawing_copies(p_limit integer default 25)
returns table(org_id uuid,project_id uuid,attempt_id uuid,storage_path text)
language plpgsql set search_path=public,pg_catalog as $$
declare v_project public.projects%rowtype; v_state jsonb; v_attempt jsonb; v_seq bigint;
begin
  if current_user in ('anon','authenticated') then raise exception 'Drawing copy cleanup requires service role' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>500 then raise exception 'Invalid drawing copy cleanup limit'; end if;
  for v_project in
    select p.* from public.projects p
    where p.metadata->'plan_instantiation'->'drawing_copy_attempt'->>'status' in ('reserved','abandoned')
    order by p.org_id,p.id limit p_limit for update skip locked
  loop
    v_state:=v_project.metadata->'plan_instantiation';
    v_attempt:=v_state->'drawing_copy_attempt';
    if v_attempt->>'status'='reserved' then
      -- Old enough that no copy for it can still be in flight, and no release
      -- of this home is running that would resume it.
      continue when coalesce((v_attempt->>'reserved_at')::timestamptz,'-infinity')>clock_timestamp()-interval '1 day';
      continue when exists(select 1 from public.start_packages s join public.outbox o
        on o.org_id=s.org_id and o.job_type='start_release' and o.payload->>'start_package_id'=s.id::text
        where s.org_id=v_project.org_id and s.project_id=v_project.id and o.status='processing'
          and o.start_job_lease_expires_at>clock_timestamp());
      -- A file naming the path means the copy was published; that is a
      -- manifest to repair, never an object to delete.
      continue when exists(select 1 from public.files f where f.org_id=v_project.org_id and f.storage_path=v_attempt->>'storage_path');
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
revoke all on function public.claim_abandoned_plan_drawing_copies(integer) from public,anon,authenticated;
grant execute on function public.claim_abandoned_plan_drawing_copies(integer) to service_role;

create function public.clear_abandoned_plan_drawing_copy(p_org_id uuid,p_project_id uuid,p_attempt_id uuid)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare v_metadata jsonb; v_state jsonb; v_attempt jsonb;
begin
  if current_user in ('anon','authenticated') then raise exception 'Drawing copy cleanup requires service role' using errcode='42501'; end if;
  select metadata into v_metadata from public.projects where org_id=p_org_id and id=p_project_id for update;
  if not found then return false; end if;
  v_state:=v_metadata->'plan_instantiation'; v_attempt:=v_state->'drawing_copy_attempt';
  if v_attempt->>'status' is distinct from 'abandoned' or v_attempt->>'attempt_id' is distinct from p_attempt_id::text then return false; end if;
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
revoke all on function public.clear_abandoned_plan_drawing_copy(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.clear_abandoned_plan_drawing_copy(uuid,uuid,uuid) to service_role;

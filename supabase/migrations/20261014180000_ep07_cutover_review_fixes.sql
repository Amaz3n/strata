-- EP07 cutover review fixes.
--
-- 1. The whole instantiation ledger (projects.metadata->plan_instantiation) is
--    server-owned, not only the drawing-copy manifest. A member could write
--    `steps`, `produced`, `version_id` or `seq` through the data API: the
--    release then skipped the forged steps and a forged `seq` wedged the
--    drawing reservation. The interactive instantiation now writes the ledger
--    with the service client after its permission check.
-- 2. A published drawing-copy manifest no longer pins its release forever:
--    reserving for another actor, plan version or source file supersedes it
--    (the receipt stays in the audit trail).
-- 3. The abandoned-copy sweep leaves a reservation alone while the home has a
--    package that is releasing or parked in attention: a person is about to
--    retry it.
-- 4. starts_cutover_ready() now proves the chain, not one file: it is true only
--    when an object from each EP07 migration exists. The worker stays inert
--    until the whole set has landed, whatever order it arrived in.
--
-- Requires 20261014140000_starts_cutover_guards and the migrations it checks.

create or replace function public.guard_plan_drawing_copy_manifest_browser_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
    (tg_op = 'INSERT' and new.metadata->'plan_instantiation' is not null)
    or (tg_op = 'UPDATE' and new.metadata->'plan_instantiation' is distinct from old.metadata->'plan_instantiation')
  ) then
    raise exception 'Drawing copy state is server-owned' using errcode = '42501';
  end if;
  return new;
end
$$;

create or replace function public.reserve_plan_drawing_copy(p_org_id uuid,p_project_id uuid,p_plan_version_id uuid,p_actor_id uuid,p_source_evidence jsonb)
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
 -- A published copy belongs to the release that made it. Another actor, plan
 -- version or source file means a new release of the home: the old receipt is
 -- kept in the audit trail and the manifest is free for a new reservation.
 if jsonb_typeof(v_attempt)='object' and v_attempt->>'status'='published' and (v_attempt->>'plan_version_id' is distinct from p_plan_version_id::text
   or v_attempt->>'source_file_id' is distinct from v_source.id::text or v_attempt->>'actor_id' is distinct from p_actor_id::text) then
   insert into public.audit_log(org_id,action,entity_type,entity_id,before_data,after_data,source)
     values(p_org_id,'update','project',p_project_id,jsonb_build_object('drawing_copy_attempt',v_attempt),jsonb_build_object('drawing_copy_attempt',null),'plan_drawing_copy.superseded');
   v_state:=v_state-'drawing_copy_attempt'; v_attempt:=null;
 end if;
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
      -- A package waiting on a person is about to retry; its reservation is not abandoned.
      and not (p.metadata->'plan_instantiation'->'drawing_copy_attempt'->>'status'='reserved'
        and exists(select 1 from public.start_packages s where s.org_id=p.org_id and s.project_id=p.id and s.status in ('releasing','attention')))
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


-- ---------------------------------------------------------------------------
-- Schema marker: one object from each EP07 migration.
-- ---------------------------------------------------------------------------

create or replace function public.starts_cutover_ready()
returns boolean
language sql
stable
set search_path = ''
as $$
  -- Fails closed: every EP07 migration must show its object, and a check that
  -- cannot be evaluated (a missing function has no definition) answers false.
  select coalesce(
        to_regclass('public.release_throughput_targets') is not null            -- 20261014100000
    and to_regclass('public.trade_notice_deliveries') is not null               -- 20261014110000
    and to_regclass('public.trade_work_responses') is not null                  -- 20261014120000
    and to_regprocedure('public.settle_release_step(uuid,bigint,uuid,text,jsonb,integer,uuid)') is not null -- 20261014130000
    and to_regproc('public.guard_plan_drawing_copy_manifest_browser_writes') is not null -- 20261014140000
    and exists (select 1 from pg_trigger where tgname = 'start_packages_financing_flip' and not tgisinternal) -- 20261014150000
    and exists (select 1 from pg_trigger where tgname = 'schedule_assignments_consistency' and not tgisinternal) -- 20261014160000
    -- 20261014165000 replaced the look-ahead workspace without its whole-org raise
    and strpos(pg_get_functiondef(to_regprocedure('public.read_trade_lookahead_workspace(uuid,uuid,integer,uuid,uuid,text,integer,text,integer)')),
      'another home or organization') = 0
    and to_regproc('public.guard_release_key_browser_writes') is not null       -- 20261014170000
    and strpos(pg_get_functiondef(to_regproc('public.guard_plan_drawing_copy_manifest_browser_writes')),
      'new.metadata->''plan_instantiation'' is distinct') > 0, false)           -- 20261014180000 (the whole-ledger guard)
$$;

revoke all on function public.starts_cutover_ready() from public, anon, authenticated;
grant execute on function public.starts_cutover_ready() to service_role;

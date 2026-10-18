-- EP07 review round 1 fixes for starts capacity and throughput (EP07-01, 02, 03).
--
-- 1. A house counts against its superintendent from the day it is assigned:
--    every status but completed and cancelled, not just 'active' (a start house
--    is 'planning' until it releases).
-- 2. Packages in 'attention' (a release that failed and may be retried) still hold
--    their start slot in the community, division and org counts, so a retry can
--    never put a week over target unseen.
-- 3. The release re-checks, at queue time, that every attested gate's evidence file
--    is still on the home, before any step builds on it.
-- 4. assign_project_superintendent checks the actor's division reach over the house
--    inside its transaction.
-- 5. Flipping is_financed on an open or ready package reopens its financing gate,
--    so a cash-cleared package cannot queue as financed before the next refresh.
-- No new permission key. queue_start_release and assign_project_superintendent are
-- replaced (same signatures).

create or replace function public.superintendent_active_houses(p_org_id uuid, p_user_id uuid, p_excluding_project uuid default null)
returns integer
language sql
stable
set search_path = public, pg_catalog
as $$
  select count(*)::integer
  from public.projects p
  where p.org_id = p_org_id and p.superintendent_id = p_user_id and p.status not in ('completed', 'cancelled')
    and p.id is distinct from p_excluding_project;
$$;

-- Whether the actor's division scope reaches a division: an unscoped member or an
-- org admin always does; a division-limited one only the divisions they are in.
create or replace function public.starts_actor_reaches_division(p_org_id uuid, p_actor_id uuid, p_division_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_catalog
as $$
  select coalesce(bool_or(
    m.division_scope <> 'assigned'
    or exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key in ('org.admin', '*'))
    or (p_division_id is not null and exists (
      select 1 from public.membership_divisions md where md.membership_id = m.id and md.division_id = p_division_id))
  ), false)
  from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_actor_id and m.status = 'active';
$$;

revoke all on function public.starts_actor_reaches_division(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.starts_actor_reaches_division(uuid, uuid, uuid) to service_role;

create or replace function public.assign_project_superintendent(
  p_org_id uuid, p_project_id uuid, p_user_id uuid, p_actor_id uuid, p_over_reason text default null
)
returns jsonb
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_project public.projects%rowtype;
  v_field uuid;
  v_warn integer;
  v_max integer;
  v_houses integer := 0;
  v_over boolean := false;
  v_reason text := nullif(btrim(coalesce(p_over_reason, '')), '');
  v_can_override boolean;
  v_after jsonb;
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'Superintendent assignment requires an authorized server action' using errcode = '42501';
  end if;
  if p_org_id is null or p_project_id is null or p_actor_id is null then
    raise exception 'Invalid superintendent assignment';
  end if;
  if not (public.starts_actor_holds(p_org_id, p_actor_id, 'project.manage') or public.starts_actor_holds(p_org_id, p_actor_id, 'start.write')) then
    raise exception 'Assigning a superintendent needs project.manage or start.write' using errcode = '42501';
  end if;
  v_can_override := public.starts_actor_holds(p_org_id, p_actor_id, 'start.release');
  -- Everything that counts or changes one person's houses waits on this lock,
  -- taken before the project row so two assignments to the same person queue.
  if p_user_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('superintendent:' || p_org_id || ':' || p_user_id, 0));
    if not exists (select 1 from public.memberships where org_id = p_org_id and user_id = p_user_id and status = 'active') then
      raise exception 'Superintendent must be an active organization member.' using errcode = '42501';
    end if;
  end if;
  select * into v_project from public.projects where org_id = p_org_id and id = p_project_id for update;
  if not found then
    raise exception 'Project not found' using errcode = '42501';
  end if;
  if not public.starts_actor_reaches_division(p_org_id, p_actor_id, v_project.division_id) then
    raise exception 'The house is outside your division access' using errcode = '42501';
  end if;

  if p_user_id is not null and p_user_id is distinct from v_project.superintendent_id then
    select l.warn_houses, l.max_houses into v_warn, v_max from public.superintendent_house_limits(p_org_id, p_user_id) l;
    v_houses := public.superintendent_active_houses(p_org_id, p_user_id, p_project_id);
    if v_houses + 1 > v_max then
      if v_reason is null then
        return jsonb_build_object('assigned', false, 'requires_override', true, 'can_override', v_can_override,
          'houses', v_houses, 'warn', v_warn, 'limit', v_max);
      end if;
      if not v_can_override then
        raise exception 'Assigning past a superintendent''s limit needs start.release' using errcode = '42501';
      end if;
      if length(v_reason) < 10 then
        raise exception 'Assigning past a superintendent''s limit needs a reason of at least 10 characters.' using errcode = '22023';
      end if;
      v_over := true;
    end if;
  end if;

  select id into v_field from public.roles where key = 'field' and scope = 'project';
  if v_field is null then
    raise exception 'Field project role is missing.';
  end if;

  if v_project.superintendent_id is distinct from p_user_id then
    update public.projects set superintendent_id = p_user_id where org_id = p_org_id and id = p_project_id;
    -- The outgoing superintendent loses only the scoping row this function gave them.
    if v_project.superintendent_id is not null then
      delete from public.project_members
      where org_id = p_org_id and project_id = p_project_id and user_id = v_project.superintendent_id and role_id = v_field;
    end if;
  end if;
  if p_user_id is not null then
    insert into public.project_members (org_id, project_id, user_id, role_id, status)
    values (p_org_id, p_project_id, p_user_id, v_field, 'active')
    on conflict (project_id, user_id) do update set status = 'active';
  end if;

  if v_project.superintendent_id is distinct from p_user_id then
    v_after := jsonb_build_object('previous_user_id', v_project.superintendent_id, 'user_id', p_user_id, 'actor_id', p_actor_id,
      'houses', case when p_user_id is null then null else v_houses + 1 end, 'warn', v_warn, 'limit', v_max,
      'over_capacity', v_over, 'reason', case when v_over then v_reason end);
    insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
      values (p_org_id, p_actor_id, 'update', 'project', p_project_id,
        jsonb_build_object('superintendent_id', v_project.superintendent_id), v_after, 'starts.superintendent_assigned');
    insert into public.events (org_id, event_type, entity_type, entity_id, payload, channel)
      values (p_org_id, 'project.superintendent_changed', 'project', p_project_id, v_after, 'activity');
    insert into public.outbox (org_id, job_type, payload)
      values (p_org_id, 'reindex_search', jsonb_build_object('entity_type', 'project', 'entity_id', p_project_id));
  end if;

  return jsonb_build_object('assigned', true, 'changed', v_project.superintendent_id is distinct from p_user_id,
    'previous_user_id', v_project.superintendent_id, 'user_id', p_user_id,
    'houses', case when p_user_id is null then null else v_houses + 1 end, 'warn', v_warn, 'limit', v_max, 'over_capacity', v_over);
end;
$$;

revoke all on function public.assign_project_superintendent(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.assign_project_superintendent(uuid, uuid, uuid, uuid, text) to service_role;

create or replace function public.queue_start_release(p_org_id uuid, p_package_id uuid, p_actor_id uuid, p_scheduled_start_date date,
  p_target_week date, p_slot_target integer, p_confirm_over_slot boolean, p_over_reason text default null)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_others integer; v_job_id bigint;
  v_now timestamptz:=clock_timestamp(); v_after jsonb;
  v_super uuid; v_division uuid; v_target integer; v_exceeded jsonb:='[]'::jsonb; v_first jsonb;
  v_reason text:=nullif(btrim(coalesce(p_over_reason,'')),''); v_over boolean;
begin
  if p_scheduled_start_date is null or p_target_week is null or p_slot_target is null or p_slot_target<0
    or p_confirm_over_slot is null then raise exception 'Invalid starts release request'; end if;
  v_pkg:=public.lock_starts_release_control(p_org_id,p_package_id,p_actor_id);
  if v_pkg.status is distinct from 'ready' then raise exception 'The start package is not ready to release.' using errcode='40001'; end if;
  if v_pkg.project_id is null then raise exception 'The start package has no home to release.' using errcode='42501'; end if;
  select superintendent_id into v_super from public.projects where org_id=p_org_id and id=v_pkg.project_id for share;
  if v_super is null then raise exception 'Assign a superintendent to this house before releasing it.' using errcode='40001'; end if;
  if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=v_super and status='active') then
    raise exception 'This house''s superintendent is no longer an active member. Assign another before releasing it.' using errcode='40001'; end if;
  if exists(select 1 from public.start_package_gates g join public.start_gate_definitions d on d.id=g.gate_definition_id and d.org_id=g.org_id
      where g.org_id=p_org_id and g.start_package_id=p_package_id and d.auto_source='permit_approved')
    and not public.start_gate_sql_evidence(p_org_id,p_package_id,'permit_approved') then
    raise exception 'The permit gate is no longer satisfied: the home''s permit changed. Refresh the package.' using errcode='40001'; end if;
  -- An attestation stands on its file: one archived or moved off the home since the gate
  -- cleared is caught here, before any release step has built anything on it.
  if exists(select 1 from public.start_package_gates g where g.org_id=p_org_id and g.start_package_id=p_package_id
      and g.status='passed' and g.passed_via='attested' and g.evidence_file_id is not null
      and not exists(select 1 from public.files f where f.id=g.evidence_file_id and f.org_id=p_org_id
        and f.project_id=v_pkg.project_id and f.archived_at is null)) then
    raise exception 'A gate''s evidence file is no longer on the home. Refresh the package.' using errcode='40001'; end if;
  if exists(select 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text and status in ('pending','processing')) then
    raise exception 'This start package is already being released.' using errcode='40001'; end if;

  perform pg_advisory_xact_lock(hashtextextended('start_release_week:'||p_org_id||':'||v_pkg.community_id||':'||p_target_week,0));
  select division_id into v_division from public.communities where org_id=p_org_id and id=v_pkg.community_id;
  if v_division is not null then
    perform pg_advisory_xact_lock(hashtextextended('start_release_throughput:'||p_org_id||':'||v_division||':'||p_target_week,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('start_release_throughput:'||p_org_id||':org:'||p_target_week,0));

  select count(*) into v_others from public.start_packages where org_id=p_org_id and community_id=v_pkg.community_id
    and target_week=p_target_week and status in ('releasing','released','attention') and id<>p_package_id;
  if v_others+1>p_slot_target then
    v_exceeded:=v_exceeded||jsonb_build_array(jsonb_build_object('limit','community','target',p_slot_target,'already_targeted',v_others));
  end if;
  if v_division is not null then
    select target_starts into v_target from public.release_throughput_targets
      where org_id=p_org_id and division_id=v_division and week_start=p_target_week;
    if found then
      select count(*) into v_others from public.start_packages sp join public.communities c on c.id=sp.community_id and c.org_id=sp.org_id
        where sp.org_id=p_org_id and c.division_id=v_division and sp.target_week=p_target_week
        and sp.status in ('releasing','released','attention') and sp.id<>p_package_id;
      if v_others+1>v_target then
        v_exceeded:=v_exceeded||jsonb_build_array(jsonb_build_object('limit','division','target',v_target,'already_targeted',v_others));
      end if;
    end if;
  end if;
  select target_starts into v_target from public.release_throughput_targets
    where org_id=p_org_id and division_id is null and week_start=p_target_week;
  if found then
    select count(*) into v_others from public.start_packages where org_id=p_org_id and target_week=p_target_week
      and status in ('releasing','released','attention') and id<>p_package_id;
    if v_others+1>v_target then
      v_exceeded:=v_exceeded||jsonb_build_array(jsonb_build_object('limit','org','target',v_target,'already_targeted',v_others));
    end if;
  end if;

  v_over:=jsonb_array_length(v_exceeded)>0;
  if v_over then
    v_first:=v_exceeded->0;
    if not p_confirm_over_slot then
      return jsonb_build_object('queued',false,'target_week',p_target_week,'target',(v_first->>'target')::integer,
        'already_targeted',(v_first->>'already_targeted')::integer,'limit',v_first->>'limit','exceeded',v_exceeded);
    end if;
    if v_reason is null or length(v_reason)<10 then
      raise exception 'Releasing over a start target needs a reason of at least 10 characters.' using errcode='22023'; end if;
  end if;
  update public.start_packages set status='releasing',scheduled_start_date=p_scheduled_start_date,target_week=p_target_week,
    released_by=p_actor_id,
    metadata=coalesce(metadata,'{}')||jsonb_build_object('release_requested_at',v_now,'release_lease_token',null,'release_lease_at',null)
    where org_id=p_org_id and id=p_package_id;
  insert into public.start_release_steps(org_id,start_package_id,step_key,status,completed_at,started_at,error)
    select p_org_id,p_package_id,step,case when step='project' then 'completed' else 'pending' end,
      case when step='project' then v_now end,null,null
    from unnest(array['project','budget','schedule','checklists','drawings','pos','notify_trades','finalize']) step
  on conflict (start_package_id,step_key) do update set status=excluded.status,completed_at=excluded.completed_at,started_at=null,error=null
    where public.start_release_steps.status not in ('completed','skipped');
  insert into public.outbox(org_id,job_type,payload,run_at,dedupe_key)
    values(p_org_id,'start_release',jsonb_build_object('start_package_id',p_package_id,'actor_id',p_actor_id),v_now,
      'start_release:start_package_id:'||p_package_id)
    returning id into v_job_id;
  v_after:=jsonb_build_object('status','releasing','scheduled_start_date',p_scheduled_start_date,'target_week',p_target_week,
    'job_id',v_job_id::text,'target',p_slot_target,'over_slot',v_over,'actor_id',p_actor_id,
    'exceeded',v_exceeded,'over_reason',case when v_over then v_reason end);
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,
      jsonb_build_object('status',v_pkg.status,'scheduled_start_date',v_pkg.scheduled_start_date,'target_week',v_pkg.target_week),
      v_after,'starts.release_queued');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,case when v_over then 'start.released_over_slot' else 'start.release_queued' end,'start_package',p_package_id,v_after,'activity');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  return jsonb_build_object('queued',true,'job_id',v_job_id::text,'over_slot',v_over,'target_week',p_target_week,'exceeded',v_exceeded);
end $$;
revoke all on function public.queue_start_release(uuid,uuid,uuid,date,date,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.queue_start_release(uuid,uuid,uuid,date,date,integer,boolean,text) to service_role;

create or replace function public.tg_start_package_financing_flip()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.is_financed is distinct from old.is_financed and new.status in ('open', 'ready') then
    update public.start_package_gates g set status = 'pending', passed_via = null
    from public.start_gate_definitions d
    where d.id = g.gate_definition_id and d.org_id = g.org_id and g.org_id = new.org_id and g.start_package_id = new.id
      and d.auto_source = 'agreement_milestones_clear' and g.status = 'passed';
  end if;
  return null;
end;
$$;

revoke all on function public.tg_start_package_financing_flip() from public, anon, authenticated;

drop trigger if exists start_packages_financing_flip on public.start_packages;
create trigger start_packages_financing_flip
  after update of is_financed on public.start_packages
  for each row execute function public.tg_start_package_financing_flip();

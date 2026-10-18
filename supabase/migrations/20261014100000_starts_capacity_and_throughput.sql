-- EP07-01, EP07-02, EP07-03: evidence-backed financing, cross-community
-- throughput, and superintendent capacity.
--
-- 1. A cash agreement carries a start-holding "proof of funds" milestone, so the
--    financing gate has a record to read for a cash buyer the way it has the
--    lender's loan approval for a financed one.
-- 2. Division and org throughput targets, enforced in the release transaction
--    under a second advisory lock, over target only with a reason.
-- 3. Per-superintendent house limits (warn 10 / block 15 by default, org
--    default row and per-person rows), one atomic assignment function that
--    enforces them, and a release that refuses a house with no superintendent.
-- 4. The two tables any org member could write straight through the data API --
--    community_release_slots and projects.superintendent_id -- are locked to the
--    server paths that check permission and write the audit.
--
-- RBAC: no new key. Throughput targets reuse start.slots (org_owner, org_admin,
-- org_starts_coordinator hold it); superintendent limits, the over-limit
-- assignment and the over-target release are start.release (the same three).
-- Assigning a superintendent stays project.manage, and start.write now also
-- allows it.
--
-- queue_start_release is replaced, not edited: its signature gains the reason an
-- over-target release must carry, so the old one is dropped.

-- ---------------------------------------------------------------------------
-- 1. Proof of funds for a cash buyer.
-- ---------------------------------------------------------------------------

create or replace function public.seed_proof_of_funds_milestone(p_contract_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
  v_inserted integer;
begin
  select * into v_contract from public.contracts c where c.id = p_contract_id;
  if not found or v_contract.contract_type <> 'purchase_agreement' or v_contract.status <> 'active'
     or coalesce(v_contract.snapshot -> 'purchase_agreement' ->> 'financing', 'financed') <> 'cash' then
    return 0;
  end if;
  insert into public.agreement_milestones (
    org_id, contract_id, project_id, template_key, kind, title, is_contingency, source, required_before,
    due_on, evidence_required, sort_order
  ) values (
    v_contract.org_id, v_contract.id, v_contract.project_id, 'buyer:proof_of_funds', 'financing',
    'Proof of funds on file', false, 'agreement', 'start', null, true, 5
  )
  on conflict (contract_id, template_key) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function public.seed_proof_of_funds_milestone(uuid) from public, anon, authenticated;
grant execute on function public.seed_proof_of_funds_milestone(uuid) to service_role;

create or replace function public.tg_contract_seed_proof_of_funds()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.contract_type = 'purchase_agreement' and new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    perform public.seed_proof_of_funds_milestone(new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.tg_contract_seed_proof_of_funds() from public, anon, authenticated;

drop trigger if exists contracts_seed_proof_of_funds on public.contracts;
create trigger contracts_seed_proof_of_funds
  after insert or update of status on public.contracts
  for each row execute function public.tg_contract_seed_proof_of_funds();

-- Agreements already in force: a cash buyer's start was never gated on funds.
do $$
declare
  v_contract uuid;
begin
  for v_contract in
    select c.id from public.contracts c where c.contract_type = 'purchase_agreement' and c.status = 'active'
  loop
    perform public.seed_proof_of_funds_milestone(v_contract);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Throughput targets, division and org wide.
-- ---------------------------------------------------------------------------

create table public.release_throughput_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- Null is the organization-wide target.
  division_id uuid references public.divisions(id) on delete cascade,
  division_key uuid generated always as (coalesce(division_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  week_start date not null check (extract(isodow from week_start) = 1),
  target_starts integer not null check (target_starts between 0 and 500),
  notes text check (notes is null or length(notes) <= 1000),
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, division_key, week_start)
);

create index release_throughput_targets_week_idx on public.release_throughput_targets (org_id, week_start);
create index release_throughput_targets_division_idx on public.release_throughput_targets (division_id) where division_id is not null;
create index release_throughput_targets_updated_by_idx on public.release_throughput_targets (updated_by) where updated_by is not null;

create trigger release_throughput_targets_set_updated_at
  before update on public.release_throughput_targets
  for each row execute function public.tg_set_updated_at();

alter table public.release_throughput_targets enable row level security;

create policy release_throughput_targets_read on public.release_throughput_targets
  for select to authenticated
  using (public.has_org_permission(org_id, 'start.read'));

-- A division-limited member reads the targets of the divisions they reach, and
-- the org-wide row (a division_id of null).
create policy release_throughput_targets_division_scope on public.release_throughput_targets
  as restrictive for all to authenticated
  using (
    division_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or division_id in (select public.member_reachable_division_ids())
  )
  with check (
    division_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or division_id in (select public.member_reachable_division_ids())
  );

revoke all on table public.release_throughput_targets from anon, authenticated;
grant select on table public.release_throughput_targets to authenticated;
grant all on table public.release_throughput_targets to service_role;

-- ---------------------------------------------------------------------------
-- 3. Superintendent capacity.
-- ---------------------------------------------------------------------------

create table public.superintendent_capacity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- Null is the organization default every superintendent without a row follows.
  user_id uuid references public.app_users(id) on delete cascade,
  user_key uuid generated always as (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  warn_houses integer not null check (warn_houses between 1 and 100),
  max_houses integer not null check (max_houses between 1 and 100),
  notes text check (notes is null or length(notes) <= 1000),
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_key),
  check (warn_houses <= max_houses)
);

create index superintendent_capacity_user_idx on public.superintendent_capacity (user_id) where user_id is not null;
create index superintendent_capacity_updated_by_idx on public.superintendent_capacity (updated_by) where updated_by is not null;

create trigger superintendent_capacity_set_updated_at
  before update on public.superintendent_capacity
  for each row execute function public.tg_set_updated_at();

alter table public.superintendent_capacity enable row level security;

create policy superintendent_capacity_read on public.superintendent_capacity
  for select to authenticated
  using (public.has_org_permission(org_id, 'start.read'));

revoke all on table public.superintendent_capacity from anon, authenticated;
grant select on table public.superintendent_capacity to authenticated;
grant all on table public.superintendent_capacity to service_role;

-- The warn and block limits that apply to one person: their own row, else the
-- org default row, else ten and fifteen.
create or replace function public.superintendent_house_limits(p_org_id uuid, p_user_id uuid)
returns table (warn_houses integer, max_houses integer)
language sql
stable
set search_path = public, pg_catalog
as $$
  select coalesce(u.warn_houses, o.warn_houses, 10), coalesce(u.max_houses, o.max_houses, 15)
  from (select 1) base
  left join public.superintendent_capacity u on u.org_id = p_org_id and u.user_id = p_user_id
  left join public.superintendent_capacity o on o.org_id = p_org_id and o.user_id is null;
$$;

revoke all on function public.superintendent_house_limits(uuid, uuid) from public, anon, authenticated;
grant execute on function public.superintendent_house_limits(uuid, uuid) to service_role;

-- Houses a person runs now. A house counts from the day it is assigned, not
-- from release: a superintendent is handed a house before it starts.
create or replace function public.superintendent_active_houses(p_org_id uuid, p_user_id uuid, p_excluding_project uuid default null)
returns integer
language sql
stable
set search_path = public, pg_catalog
as $$
  select count(*)::integer
  from public.projects p
  where p.org_id = p_org_id and p.superintendent_id = p_user_id and p.status = 'active'
    and p.id is distinct from p_excluding_project;
$$;

revoke all on function public.superintendent_active_houses(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.superintendent_active_houses(uuid, uuid, uuid) to service_role;

-- Whether a person holds a permission today: role grants and member grants,
-- minus member denies, with the wildcard counting. The server checks the same
-- rules before it calls; the transaction is what holds.
create or replace function public.starts_actor_holds(p_org_id uuid, p_actor_id uuid, p_permission text)
returns boolean
language sql
stable
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = p_org_id and m.user_id = p_actor_id and m.status = 'active'
      and (
        exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key in (p_permission, '*'))
        or exists (
          select 1 from public.membership_permission_overrides o
          where o.membership_id = m.id and o.effect = 'grant' and o.permission_key in (p_permission, '*')
        )
      )
      and not exists (
        select 1 from public.membership_permission_overrides o
        where o.membership_id = m.id and o.effect = 'deny' and o.permission_key = p_permission
      )
  );
$$;

revoke all on function public.starts_actor_holds(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.starts_actor_holds(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The data API cannot write what the services audit.
-- ---------------------------------------------------------------------------

drop policy if exists community_release_slots_org_access on public.community_release_slots;
create policy community_release_slots_read on public.community_release_slots
  for select to authenticated
  using (public.is_org_member(org_id));
revoke insert, update, delete on table public.community_release_slots from anon, authenticated;

create or replace function public.tg_projects_superintendent_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.superintendent_id is not null)
     or (tg_op = 'UPDATE' and new.superintendent_id is distinct from old.superintendent_id) then
    raise exception 'A superintendent is assigned through the house''s assignment, which checks capacity and is audited' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_superintendent_guard on public.projects;
create trigger projects_superintendent_guard
  before insert or update of superintendent_id on public.projects
  for each row execute function public.tg_projects_superintendent_guard();

-- ---------------------------------------------------------------------------
-- 5. Atomic superintendent assignment.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 6. Release: a superintendent, and every throughput limit, in one transaction.
-- ---------------------------------------------------------------------------

drop function if exists public.queue_start_release(uuid, uuid, uuid, date, date, integer, boolean);

-- Lock order is always the community's week, then the division's, then the
-- org's, so two releases into one division from different communities queue
-- instead of deadlocking. The permit is re-read here, as before: a permit
-- revised between the readiness refresh and the queue stops it before any
-- release step has run.
create function public.queue_start_release(p_org_id uuid, p_package_id uuid, p_actor_id uuid, p_scheduled_start_date date,
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
    and target_week=p_target_week and status in ('releasing','released') and id<>p_package_id;
  if v_others+1>p_slot_target then
    v_exceeded:=v_exceeded||jsonb_build_array(jsonb_build_object('limit','community','target',p_slot_target,'already_targeted',v_others));
  end if;
  if v_division is not null then
    select target_starts into v_target from public.release_throughput_targets
      where org_id=p_org_id and division_id=v_division and week_start=p_target_week;
    if found then
      select count(*) into v_others from public.start_packages sp join public.communities c on c.id=sp.community_id and c.org_id=sp.org_id
        where sp.org_id=p_org_id and c.division_id=v_division and sp.target_week=p_target_week
        and sp.status in ('releasing','released') and sp.id<>p_package_id;
      if v_others+1>v_target then
        v_exceeded:=v_exceeded||jsonb_build_array(jsonb_build_object('limit','division','target',v_target,'already_targeted',v_others));
      end if;
    end if;
  end if;
  select target_starts into v_target from public.release_throughput_targets
    where org_id=p_org_id and division_id is null and week_start=p_target_week;
  if found then
    select count(*) into v_others from public.start_packages where org_id=p_org_id and target_week=p_target_week
      and status in ('releasing','released') and id<>p_package_id;
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

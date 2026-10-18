-- Starts: a release resumes without rebuilding, a lot cannot be pulled out from
-- under a live package, a new gate reaches the packages already open, and the
-- selection tables answer to the release claim.
--
-- Requires 20261003048000_starts_release_and_purchasing_fences,
-- 20261010100000_starts_release_control, 20261010140000_starts_home_creation and
-- 20261011060000_starts_desk_mutations, and ships with them.
--
-- RBAC: no new permission key. Defining a gate stays start.release and
-- cancelling a package stays start.write; both are checked again here, in the
-- transaction that writes.
--
-- 1. Generated rows carry a release key. A release builds a house's budget,
--    schedule and checklists once: each generated row names its place in the
--    release ('budget', 'schedule:<n>', 'checklist:<n>') in metadata.release_key
--    and the key is unique per home. A crash, a cancel or a worker that lost its
--    lease can therefore re-run the step and only fill in what is missing.
-- 2. settle_release_step closes a step in one transaction: it re-proves the
--    claim, the package lease and the actor, counts what the step actually left
--    on the home against the count the handler promised, and only then writes
--    the project's instantiation ledger and the release ledger together. A step
--    that built nothing records 0 explicitly; a step that built less than it
--    promised cannot complete.
-- 3. A lot with a live package cannot be detached or moved: that left the
--    package unreachable (every starts function requires the lot to still
--    belong to the package's home and community). Cancelling a package heals
--    one already stranded, and a second cancel is a no-op.
-- 4. Gate definitions are saved in one transaction with their fan-out: a new or
--    reactivated gate is added to every open and ready package, and a ready
--    package that gains an unanswered gate returns to open. A definition written
--    around it through the data API is healed into each package the next time its
--    desk is read or it is released (heal_start_package_gates).
-- 5. Selection groups, choices and exceptions are fenced to the release claim
--    like every other generated artifact.

-- ==== 1. release keys ====
create unique index budgets_release_key_key on public.budgets (project_id, (metadata->>'release_key'))
  where metadata->>'release_key' is not null;
create unique index schedule_items_release_key_key on public.schedule_items (project_id, (metadata->>'release_key'))
  where metadata->>'release_key' is not null;
create unique index inspections_release_key_key on public.inspections (project_id, (metadata->>'release_key'))
  where metadata->>'release_key' is not null;

-- ==== 2. settle_release_step ====
-- Called on the plain service client, like publish_start_release: it fences
-- itself and writes the project ledger, which the claim fences do not allow a
-- worker to touch from the claim client.
create function public.settle_release_step(p_org_id uuid,p_job_id bigint,p_token uuid,p_step text,p_detail jsonb,
  p_expected_count integer,p_version_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_step public.start_release_steps%rowtype;
  v_budget public.budgets%rowtype; v_found integer; v_sum bigint; v_needs_receipt boolean; v_receipt jsonb;
  v_detail jsonb:=coalesce(p_detail,'{}'); v_meta jsonb; v_state jsonb; v_at timestamptz:=clock_timestamp();
begin
  if current_user in ('anon','authenticated') then raise exception 'Release steps settle through the starts worker only' using errcode='42501'; end if;
  if p_step is null or p_step not in ('project','budget','schedule','checklists','drawings','pos','notify_trades','finalize')
    or jsonb_typeof(v_detail) is distinct from 'object' or (p_expected_count is not null and p_expected_count<0) then
    raise exception 'Invalid release step settlement'; end if;
  select * into v_job from public.outbox where id=p_job_id and org_id=p_org_id and job_type='start_release'
    and status='processing' and start_claim_token=p_token and start_job_lease_expires_at>clock_timestamp() for update;
  if not found then raise exception 'Starts worker lease lost' using errcode='40001'; end if;
  select * into v_pkg from public.start_packages where org_id=p_org_id and id=(v_job.payload->>'start_package_id')::uuid for update;
  if not found or v_pkg.status is distinct from 'releasing' then raise exception 'Start package no longer releasing' using errcode='40001'; end if;
  if v_pkg.metadata->>'release_lease_token' is distinct from p_token::text or v_pkg.metadata->>'release_lease_at' is null
    or (v_pkg.metadata->>'release_lease_at')::timestamptz<=clock_timestamp()-interval '5 minutes'
    then raise exception 'Start package lease lost' using errcode='40001'; end if;
  if v_pkg.project_id is null then raise exception 'Release package is missing its home' using errcode='42501'; end if;
  perform public.assert_starts_release_actor(v_job,v_pkg);
  select * into v_step from public.start_release_steps where org_id=p_org_id and start_package_id=v_pkg.id and step_key=p_step for update;
  if not found or v_step.status is distinct from 'running' then
    raise exception 'Release step % is not running',p_step using errcode='40001'; end if;

  -- A step the project ledger already recorded is a skip: it built nothing this
  -- time, so there is nothing to count. A budget delegated to purchasing built
  -- none either. Everything else must account for what it left on the home.
  v_needs_receipt:=p_step in ('budget','schedule','checklists')
    and coalesce((v_detail->>'already_instantiated')::boolean,false) is not true and v_detail->>'delegated_to' is null;
  if v_needs_receipt then
    if p_expected_count is null then
      raise exception 'Release step % cannot complete without a receipt',p_step using errcode='40001'; end if;
    if p_step='budget' then
      select * into v_budget from public.budgets where org_id=p_org_id and project_id=v_pkg.project_id and metadata->>'release_key'='budget';
      if not found then raise exception 'Release step budget left no budget on the home' using errcode='40001'; end if;
      select count(*)::integer,coalesce(sum(amount_cents),0) into v_found,v_sum from public.budget_lines where org_id=p_org_id and budget_id=v_budget.id;
      if v_sum is distinct from coalesce(v_budget.total_cents,0)::bigint then
        raise exception 'Release step budget receipt is incomplete: lines total % of %',v_sum,coalesce(v_budget.total_cents,0) using errcode='40001'; end if;
    elsif p_step='schedule' then
      select count(*)::integer into v_found from public.schedule_items where org_id=p_org_id and project_id=v_pkg.project_id
        and metadata->>'release_key' like 'schedule:%';
    else
      select count(*)::integer into v_found from public.inspections where org_id=p_org_id and project_id=v_pkg.project_id
        and metadata->>'release_key' like 'checklist:%';
      if exists(select 1 from public.inspections i where i.org_id=p_org_id and i.project_id=v_pkg.project_id
        and i.metadata->>'release_key' like 'checklist:%'
        and not exists(select 1 from public.inspection_items n where n.org_id=i.org_id and n.inspection_id=i.id)) then
        raise exception 'Release step checklists receipt is incomplete: a checklist has no items' using errcode='40001'; end if;
    end if;
    if v_found is distinct from p_expected_count then
      raise exception 'Release step % receipt is incomplete: % of % built',p_step,v_found,p_expected_count using errcode='40001'; end if;
    v_receipt:=jsonb_build_object('expected',p_expected_count,'found',v_found);
    v_detail:=v_detail||jsonb_build_object('receipt',v_receipt);
  end if;

  -- The project's instantiation ledger moves with the release ledger, never
  -- apart from it: a crash between the two used to leave a step marked in one
  -- and pending in the other.
  if p_step in ('budget','schedule','checklists','drawings') and p_version_id is not null
    and coalesce((v_detail->>'already_instantiated')::boolean,false) is not true and v_detail->>'delegated_to' is null then
    select metadata into v_meta from public.projects where org_id=p_org_id and id=v_pkg.project_id for update;
    if not found then raise exception 'Starts home not found in organization' using errcode='42501'; end if;
    v_state:=coalesce(v_meta->'plan_instantiation','{}');
    v_state:=v_state||jsonb_build_object(
      'version_id',p_version_id,
      'steps',case when v_state->>'version_id'=p_version_id::text then coalesce(v_state->'steps','{}') else '{}'::jsonb end
        ||jsonb_build_object(p_step,jsonb_build_object('at',v_at)),
      'produced',coalesce(v_state->'produced','{}')||jsonb_build_object(p_step,jsonb_build_object('at',v_at,'version_id',p_version_id)),
      'seq',coalesce((v_state->>'seq')::integer,0)+1,
      'at',v_at);
    update public.projects set metadata=jsonb_set(coalesce(metadata,'{}'),'{plan_instantiation}',v_state)
      where org_id=p_org_id and id=v_pkg.project_id;
  end if;
  update public.start_release_steps set status='completed',completed_at=v_at,error=null,detail=v_detail where id=v_step.id;
  return jsonb_build_object('step',p_step,'status','completed','receipt',v_receipt);
end $$;
revoke all on function public.settle_release_step(uuid,bigint,uuid,text,jsonb,integer,uuid) from public,anon,authenticated;
grant execute on function public.settle_release_step(uuid,bigint,uuid,text,jsonb,integer,uuid) to service_role;

-- ==== 3. a lot under a live package ====
create function public.guard_lot_active_start() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
begin
  if old.project_id is not null and (new.project_id is distinct from old.project_id or new.community_id is distinct from old.community_id)
    and exists(select 1 from public.start_packages p where p.org_id=old.org_id and p.lot_id=old.id
      and p.status in ('open','ready','releasing','attention')) then
    raise exception 'Cancel the start package before detaching or moving this lot.' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_lot_active_start() from public,anon,authenticated;
create trigger lots_active_start_guard before update of project_id,community_id on public.lots
  for each row execute function public.guard_lot_active_start();

-- The lock chain of lock_starts_desk_package, for withdrawing a package. A
-- package whose lot was detached or moved before the guard above (or by a path
-- that bypassed it) fails the ancestry check every starts function makes, so
-- nothing could cancel it and its lot could never open another. Cancelling is
-- the one repair: for a package still being assembled, or already cancelled, the
-- actor needs start.write and reach over the lot as it stands now.
create function public.lock_starts_cancellable_package(p_org_id uuid,p_package_id uuid,p_actor_id uuid)
returns public.start_packages language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_pkg public.start_packages%rowtype; v_check public.start_packages%rowtype; v_lot_project uuid; v_lot_community uuid;
begin
  if current_user in ('anon','authenticated') then
    raise exception 'Start packages require an authorized server action' using errcode='42501'; end if;
  if p_org_id is null or p_package_id is null or p_actor_id is null then raise exception 'Invalid start package request'; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is not null or v_headers->>'x-starts-claim-token' is not null then
    raise exception 'Start package desk writes cannot run inside a worker claim' using errcode='42501'; end if;
  perform 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text order by id for update;
  select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
  if not found then raise exception 'Start package not found' using errcode='42501'; end if;
  v_check:=v_pkg;
  if v_pkg.status in ('open','ready','attention','cancelled') then
    select project_id,community_id into v_lot_project,v_lot_community from public.lots where org_id=p_org_id and id=v_pkg.lot_id;
    if found then
      if v_lot_project is distinct from v_pkg.project_id then v_check.project_id:=null; end if;
      if v_lot_community is distinct from v_pkg.community_id then v_check.community_id:=v_lot_community; end if;
    end if;
  end if;
  perform public.assert_starts_desk_actor(v_check,p_actor_id,'start.write');
  return v_pkg;
end $$;
revoke all on function public.lock_starts_cancellable_package(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.lock_starts_cancellable_package(uuid,uuid,uuid) to service_role;

-- Withdraw a package that has not begun releasing. Its lot is free for a new
-- one. A package already withdrawn stays as it was, with its first reason, and
-- writes no second audit, event or reindex.
create or replace function public.cancel_start_package(p_org_id uuid,p_package_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_after public.start_packages%rowtype; v_reason text:=btrim(coalesce(p_reason,''));
begin
  if length(v_reason)<10 then raise exception 'Cancellation reason must be at least 10 characters.'; end if;
  v_pkg:=public.lock_starts_cancellable_package(p_org_id,p_package_id,p_actor_id);
  if v_pkg.status='cancelled' then return jsonb_build_object('status','cancelled','already_cancelled',true); end if;
  if v_pkg.status in ('releasing','released') then
    raise exception 'A releasing or released start package cannot be cancelled.' using errcode='40001'; end if;
  if exists(select 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text and status in ('pending','processing')) then
    raise exception 'A release attempt is still running for this start package.' using errcode='40001'; end if;
  update public.start_packages set status='cancelled',metadata=coalesce(metadata,'{}')||jsonb_build_object('cancellation_reason',v_reason)
    where org_id=p_org_id and id=p_package_id returning * into v_after;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,to_jsonb(v_pkg),to_jsonb(v_after),'starts.package_cancelled');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'start_package.cancelled','start_package',p_package_id,
      jsonb_build_object('reason',v_reason,'actor_id',p_actor_id),'activity');
  insert into public.outbox(org_id,job_type,payload)
    values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  return jsonb_build_object('status',v_after.status,'already_cancelled',false);
end $$;
revoke all on function public.cancel_start_package(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cancel_start_package(uuid,uuid,uuid,text) to service_role;

-- ==== 4. gate definitions reach the packages already open ====
-- Add the active definitions a package has no gate for. Called with the package
-- locked. The new gate starts pending (or not applicable when the package's
-- financing or purchasing says the gate does not apply to it), and readiness is
-- re-settled so a ready package never holds an unanswered gate.
create function public.add_missing_start_package_gates(p_package public.start_packages,p_actor_id uuid,p_purchasing_enabled boolean)
returns integer language plpgsql set search_path=public,pg_catalog as $$
declare v_added integer; v_keys jsonb;
begin
  with added as (
    insert into public.start_package_gates(org_id,start_package_id,gate_definition_id,status)
      select p_package.org_id,p_package.id,d.id,
        case when public.start_gate_applies(d.applies_when,p_package,p_purchasing_enabled) then 'pending' else 'not_applicable' end
      from public.start_gate_definitions d where d.org_id=p_package.org_id and d.is_active
        and not exists(select 1 from public.start_package_gates g where g.start_package_id=p_package.id and g.gate_definition_id=d.id)
      order by d.id
      on conflict (start_package_id,gate_definition_id) do nothing
      returning gate_definition_id)
  select count(*)::integer,coalesce(jsonb_agg(d.key order by d.key),'[]') into v_added,v_keys
    from added a join public.start_gate_definitions d on d.id=a.gate_definition_id;
  if v_added>0 then
    insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
      values(p_package.org_id,p_actor_id,'update','start_package',p_package.id,jsonb_build_object('status',p_package.status),
        jsonb_build_object('gates_added',v_keys),'starts.gates_added');
    insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
      values(p_package.org_id,'start_gate.added','start_package',p_package.id,
        jsonb_build_object('gates',v_keys,'actor_id',p_actor_id),'activity');
    perform public.settle_start_package_readiness(p_package,p_actor_id,p_purchasing_enabled);
  end if;
  return v_added;
end $$;
revoke all on function public.add_missing_start_package_gates(public.start_packages,uuid,boolean) from public,anon,authenticated;
grant execute on function public.add_missing_start_package_gates(public.start_packages,uuid,boolean) to service_role;

-- A package opened before a gate existed gets the gate when its desk is read.
create function public.heal_start_package_gates(p_org_id uuid,p_package_id uuid,p_actor_id uuid,p_purchasing_enabled boolean)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_added integer;
begin
  if p_purchasing_enabled is null then raise exception 'Invalid start gate heal'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,array['start.read']);
  if v_pkg.status not in ('open','ready') then return jsonb_build_object('status',v_pkg.status,'added',0); end if;
  v_added:=public.add_missing_start_package_gates(v_pkg,p_actor_id,p_purchasing_enabled);
  return jsonb_build_object('status',(select status from public.start_packages where org_id=p_org_id and id=p_package_id),'added',v_added);
end $$;
revoke all on function public.heal_start_package_gates(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.heal_start_package_gates(uuid,uuid,uuid,boolean) to service_role;

-- The org-level twin of assert_starts_actor_permission, for an action that is
-- the organization's and not one package's: a current active membership holding
-- the permission after denies and grants, with the facts share-locked so a
-- revocation cannot slip between the check and the write.
create function public.assert_starts_org_actor_permission(p_org_id uuid,p_actor_id uuid,p_permission text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_members uuid[]; v_roles uuid[]; v_base text[]; v_grants text[]; v_denies text[]; v_effective text[];
begin
  if p_permission is null or p_permission!~'^[a-z][a-z_]*\.[a-z][a-z_.]*$' then raise exception 'Invalid starts permission scope' using errcode='42501'; end if;
  if p_org_id is null or p_actor_id is null then raise exception 'Starts actor missing' using errcode='42501'; end if;
  perform 1 from public.permissions where key=p_permission for share;
  if not found then raise exception 'Starts release permission is not registered' using errcode='42501'; end if;
  perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' order by id for update;
  select array_agg(id order by id),array_agg(distinct role_id) into v_members,v_roles
    from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active';
  if v_members is null then raise exception 'Starts actor is no longer an active organization member' using errcode='42501'; end if;
  perform 1 from public.role_permissions where role_id=any(v_roles) order by role_id,permission_key for share;
  perform 1 from public.membership_permission_overrides where membership_id=any(v_members) order by membership_id,permission_key for share;
  select coalesce(array_agg(distinct permission_key),'{}') into v_base from public.role_permissions where role_id=any(v_roles);
  select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}')
    into v_grants,v_denies from public.membership_permission_overrides where membership_id=any(v_members);
  select coalesce(array_agg(distinct x),'{}') into v_effective from unnest(v_base||v_grants) x where not(x=any(v_denies));
  if p_permission=any(v_denies) or not(p_permission=any(v_effective) or '*'=any(v_effective)) then
    raise exception 'Starts actor no longer has % permission',p_permission using errcode='42501'; end if;
end $$;
revoke all on function public.assert_starts_org_actor_permission(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.assert_starts_org_actor_permission(uuid,uuid,text) to service_role;

-- Save one gate definition and, when it is active, fan it out to every open and
-- ready package of the organization. p_purchasing_communities names the
-- communities that have a price book, which the service reads (it decides
-- whether a purchasing-only gate applies to a package).
create function public.save_start_gate_definition(p_org_id uuid,p_actor_id uuid,p_id uuid,p_key text,p_label text,p_description text,
  p_check_kind text,p_auto_source text,p_requires_attestation_permission text,p_applies_when text,p_sort_order integer,
  p_is_active boolean,p_purchasing_communities uuid[])
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_before public.start_gate_definitions%rowtype; v_def public.start_gate_definitions%rowtype; v_pkg public.start_packages%rowtype;
  v_updated integer:=0; v_added integer; v_event uuid:=gen_random_uuid();
begin
  perform public.assert_starts_desk_caller();
  if p_org_id is null or p_actor_id is null or nullif(btrim(coalesce(p_key,'')),'') is null or nullif(btrim(coalesce(p_label,'')),'') is null
    or p_check_kind is null or p_applies_when is null or p_sort_order is null or p_is_active is null then
    raise exception 'Invalid start gate definition'; end if;
  perform public.assert_starts_org_actor_permission(p_org_id,p_actor_id,'start.release');
  if p_id is not null then
    select * into v_before from public.start_gate_definitions where org_id=p_org_id and id=p_id for update;
    if not found then raise exception 'Start gate not found' using errcode='42501'; end if;
    update public.start_gate_definitions set key=p_key,label=p_label,description=p_description,check_kind=p_check_kind,auto_source=p_auto_source,
      requires_attestation_permission=p_requires_attestation_permission,applies_when=p_applies_when,sort_order=p_sort_order,is_active=p_is_active
      where org_id=p_org_id and id=p_id returning * into v_def;
  else
    select * into v_before from public.start_gate_definitions where org_id=p_org_id and key=p_key for update;
    insert into public.start_gate_definitions(org_id,key,label,description,check_kind,auto_source,requires_attestation_permission,applies_when,sort_order,is_active)
      values(p_org_id,p_key,p_label,p_description,p_check_kind,p_auto_source,p_requires_attestation_permission,p_applies_when,p_sort_order,p_is_active)
      on conflict (org_id,key) do update set label=excluded.label,description=excluded.description,check_kind=excluded.check_kind,
        auto_source=excluded.auto_source,requires_attestation_permission=excluded.requires_attestation_permission,
        applies_when=excluded.applies_when,sort_order=excluded.sort_order,is_active=excluded.is_active
      returning * into v_def;
  end if;
  if v_def.is_active then
    -- Lock order is the packages' release jobs, then the packages, in id order,
    -- the order every desk and worker function takes.
    perform 1 from public.outbox where org_id=p_org_id and job_type='start_release' and payload->>'start_package_id' in
      (select id::text from public.start_packages where org_id=p_org_id and status in ('open','ready')) order by id for update;
    perform 1 from public.start_packages where org_id=p_org_id and status in ('open','ready') order by id for update;
    for v_pkg in select * from public.start_packages where org_id=p_org_id and status in ('open','ready') order by id loop
      v_added:=public.add_missing_start_package_gates(v_pkg,p_actor_id,v_pkg.community_id=any(coalesce(p_purchasing_communities,'{}')));
      if v_added>0 then v_updated:=v_updated+1; end if;
    end loop;
  end if;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,(case when v_before.id is null then 'insert' else 'update' end)::public.audit_action,'start_gate_definition',v_def.id,
      case when v_before.id is null then null else to_jsonb(v_before) end,
      to_jsonb(v_def)||jsonb_build_object('packages_updated',v_updated),'starts.gate_definition_saved');
  insert into public.events(id,org_id,event_type,entity_type,entity_id,payload,channel)
    values(v_event,p_org_id,'start_gate_definition.saved','start_gate_definition',v_def.id,
      jsonb_build_object('key',v_def.key,'is_active',v_def.is_active,'packages_updated',v_updated,'actor_id',p_actor_id),'activity');
  return jsonb_build_object('definition',to_jsonb(v_def),'packages_updated',v_updated);
end $$;
revoke all on function public.save_start_gate_definition(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,boolean,uuid[]) from public,anon,authenticated;
grant execute on function public.save_start_gate_definition(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,boolean,uuid[]) to service_role;

-- ==== 5. the selection tables answer to the release claim ====
-- The schedule step instantiates the home's selection groups and choices and
-- recomputes their cutoffs under the worker's claim client. They are written
-- under the same fence as the schedule itself, so a worker that lost its claim,
-- was cancelled or lost its actor cannot keep writing.
do $$ declare v_table text; begin
  foreach v_table in array array['project_selection_groups','project_selections','selection_exceptions'] loop
    execute format('create trigger starts_generated_worker_fence before insert or update or delete on public.%I for each row execute function public.fence_starts_generated_artifact_write()',v_table);
  end loop;
end $$;

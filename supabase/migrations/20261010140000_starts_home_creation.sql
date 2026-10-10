-- Starts: a house's home is created and linked in one transaction.
--
-- Opening a start package used to create the home (project) through the app,
-- then link the lot and insert the package and its gates in separate writes.
-- A failure between them orphaned a project, and the retry created a second
-- one for the same lot. Here the lot is locked, the home is created from a
-- bundle the service prepared with the same pure helpers createProject uses
-- (project, billing contract, financial settings, accounting mapping), and the
-- lot link, package, gates, audit, events and search reindex commit together.
-- The lot's home and the lot's single active package are the idempotency keys:
-- a retry after a committed open finds them and creates nothing.
--
-- A package opened before homes were created at open has no home until its
-- release; ensure_start_package_home gives it one under the package lock, so a
-- retried release reuses the home rather than building another.
--
-- Requires 20261003048000_starts_release_and_purchasing_fences and
-- 20261010100000_starts_release_control. Both functions refuse the browser
-- roles and worker claims, and re-check the actor's start.write /
-- start.release (and project.manage when a home is created) with division
-- reach over the community, lot and home, in the transaction that writes.

-- The actor check gains the two permissions the desk's create paths need.
create or replace function public.assert_starts_actor_permission(p_job public.outbox,p_package public.start_packages,p_permission text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_actor uuid; v_members uuid[]; v_roles uuid[]; v_base text[]; v_grants text[]; v_denies text[]; v_effective text[];
 v_assigned boolean; v_division uuid; v_lot_community uuid; v_lot_project uuid; v_divisions uuid[];
begin
 if p_permission not in ('start.release','start.read','start.write','project.manage') or p_permission is null then raise exception 'Invalid starts permission scope' using errcode='42501'; end if;
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
 if p_permission=any(v_denies) or not(p_permission=any(v_effective) or '*'=any(v_effective)) then raise exception 'Starts actor no longer has % permission',p_permission using errcode='42501'; end if;
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

-- The prepared home, its contract and settings, written with the identity the
-- service chose. Every prepared row must name this org, actor and home.
create function public.create_start_home(p_org_id uuid,p_actor_id uuid,p_lot public.lots,p_home jsonb)
returns uuid language plpgsql set search_path=public,pg_catalog as $$
declare v_home_id uuid; v_value jsonb; v_home public.projects%rowtype; v_contract_id uuid; v_connection uuid;
begin
  if jsonb_typeof(p_home) is distinct from 'object' then raise exception 'Prepared start home is required'; end if;
  v_home_id:=(p_home->>'projectId')::uuid;
  if v_home_id is null then raise exception 'Prepared start home identity is required'; end if;
  v_value:=p_home->'project';
  if v_value->>'org_id' is distinct from p_org_id::text or v_value->>'created_by' is distinct from p_actor_id::text
    or v_value->>'property_type' is distinct from 'production' or v_value->>'phase' is distinct from 'precon'
    or nullif(btrim(v_value->>'name'),'') is null then raise exception 'Prepared start home ownership mismatch'; end if;
  v_value:=v_value||jsonb_build_object('id',v_home_id,'division_id',p_lot.division_id);
  insert into public.projects(id,org_id,name,status,phase,start_date,end_date,location,client_id,property_type,project_type,description,
      retainage_percent,total_value,created_by,prospect_id,division_id)
    select v.id,v.org_id,v.name,v.status,v.phase,v.start_date,v.end_date,v.location,v.client_id,v.property_type,v.project_type,v.description,
      v.retainage_percent,v.total_value,v.created_by,v.prospect_id,v.division_id
    from jsonb_populate_record(null::public.projects,v_value) v returning * into v_home;
  -- A production home earns through the purchase agreement its sale signs, so
  -- it opens without a contract; a prepared one is written only when the
  -- service chose to open one (explicit billing terms).
  v_value:=p_home->'billingContract';
  if v_value is not null and jsonb_typeof(v_value) is distinct from 'null' then
    if v_value->>'org_id' is distinct from p_org_id::text or v_value->>'project_id' is distinct from v_home_id::text then
      raise exception 'Prepared start home billing ownership mismatch'; end if;
    insert into public.contracts(org_id,project_id,title,status,contract_type,total_cents,currency,markup_percent,gmp_cents,contingency_cents,
        fixed_fee_cents,fee_presentation,savings_split_owner_pct,savings_split_builder_pct,labor_burden_multiplier,rate_schedule_id,
        requires_client_cost_approval,open_book,retainage_percent,retainage_applies_to_fee,retainage_schedule,stored_materials_retainage_percent,snapshot)
      select v.org_id,v.project_id,v.title,v.status,v.contract_type,v.total_cents,v.currency,v.markup_percent,v.gmp_cents,v.contingency_cents,
        v.fixed_fee_cents,v.fee_presentation,v.savings_split_owner_pct,v.savings_split_builder_pct,v.labor_burden_multiplier,v.rate_schedule_id,
        v.requires_client_cost_approval,v.open_book,v.retainage_percent,v.retainage_applies_to_fee,v.retainage_schedule,v.stored_materials_retainage_percent,v.snapshot
      from jsonb_populate_record(null::public.contracts,v_value) v returning id into v_contract_id;
    insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
      values(p_org_id,p_actor_id,'insert','contract',v_contract_id,v_value,'project_settings');
  end if;
  v_value:=p_home->'financialSettings';
  if v_value->>'org_id' is distinct from p_org_id::text or v_value->>'project_id' is distinct from v_home_id::text
    or v_value->>'created_by' is distinct from p_actor_id::text then raise exception 'Prepared start home settings ownership mismatch'; end if;
  insert into public.project_financial_settings(org_id,project_id,billing_model,fixed_price_billing_basis,paid_costs_required,proof_required,
      client_cost_approval_required,open_book_required,cost_codes_enabled,setup_completed_at,setup_completed_by,updated_by,created_by,metadata)
    select v.org_id,v.project_id,v.billing_model,v.fixed_price_billing_basis,v.paid_costs_required,v.proof_required,
      v.client_cost_approval_required,v.open_book_required,v.cost_codes_enabled,v.setup_completed_at,v.setup_completed_by,v.updated_by,v.created_by,v.metadata
    from jsonb_populate_record(null::public.project_financial_settings,v_value) v;
  -- A home inherits the org's default accounting connection, as createProject does.
  select connection_id into v_connection from public.accounting_entity_map
    where org_id=p_org_id and project_id is null and community_id is null and division_id is null order by id limit 1 for share;
  if v_connection is not null then
    insert into public.accounting_entity_map(org_id,connection_id,project_id,dimensions,created_by)
      values(p_org_id,v_connection,v_home_id,coalesce(p_home->'accountingDimensions','{}'),p_actor_id);
  end if;
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'project_created','project',v_home_id,jsonb_build_object('name',v_home.name,'actor_id',p_actor_id),'activity');
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
    values(p_org_id,p_actor_id,'insert','project',v_home_id,to_jsonb(v_home),'starts.home_created');
  insert into public.outbox(org_id,job_type,payload)
    select p_org_id,'reindex_search',jsonb_build_object('entity_type',entity,'entity_id',entity_id)
    from (values('project',v_home_id),('contract',v_contract_id)) indexed(entity,entity_id) where entity_id is not null;
  return v_home_id;
end $$;
revoke all on function public.create_start_home(uuid,uuid,public.lots,jsonb) from public,anon,authenticated;
grant execute on function public.create_start_home(uuid,uuid,public.lots,jsonb) to service_role;

-- Links a lot that had no home to the one just created. The lot is already
-- locked by the caller.
create function public.link_start_home(p_org_id uuid,p_actor_id uuid,p_lot public.lots,p_home_id uuid)
returns void language plpgsql set search_path=public,pg_catalog as $$
declare v_after public.lots%rowtype;
begin
  update public.lots set project_id=p_home_id,status='assigned' where org_id=p_org_id and id=p_lot.id and project_id is null
    returning * into v_after;
  if not found then raise exception 'The lot gained a home while this one was being created' using errcode='40001'; end if;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','lot',p_lot.id,jsonb_build_object('project_id',p_lot.project_id,'status',p_lot.status),
      jsonb_build_object('project_id',v_after.project_id,'status',v_after.status),'starts.home_created');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','lot','entity_id',p_lot.id));
end $$;
revoke all on function public.link_start_home(uuid,uuid,public.lots,uuid) from public,anon,authenticated;
grant execute on function public.link_start_home(uuid,uuid,public.lots,uuid) to service_role;

create function public.assert_starts_desk_caller() returns void language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb;
begin
  if current_user in ('anon','authenticated') then
    raise exception 'Start packages require an authorized server action' using errcode='42501'; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is not null or v_headers->>'x-starts-claim-token' is not null then
    raise exception 'Start package homes cannot be created inside a worker claim' using errcode='42501'; end if;
end $$;
revoke all on function public.assert_starts_desk_caller() from public,anon,authenticated;
grant execute on function public.assert_starts_desk_caller() to service_role;

-- Open a lot's start package: its home (created from p_home when the lot has
-- none; ignored when it has one), the package and every active gate, or
-- nothing.
create function public.open_start_package(p_org_id uuid,p_actor_id uuid,p_lot_id uuid,p_is_financed boolean,p_target_week date,p_home jsonb)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_lot public.lots%rowtype; v_scope public.start_packages%rowtype; v_actor public.outbox%rowtype;
  v_pkg public.start_packages%rowtype; v_home uuid; v_created boolean:=false;
begin
  perform public.assert_starts_desk_caller();
  if p_org_id is null or p_actor_id is null or p_lot_id is null or p_is_financed is null then raise exception 'Invalid start package request'; end if;
  select * into v_lot from public.lots where org_id=p_org_id and id=p_lot_id for update;
  if not found then raise exception 'Lot not found' using errcode='42501'; end if;
  if v_lot.status not in ('developed','assigned') then raise exception 'Only developed or assigned lots can enter the start pipeline.'; end if;
  if exists(select 1 from public.start_packages where lot_id=p_lot_id and status<>'cancelled') then
    raise exception 'This lot already has an active start package.' using errcode='23505'; end if;
  v_scope.org_id:=p_org_id; v_scope.lot_id:=v_lot.id; v_scope.community_id:=v_lot.community_id; v_scope.project_id:=v_lot.project_id;
  v_actor.org_id:=p_org_id; v_actor.job_type:='start_release'; v_actor.payload:=jsonb_build_object('actor_id',p_actor_id);
  perform public.assert_starts_actor_permission(v_actor,v_scope,'start.write');
  v_home:=v_lot.project_id;
  if v_home is null then
    perform public.assert_starts_actor_permission(v_actor,v_scope,'project.manage');
    v_home:=public.create_start_home(p_org_id,p_actor_id,v_lot,p_home);
    perform public.link_start_home(p_org_id,p_actor_id,v_lot,v_home);
    v_created:=true;
  end if;
  insert into public.start_packages(org_id,lot_id,community_id,project_id,is_financed,target_week)
    values(p_org_id,v_lot.id,v_lot.community_id,v_home,p_is_financed,p_target_week) returning * into v_pkg;
  insert into public.start_package_gates(org_id,start_package_id,gate_definition_id)
    select p_org_id,v_pkg.id,d.id from public.start_gate_definitions d where d.org_id=p_org_id and d.is_active order by d.id;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
    values(p_org_id,p_actor_id,'insert','start_package',v_pkg.id,to_jsonb(v_pkg),'starts.package_opened');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'start_package.opened','start_package',v_pkg.id,jsonb_build_object('lot_id',v_lot.id,'community_id',v_lot.community_id,
      'project_id',v_home,'created_home',v_created,'actor_id',p_actor_id),'activity');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',v_pkg.id));
  return jsonb_build_object('start_package_id',v_pkg.id,'project_id',v_home,'created_home',v_created);
end $$;
revoke all on function public.open_start_package(uuid,uuid,uuid,boolean,date,jsonb) from public,anon,authenticated;
grant execute on function public.open_start_package(uuid,uuid,uuid,boolean,date,jsonb) to service_role;

-- Give an open or ready package without a home the lot's home — the existing
-- one, or one created from p_home — under the release control lock. A package
-- that already has a home returns it unchanged, so a retried release can never
-- build a second house for the same package.
create function public.ensure_start_package_home(p_org_id uuid,p_actor_id uuid,p_package_id uuid,p_home jsonb)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_after public.start_packages%rowtype; v_lot public.lots%rowtype;
  v_actor public.outbox%rowtype; v_home uuid; v_created boolean:=false;
begin
  perform public.assert_starts_desk_caller();
  v_pkg:=public.lock_starts_release_control(p_org_id,p_package_id,p_actor_id);
  if v_pkg.project_id is not null then return jsonb_build_object('project_id',v_pkg.project_id,'created_home',false); end if;
  if v_pkg.status not in ('open','ready') then raise exception 'Only an open or ready start package can be given a home.' using errcode='40001'; end if;
  select * into v_lot from public.lots where org_id=p_org_id and id=v_pkg.lot_id for update;
  if not found or v_lot.community_id is distinct from v_pkg.community_id then raise exception 'Starts lot ancestry differs from package' using errcode='42501'; end if;
  v_actor.org_id:=p_org_id; v_actor.job_type:='start_release'; v_actor.payload:=jsonb_build_object('actor_id',p_actor_id);
  v_home:=v_lot.project_id;
  if v_home is null then
    perform public.assert_starts_actor_permission(v_actor,v_pkg,'project.manage');
    v_home:=public.create_start_home(p_org_id,p_actor_id,v_lot,p_home);
    perform public.link_start_home(p_org_id,p_actor_id,v_lot,v_home);
    v_created:=true;
  end if;
  update public.start_packages set project_id=v_home where org_id=p_org_id and id=p_package_id returning * into v_after;
  -- The home is now part of the package's scope; the actor must reach it too.
  perform public.assert_starts_actor_permission(v_actor,v_after,'start.release');
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,jsonb_build_object('project_id',null),
      jsonb_build_object('project_id',v_home,'created_home',v_created),'starts.home_linked');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  return jsonb_build_object('project_id',v_home,'created_home',v_created);
end $$;
revoke all on function public.ensure_start_package_home(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ensure_start_package_home(uuid,uuid,uuid,jsonb) to service_role;

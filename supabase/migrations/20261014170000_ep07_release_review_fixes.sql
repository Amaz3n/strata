-- EP07 review round 1: release keys and plan pins.
--
-- 1. metadata.release_key and metadata.release_version on budgets, schedule_items
--    and inspections are written by the release worker (or another server path)
--    only. A member could plant a row under a key through the data API and the
--    release would adopt it as its own, or leave an extra keyed row that no
--    receipt could ever count.
-- 2. A receipt is bound to the plan version the step built from: the worker
--    stamps release_version on every row it builds, refuses to adopt a keyed row
--    of another version, and settle_release_step counts only rows of the
--    version it is settling.
-- 3. A lot's plan pin cannot change while its package is releasing or in
--    attention: artifacts are keyed by position, so a resumed release would mix
--    the old plan's rows with the new plan's.
-- 4. The lot guard's message also names deleting the home (the foreign key
--    detaches the lot when a house with a live package is deleted).
-- No new permission key and no new table.

create function public.guard_release_key_browser_writes() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
begin
  if current_user in ('anon','authenticated') and (
    (tg_op='INSERT' and (new.metadata ? 'release_key' or new.metadata ? 'release_version'))
    or (tg_op='UPDATE' and ((new.metadata->'release_key') is distinct from (old.metadata->'release_key')
      or (new.metadata->'release_version') is distinct from (old.metadata->'release_version')))) then
    raise exception 'Release keys are written by the release worker only' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_release_key_browser_writes() from public,anon,authenticated;
do $$ declare v_table text; begin
  foreach v_table in array array['budgets','schedule_items','inspections'] loop
    execute format('create trigger release_key_browser_write_guard before insert or update on public.%I for each row execute function public.guard_release_key_browser_writes()',v_table);
  end loop;
end $$;

create or replace function public.guard_lot_active_start() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
begin
  if old.project_id is not null and (new.project_id is distinct from old.project_id or new.community_id is distinct from old.community_id)
    and exists(select 1 from public.start_packages p where p.org_id=old.org_id and p.lot_id=old.id
      and p.status in ('open','ready','releasing','attention')) then
    raise exception 'Cancel the start package before detaching or moving this lot or deleting its home.' using errcode='23514';
  end if;
  return new;
end $$;

create function public.guard_lot_release_pin() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
begin
  if (new.house_plan_id is distinct from old.house_plan_id or new.house_plan_version_id is distinct from old.house_plan_version_id
      or new.house_plan_elevation_id is distinct from old.house_plan_elevation_id)
    and exists(select 1 from public.start_packages p where p.org_id=old.org_id and p.lot_id=old.id and p.status in ('releasing','attention')) then
    raise exception 'Cancel the release before changing this lot''s plan, version or elevation.' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_lot_release_pin() from public,anon,authenticated;
create trigger lots_release_pin_guard before update of house_plan_id,house_plan_version_id,house_plan_elevation_id on public.lots
  for each row execute function public.guard_lot_release_pin();

create or replace function public.settle_release_step(p_org_id uuid,p_job_id bigint,p_token uuid,p_step text,p_detail jsonb,
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
      select * into v_budget from public.budgets where org_id=p_org_id and project_id=v_pkg.project_id and metadata->>'release_key'='budget'
        and (p_version_id is null or metadata->>'release_version'=p_version_id::text);
      if not found then raise exception 'Release step budget left no budget on the home' using errcode='40001'; end if;
      select count(*)::integer,coalesce(sum(amount_cents),0) into v_found,v_sum from public.budget_lines where org_id=p_org_id and budget_id=v_budget.id;
      if v_sum is distinct from coalesce(v_budget.total_cents,0)::bigint then
        raise exception 'Release step budget receipt is incomplete: lines total % of %',v_sum,coalesce(v_budget.total_cents,0) using errcode='40001'; end if;
    elsif p_step='schedule' then
      select count(*)::integer into v_found from public.schedule_items where org_id=p_org_id and project_id=v_pkg.project_id
        and metadata->>'release_key' like 'schedule:%' and (p_version_id is null or metadata->>'release_version'=p_version_id::text);
    else
      select count(*)::integer into v_found from public.inspections where org_id=p_org_id and project_id=v_pkg.project_id
        and metadata->>'release_key' like 'checklist:%' and (p_version_id is null or metadata->>'release_version'=p_version_id::text);
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


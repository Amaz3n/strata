-- EP03 review fixes.
--
-- 1. home_margin_baselines are cost and margin. Reading them took only org
--    membership (plus the division wall), while every other cost-bearing read
--    in the catalog takes financials.margin.read. They now take it too; the
--    division wall is unchanged.
--
-- 2. Replacing a lot fit override was two client writes — revoke the live
--    override, then insert the new one — so a failure between them left the
--    configuration with no override at all. replace_lot_fit_override does both
--    in one transaction. It runs as the caller (security invoker), so the
--    table's own policies still decide who may revoke and insert, in whose
--    name, and on which division's lots; the explicit permission check only
--    gives the refusal words. Revoking first is the only order the one-live-
--    override unique index allows.
--
-- 3. plan_change_proposal_homes.adopted_at and change_order_id are the record
--    that an adoption happened and through which amendment. A plan.adopt
--    holder could write them directly through the API (the decide policy
--    governs the row, not those columns), forging that record. Browser roles
--    may no longer set or change either column; the adoption paths in
--    lib/services/plan-change-proposals.ts write them with the service role.
--
-- 4. A selection records the revision of the package it chose, as it already
--    does for an option (20261012030000): project_selections gains
--    selected_package_revision, set by the same trigger from
--    selection_packages.revision when package_id is chosen or changed, kept
--    while it is unchanged, and cleared with it. A later revision of the
--    package never reaches a selection already made.

-- ---------------------------------------------------------------------------
-- 1. Margin baselines take financials.margin.read.
-- ---------------------------------------------------------------------------

drop policy if exists home_margin_baselines_read on public.home_margin_baselines;
create policy home_margin_baselines_read on public.home_margin_baselines
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'financials.margin.read'));

-- ---------------------------------------------------------------------------
-- 2. Replacing a fit override is one transaction.
-- ---------------------------------------------------------------------------

create or replace function public.replace_lot_fit_override(
  p_org_id uuid,
  p_lot_id uuid,
  p_house_plan_id uuid,
  p_house_plan_elevation_id uuid,
  p_swing text,
  p_violations jsonb,
  p_reason text,
  p_evidence_file_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  replaced uuid[];
  recorded public.lot_fit_overrides;
begin
  if actor is null or not public.has_org_permission(p_org_id, 'lot.fit_override') then
    raise exception 'Missing permission: lot.fit_override' using errcode = '42501';
  end if;
  -- Two replacements of the same lot queue rather than collide on the unique index.
  perform pg_advisory_xact_lock(hashtextextended('lot-fit-override:' || p_lot_id::text, 0));

  with revoked as (
    update public.lot_fit_overrides o
    set revoked_at = now(), revoked_by = actor
    where o.org_id = p_org_id
      and o.lot_id = p_lot_id
      and o.house_plan_id = p_house_plan_id
      and o.house_plan_elevation_id is not distinct from p_house_plan_elevation_id
      and o.swing is not distinct from p_swing
      and o.revoked_at is null
    returning o.id
  )
  select coalesce(array_agg(id), '{}') into replaced from revoked;

  insert into public.lot_fit_overrides
    (org_id, lot_id, house_plan_id, house_plan_elevation_id, swing, violations, reason, evidence_file_id, approved_by)
  values
    (p_org_id, p_lot_id, p_house_plan_id, p_house_plan_elevation_id, p_swing, p_violations, p_reason, p_evidence_file_id, actor)
  returning * into recorded;

  return jsonb_build_object(
    'override', jsonb_build_object(
      'id', recorded.id,
      'lot_id', recorded.lot_id,
      'house_plan_id', recorded.house_plan_id,
      'house_plan_elevation_id', recorded.house_plan_elevation_id,
      'swing', recorded.swing,
      'violations', recorded.violations,
      'reason', recorded.reason,
      'evidence_file_id', recorded.evidence_file_id,
      'approved_by', recorded.approved_by,
      'approved_at', recorded.approved_at
    ),
    'replaced', to_jsonb(replaced)
  );
end;
$$;

comment on function public.replace_lot_fit_override(uuid, uuid, uuid, uuid, text, jsonb, text, uuid) is
  'Records a lot fit override in the caller''s name, revoking the live override for the same lot, plan, elevation and handing in the same transaction. Called by recordLotFitOverride (lib/services/lot-fit.ts).';

revoke all on function public.replace_lot_fit_override(uuid, uuid, uuid, uuid, text, jsonb, text, uuid) from public, anon;
grant execute on function public.replace_lot_fit_override(uuid, uuid, uuid, uuid, text, jsonb, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. An adoption is recorded by the server.
-- ---------------------------------------------------------------------------

create or replace function public.guard_plan_change_home_adoption_browser_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
    new.adopted_at is distinct from old.adopted_at
    or new.change_order_id is distinct from old.change_order_id
  ) then
    raise exception 'A home''s adoption is recorded by the server' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_plan_change_home_adoption_browser_writes() from public, anon, authenticated;

drop trigger if exists plan_change_proposal_homes_adoption_browser_guard on public.plan_change_proposal_homes;
create trigger plan_change_proposal_homes_adoption_browser_guard
  before update of adopted_at, change_order_id on public.plan_change_proposal_homes
  for each row execute function public.guard_plan_change_home_adoption_browser_writes();

-- ---------------------------------------------------------------------------
-- 4. A selection records the package revision it chose.
-- ---------------------------------------------------------------------------

alter table public.project_selections
  add column if not exists selected_package_revision integer
  constraint project_selections_selected_package_revision_check
    check (selected_package_revision is null or selected_package_revision > 0);

comment on column public.project_selections.selected_package_revision is
  'The revision of package_id when it was chosen (selection_packages.revision). Set only by tg_project_selection_option_revision.';

create or replace function public.tg_project_selection_option_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.selected_option_id is not distinct from old.selected_option_id then
    new.selected_option_revision := old.selected_option_revision;
  elsif new.selected_option_id is null then
    new.selected_option_revision := null;
  else
    select o.revision into new.selected_option_revision
      from public.selection_options o
     where o.org_id = new.org_id and o.id = new.selected_option_id;
  end if;

  if tg_op = 'UPDATE' and new.package_id is not distinct from old.package_id then
    new.selected_package_revision := old.selected_package_revision;
  elsif new.package_id is null then
    new.selected_package_revision := null;
  else
    select p.revision into new.selected_package_revision
      from public.selection_packages p
     where p.org_id = new.org_id and p.id = new.package_id;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_project_selection_option_revision() from public, anon, authenticated, service_role;

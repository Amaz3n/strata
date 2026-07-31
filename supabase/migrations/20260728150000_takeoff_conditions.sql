-- Takeoff conditions: the priced bucket a set of measured markups rolls into.
--
-- A condition is what an estimator actually thinks in — "LVP flooring", "base
-- trim", "can lights" — not a shape on a page. Measurements on the drawing are
-- members of a condition; the condition carries the unit, the cost code, the
-- waste allowance, and (optionally) a pinned rate. Its effective quantity is
-- sum(member markup quantity) * (1 + waste_pct/100), computed in the service
-- and never stored, so a re-measure is live rather than a stale cache.
--
-- Posture-neutral by design. A condition lives on EITHER a project (the
-- residential/commercial home, where it feeds estimate_items or bid_scope_items)
-- OR a house plan version (the production home, where it feeds
-- house_plan_takeoff_lines). Exactly one, enforced below. There is no
-- `production_takeoff_*` table and never will be.

create table if not exists public.takeoff_conditions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  house_plan_version_id uuid references public.house_plan_versions(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  -- Every member markup must measure in this unit; the service refuses a
  -- mismatched assignment rather than silently summing SF into LF.
  uom text not null check (uom in ('lf', 'sf', 'ea')),
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  -- Fixed palette (lib/drawings/takeoff-palette.ts). Identity of the condition
  -- on the sheet, which is why it is stored rather than derived from sort order.
  color text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  waste_pct numeric not null default 0 check (waste_pct >= 0 and waste_pct <= 100),
  -- Pinned rate. Null falls back to the cost code's default_unit_cost_cents.
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  -- Condition-level portal visibility. Wins over per-markup share flags for the
  -- estimate portal "show me" view (docs/takeoff-gameplan.md phase 7).
  share_with_clients boolean not null default false,
  notes text,
  sort_order integer not null default 0,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint takeoff_conditions_single_home check (
    num_nonnulls(project_id, house_plan_version_id) = 1
  )
);

create index if not exists takeoff_conditions_org_project_idx
  on public.takeoff_conditions (org_id, project_id, sort_order)
  where project_id is not null;
create index if not exists takeoff_conditions_org_plan_version_idx
  on public.takeoff_conditions (org_id, house_plan_version_id, sort_order)
  where house_plan_version_id is not null;
create index if not exists takeoff_conditions_cost_code_idx
  on public.takeoff_conditions (org_id, cost_code_id)
  where cost_code_id is not null;

drop trigger if exists takeoff_conditions_set_updated_at on public.takeoff_conditions;
create trigger takeoff_conditions_set_updated_at before update on public.takeoff_conditions
  for each row execute function public.tg_set_updated_at();

alter table public.takeoff_conditions enable row level security;

-- Read is gated on takeoff.read, write on takeoff.write. `(select auth.uid())`
-- form is required: bare auth.uid() re-introduces the RLS initplan perf bug
-- fixed Jul 2026.
create policy takeoff_conditions_read on public.takeoff_conditions
  for select to authenticated
  using (public.has_org_permission(org_id, 'takeoff.read'));

create policy takeoff_conditions_insert on public.takeoff_conditions
  for insert to authenticated
  with check (
    public.has_org_permission(org_id, 'takeoff.write')
    and (created_by is null or created_by = (select auth.uid()))
  );

create policy takeoff_conditions_update on public.takeoff_conditions
  for update to authenticated
  using (public.has_org_permission(org_id, 'takeoff.write'))
  with check (public.has_org_permission(org_id, 'takeoff.write'));

create policy takeoff_conditions_delete on public.takeoff_conditions
  for delete to authenticated
  using (public.has_org_permission(org_id, 'takeoff.write'));

grant select, insert, update, delete on table public.takeoff_conditions to authenticated;
grant all on table public.takeoff_conditions to service_role;

-- ---------------------------------------------------------------------------
-- RBAC catalog
-- ---------------------------------------------------------------------------
-- Read follows drawing.read (anyone who can open the plans can see what was
-- measured). Write follows drawing.markup plus the estimating roles, since
-- pricing a condition is an estimator's job even when they never touch a sheet.

insert into public.permissions (key, description) values
  ('takeoff.read', 'View takeoff conditions and measured quantities on drawings'),
  ('takeoff.write', 'Create and edit takeoff conditions and push quantities to estimates, bids, and plan takeoffs')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'takeoff.read'
from public.roles r
where r.key in (
  'org_owner','org_admin','org_office_admin','org_project_lead','pm','org_estimator',
  'org_bookkeeper','org_user','org_viewer','org_purchasing_manager','org_starts_coordinator',
  'org_sales_agent','org_superintendent','org_land_manager','org_design_studio_coordinator'
)
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'takeoff.write'
from public.roles r
where r.key in (
  'org_owner','org_admin','org_office_admin','org_project_lead','pm','org_estimator',
  'org_purchasing_manager'
)
on conflict (role_id, permission_key) do nothing;

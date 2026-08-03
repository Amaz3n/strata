-- Takeoff: axis factors, a reusable condition library, and per-sheet coverage.
--
-- Three additions, all serving the same complaint: a drawing is flat, and an
-- estimator's job is not.
--
-- 1. AXIS FACTORS. A plan view shows two dimensions. Concrete needs a depth,
--    drywall needs a wall height, roofing needs a pitch, and gravel is bought by
--    weight. Each is a single number the estimator already knows and the drawing
--    cannot supply, so a condition carries it and the service converts. There is
--    deliberately NO volume drawing tool: nobody measures a slab in 3D, they
--    measure it in plan and say "4 inches".
--
-- 2. CONDITION TEMPLATES. Conditions repeat almost exactly job to job. Retyping
--    them (with their cost codes, waste, and factors) is the single largest tax
--    on starting a takeoff, and the retyping is where the errors come from.
--
-- 3. SHEET STATUS. Missing an entire sheet is the most expensive takeoff error
--    there is, and today it is invisible. This table stores only the human's
--    DECLARATION about a sheet ("done", or "nothing to measure here"); whether a
--    sheet has measurements is derived from the markups themselves.

-- ---------------------------------------------------------------------------
-- 1. Axis factors on takeoff_conditions
-- ---------------------------------------------------------------------------

alter table public.takeoff_conditions
  drop constraint if exists takeoff_conditions_uom_check;

alter table public.takeoff_conditions
  add constraint takeoff_conditions_uom_check
  check (uom in ('lf', 'sf', 'ea', 'cy', 'sy', 'sq', 'ton'));

alter table public.takeoff_conditions
  -- Thickness along the axis the plan does not show, in INCHES. Slab depth,
  -- base course depth. Inches because that is how a spec reads: "4in slab".
  add column if not exists depth_in numeric check (depth_in is null or depth_in > 0),
  -- Wall height in FEET. Turns a run walked in plan into vertical area.
  add column if not exists height_ft numeric check (height_ft is null or height_ft > 0),
  -- Roof rise per 12 of run. 8 means 8/12. Multiplies plan area by
  -- sqrt(1 + (rise/12)^2) — the ~20% of roof a plan view silently omits.
  add column if not exists pitch_rise numeric
    check (pitch_rise is null or (pitch_rise > 0 and pitch_rise <= 24)),
  -- Bulk density in tons per cubic yard. Gravel ~1.4, asphalt ~2.0. A material
  -- property, which is why it is the estimator's number and not a constant.
  add column if not exists tons_per_cy numeric
    check (tons_per_cy is null or tons_per_cy > 0);

-- Each factor belongs to specific units, and the units that NEED one may not go
-- without. Enforced here as well as in Zod so a direct write cannot produce a
-- cubic-yard condition with no depth — which would silently report zero.
alter table public.takeoff_conditions
  drop constraint if exists takeoff_conditions_factor_units;
alter table public.takeoff_conditions
  add constraint takeoff_conditions_factor_units check (
    (height_ft is null or uom = 'sf')
    and (pitch_rise is null or uom in ('sf', 'sq'))
    and (depth_in is null or uom in ('cy', 'ton'))
    and (tons_per_cy is null or uom = 'ton')
    and ((uom in ('cy', 'ton')) = (depth_in is not null))
    and ((uom = 'ton') = (tons_per_cy is not null))
    -- A wall is not pitched. Allowing both would make the source unit ambiguous
    -- (is this LF of rake, or SF of plan?) with no honest way to display it.
    and not (height_ft is not null and pitch_rise is not null)
  );

comment on column public.takeoff_conditions.depth_in is
  'Thickness along the unmeasured axis, inches. Required for cy/ton, forbidden otherwise.';
comment on column public.takeoff_conditions.height_ft is
  'Wall height in feet. When set, an sf condition sums lf members instead of sf.';
comment on column public.takeoff_conditions.pitch_rise is
  'Roof rise per 12 of run. Multiplies plan area by the slope factor.';
comment on column public.takeoff_conditions.tons_per_cy is
  'Bulk density, tons per cubic yard. Required for ton, forbidden otherwise.';

-- ---------------------------------------------------------------------------
-- 2. Condition template library
-- ---------------------------------------------------------------------------
-- Same shape as takeoff_conditions minus the scope columns (a template belongs
-- to the org, not to a job) plus a flat one-level `group_name`. Deliberately NOT
-- a hierarchy: an estimator wants "Concrete" and "Framing", not a WBS.

create table if not exists public.takeoff_condition_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  uom text not null check (uom in ('lf', 'sf', 'ea', 'cy', 'sy', 'sq', 'ton')),
  depth_in numeric check (depth_in is null or depth_in > 0),
  height_ft numeric check (height_ft is null or height_ft > 0),
  pitch_rise numeric check (pitch_rise is null or (pitch_rise > 0 and pitch_rise <= 24)),
  tons_per_cy numeric check (tons_per_cy is null or tons_per_cy > 0),
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  color text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  waste_pct numeric not null default 0 check (waste_pct >= 0 and waste_pct <= 100),
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  share_with_clients boolean not null default false,
  notes text,
  group_name text,
  sort_order integer not null default 0,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint takeoff_condition_templates_factor_units check (
    (height_ft is null or uom = 'sf')
    and (pitch_rise is null or uom in ('sf', 'sq'))
    and (depth_in is null or uom in ('cy', 'ton'))
    and (tons_per_cy is null or uom = 'ton')
    and ((uom in ('cy', 'ton')) = (depth_in is not null))
    and ((uom = 'ton') = (tons_per_cy is not null))
    and not (height_ft is not null and pitch_rise is not null)
  )
);

-- A library with two "Base trim" rows in it is not a library. Case-insensitive
-- because "BASE TRIM" and "Base trim" are the same condition to a human.
create unique index if not exists takeoff_condition_templates_org_name_key
  on public.takeoff_condition_templates (org_id, lower(btrim(name)));
create index if not exists takeoff_condition_templates_org_group_idx
  on public.takeoff_condition_templates (org_id, group_name, sort_order);
create index if not exists takeoff_condition_templates_cost_code_idx
  on public.takeoff_condition_templates (org_id, cost_code_id)
  where cost_code_id is not null;

drop trigger if exists takeoff_condition_templates_set_updated_at
  on public.takeoff_condition_templates;
create trigger takeoff_condition_templates_set_updated_at
  before update on public.takeoff_condition_templates
  for each row execute function public.tg_set_updated_at();

alter table public.takeoff_condition_templates enable row level security;

drop policy if exists takeoff_condition_templates_read on public.takeoff_condition_templates;
create policy takeoff_condition_templates_read on public.takeoff_condition_templates
  for select to authenticated
  using (public.has_org_permission(org_id, 'takeoff.read'));

drop policy if exists takeoff_condition_templates_insert on public.takeoff_condition_templates;
create policy takeoff_condition_templates_insert on public.takeoff_condition_templates
  for insert to authenticated
  with check (
    public.has_org_permission(org_id, 'takeoff.write')
    and (created_by is null or created_by = (select auth.uid()))
  );

drop policy if exists takeoff_condition_templates_update on public.takeoff_condition_templates;
create policy takeoff_condition_templates_update on public.takeoff_condition_templates
  for update to authenticated
  using (public.has_org_permission(org_id, 'takeoff.write'))
  with check (public.has_org_permission(org_id, 'takeoff.write'));

drop policy if exists takeoff_condition_templates_delete on public.takeoff_condition_templates;
create policy takeoff_condition_templates_delete on public.takeoff_condition_templates
  for delete to authenticated
  using (public.has_org_permission(org_id, 'takeoff.write'));

grant select, insert, update, delete on table public.takeoff_condition_templates to authenticated;
grant all on table public.takeoff_condition_templates to service_role;

-- ---------------------------------------------------------------------------
-- 3. Per-sheet takeoff status
-- ---------------------------------------------------------------------------
-- Only the DECLARATION lives here. "This sheet has measurements" is derived from
-- drawing_markups and must stay derived — a cached copy would go stale the first
-- time someone deleted a markup, and the whole point of this table is to be
-- trusted when it says a sheet was handled.
--
-- Scoped the same way conditions are (project XOR house plan version), because a
-- plan-version takeoff measures against some lot's sheets and its coverage is a
-- different question from that lot project's own takeoff.

create table if not exists public.takeoff_sheet_status (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  house_plan_version_id uuid references public.house_plan_versions(id) on delete cascade,
  drawing_sheet_id uuid not null references public.drawing_sheets(id) on delete cascade,
  -- 'complete'       — measured everything on this sheet that matters.
  -- 'not_applicable' — nothing on this sheet is takeoff-able (schedules, notes).
  status text not null check (status in ('complete', 'not_applicable')),
  note text,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint takeoff_sheet_status_single_home check (
    num_nonnulls(project_id, house_plan_version_id) = 1
  )
);

-- One declaration per sheet per scope. Two partial indexes rather than one over
-- nullable columns, since NULLs do not collide in a unique index.
create unique index if not exists takeoff_sheet_status_project_key
  on public.takeoff_sheet_status (org_id, project_id, drawing_sheet_id)
  where project_id is not null;
create unique index if not exists takeoff_sheet_status_plan_key
  on public.takeoff_sheet_status (org_id, house_plan_version_id, drawing_sheet_id)
  where house_plan_version_id is not null;

drop trigger if exists takeoff_sheet_status_set_updated_at on public.takeoff_sheet_status;
create trigger takeoff_sheet_status_set_updated_at
  before update on public.takeoff_sheet_status
  for each row execute function public.tg_set_updated_at();

alter table public.takeoff_sheet_status enable row level security;

drop policy if exists takeoff_sheet_status_read on public.takeoff_sheet_status;
create policy takeoff_sheet_status_read on public.takeoff_sheet_status
  for select to authenticated
  using (public.has_org_permission(org_id, 'takeoff.read'));

drop policy if exists takeoff_sheet_status_insert on public.takeoff_sheet_status;
create policy takeoff_sheet_status_insert on public.takeoff_sheet_status
  for insert to authenticated
  with check (
    public.has_org_permission(org_id, 'takeoff.write')
    and (updated_by is null or updated_by = (select auth.uid()))
  );

drop policy if exists takeoff_sheet_status_update on public.takeoff_sheet_status;
create policy takeoff_sheet_status_update on public.takeoff_sheet_status
  for update to authenticated
  using (public.has_org_permission(org_id, 'takeoff.write'))
  with check (public.has_org_permission(org_id, 'takeoff.write'));

drop policy if exists takeoff_sheet_status_delete on public.takeoff_sheet_status;
create policy takeoff_sheet_status_delete on public.takeoff_sheet_status
  for delete to authenticated
  using (public.has_org_permission(org_id, 'takeoff.write'));

grant select, insert, update, delete on table public.takeoff_sheet_status to authenticated;
grant all on table public.takeoff_sheet_status to service_role;

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------
-- No new permission keys. Both new tables are takeoff surfaces and ride
-- takeoff.read / takeoff.write, which migration 20260728150000 already granted
-- to org_owner, org_admin, org_office_admin, org_project_lead, pm, org_estimator
-- and org_purchasing_manager (write), and to every role that can open a drawing
-- (read). A template library the estimator cannot edit would be useless, and one
-- a viewer could edit would be a hole.

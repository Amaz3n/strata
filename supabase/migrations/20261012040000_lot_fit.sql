-- Does the house fit the lot.
--
-- A plan was pinned to a lot, priced into an agreement and released to start
-- without anything asking whether the house fits the dirt. The rule itself is
-- pure (lib/land/lot-fit.ts); this migration stores what it reads:
--
-- 1. house_plans.footprint_width_ft / footprint_depth_ft: the building's
--    outside dimensions, and drawn_swing: the garage handing the plan is drawn
--    in, which is the only handing an elevation that is not swing-applicable
--    can be built in.
-- 2. communities.setbacks: the community's default setbacks, stored with the
--    same snake_case keys a lot's own overrides use inside lots.dimensions
--    (front_setback_ft, rear_setback_ft, side_setback_ft,
--    corner_side_setback_ft) so one reader serves both. A lot's dimensions,
--    corner flag and setback overrides stay in lots.dimensions
--    (lib/land/lot-dimensions.ts owns that shape); nothing queries them in SQL.
-- 3. lot_allowed_elevations: architectural control. A lot with no rows takes
--    any elevation; a lot with rows takes only those.
-- 4. lot_fit_overrides: the explicit, evidenced exception. One row speaks for
--    one plan, elevation and handing on one lot, and for the violations it
--    was recorded against; a different configuration, or a new violation, is
--    not covered. Recorded by a holder of lot.fit_override with a reason and
--    an evidence file; never edited, only revoked.
-- 5. RBAC: lot.fit_override, granted to every role that holds plan.release
--    (the same authority that may override a community's plan offering).

-- ---------------------------------------------------------------------------
-- 1. Plan footprint and drawn handing.
-- ---------------------------------------------------------------------------

alter table public.house_plans
  add column if not exists footprint_width_ft numeric,
  add column if not exists footprint_depth_ft numeric,
  add column if not exists drawn_swing text;

alter table public.house_plans
  drop constraint if exists house_plans_footprint_width_check,
  drop constraint if exists house_plans_footprint_depth_check,
  drop constraint if exists house_plans_drawn_swing_check;
alter table public.house_plans
  add constraint house_plans_footprint_width_check check (footprint_width_ft is null or footprint_width_ft > 0),
  add constraint house_plans_footprint_depth_check check (footprint_depth_ft is null or footprint_depth_ft > 0),
  add constraint house_plans_drawn_swing_check check (drawn_swing is null or drawn_swing in ('left', 'right'));

comment on column public.house_plans.footprint_width_ft is
  'Outside width of the building in feet, measured across the lot frontage. Read by the lot fit rule (lib/land/lot-fit.ts).';
comment on column public.house_plans.footprint_depth_ft is
  'Outside depth of the building in feet, measured front to rear. Read by the lot fit rule.';
comment on column public.house_plans.drawn_swing is
  'The garage handing the plan is drawn in. An elevation that is not swing-applicable can be built only in this handing.';

-- ---------------------------------------------------------------------------
-- 2. Community default setbacks.
-- ---------------------------------------------------------------------------

alter table public.communities
  add column if not exists setbacks jsonb not null default '{}'::jsonb;

alter table public.communities drop constraint if exists communities_setbacks_object_check;
alter table public.communities
  add constraint communities_setbacks_object_check check (jsonb_typeof(setbacks) = 'object');

comment on column public.communities.setbacks is
  'Default setbacks in feet (front_setback_ft, rear_setback_ft, side_setback_ft, corner_side_setback_ft). A lot''s own value in lots.dimensions wins over each one.';

-- ---------------------------------------------------------------------------
-- Both tables below name a lot, a plan, an elevation and (for overrides) an
-- evidence file. Plain foreign keys prove each exists; this proves they all
-- belong to the row's organization and that the elevation is the plan's.
-- ---------------------------------------------------------------------------

create or replace function public.guard_lot_fit_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  elevation_plan uuid;
begin
  if not exists (select 1 from public.lots l where l.id = new.lot_id and l.org_id = new.org_id) then
    raise exception 'The lot does not belong to this organization' using errcode = '23503';
  end if;
  select e.house_plan_id into elevation_plan
  from public.house_plan_elevations e
  where e.id = new.house_plan_elevation_id and e.org_id = new.org_id;
  if new.house_plan_elevation_id is not null and elevation_plan is null then
    raise exception 'The elevation does not belong to this organization' using errcode = '23503';
  end if;
  if tg_table_name = 'lot_fit_overrides' then
    if not exists (select 1 from public.house_plans p where p.id = new.house_plan_id and p.org_id = new.org_id) then
      raise exception 'The plan does not belong to this organization' using errcode = '23503';
    end if;
    if elevation_plan is not null and elevation_plan <> new.house_plan_id then
      raise exception 'The elevation does not belong to the plan' using errcode = '23503';
    end if;
    if not exists (select 1 from public.files f where f.id = new.evidence_file_id and f.org_id = new.org_id) then
      raise exception 'The evidence file does not belong to this organization' using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_lot_fit_references() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Allowed elevations per lot.
-- ---------------------------------------------------------------------------

create table if not exists public.lot_allowed_elevations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  lot_id uuid not null references public.lots(id) on delete cascade,
  house_plan_elevation_id uuid not null references public.house_plan_elevations(id) on delete cascade,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  unique (lot_id, house_plan_elevation_id)
);

create index if not exists lot_allowed_elevations_org_lot_idx
  on public.lot_allowed_elevations (org_id, lot_id);
create index if not exists lot_allowed_elevations_elevation_idx
  on public.lot_allowed_elevations (house_plan_elevation_id);

comment on table public.lot_allowed_elevations is
  'Architectural control: the elevations a lot may be built in. No rows means any elevation. Written by setLotAllowedElevations (lib/services/lot-fit.ts).';

drop trigger if exists lot_allowed_elevations_references on public.lot_allowed_elevations;
create trigger lot_allowed_elevations_references
  before insert or update on public.lot_allowed_elevations
  for each row execute function public.guard_lot_fit_references();

alter table public.lot_allowed_elevations enable row level security;

drop policy if exists lot_allowed_elevations_read on public.lot_allowed_elevations;
create policy lot_allowed_elevations_read on public.lot_allowed_elevations
  for select
  to authenticated
  using (public.is_org_member(org_id));

drop policy if exists lot_allowed_elevations_insert on public.lot_allowed_elevations;
create policy lot_allowed_elevations_insert on public.lot_allowed_elevations
  for insert
  to authenticated
  with check (public.has_org_permission(org_id, 'lot.write'));

drop policy if exists lot_allowed_elevations_delete on public.lot_allowed_elevations;
create policy lot_allowed_elevations_delete on public.lot_allowed_elevations
  for delete
  to authenticated
  using (public.has_org_permission(org_id, 'lot.write'));

drop policy if exists lot_allowed_elevations_division_scope on public.lot_allowed_elevations;
create policy lot_allowed_elevations_division_scope on public.lot_allowed_elevations
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or lot_id in (select public.member_reachable_lot_ids())
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or lot_id in (select public.member_reachable_lot_ids())
  );

revoke all on table public.lot_allowed_elevations from anon, authenticated;
grant select, insert, delete on table public.lot_allowed_elevations to authenticated;
grant all on table public.lot_allowed_elevations to service_role;

-- ---------------------------------------------------------------------------
-- 4. Fit overrides.
-- ---------------------------------------------------------------------------

create table if not exists public.lot_fit_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  lot_id uuid not null references public.lots(id) on delete cascade,
  house_plan_id uuid not null references public.house_plans(id) on delete cascade,
  house_plan_elevation_id uuid references public.house_plan_elevations(id) on delete cascade,
  swing text,
  violations jsonb not null,
  reason text not null,
  evidence_file_id uuid not null references public.files(id),
  approved_by uuid not null references public.app_users(id),
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lot_fit_overrides_swing_check check (swing is null or swing in ('left', 'right')),
  constraint lot_fit_overrides_violations_check check (jsonb_typeof(violations) = 'array' and jsonb_array_length(violations) > 0),
  constraint lot_fit_overrides_reason_check check (length(btrim(reason)) >= 10),
  constraint lot_fit_overrides_revocation_check check ((revoked_at is null) = (revoked_by is null))
);

-- One live override per configuration of a lot; recording a new one revokes the old.
create unique index if not exists lot_fit_overrides_active_key
  on public.lot_fit_overrides (lot_id, house_plan_id, house_plan_elevation_id, swing) nulls not distinct
  where revoked_at is null;
create index if not exists lot_fit_overrides_org_lot_idx
  on public.lot_fit_overrides (org_id, lot_id) where revoked_at is null;
create index if not exists lot_fit_overrides_plan_idx on public.lot_fit_overrides (house_plan_id);
create index if not exists lot_fit_overrides_elevation_idx
  on public.lot_fit_overrides (house_plan_elevation_id) where house_plan_elevation_id is not null;
create index if not exists lot_fit_overrides_evidence_idx on public.lot_fit_overrides (evidence_file_id);
create index if not exists lot_fit_overrides_approved_by_idx on public.lot_fit_overrides (approved_by);
create index if not exists lot_fit_overrides_revoked_by_idx
  on public.lot_fit_overrides (revoked_by) where revoked_by is not null;

comment on table public.lot_fit_overrides is
  'An evidenced exception letting one plan, elevation and handing stand on a lot it does not fit. Covers only the violations it was recorded against. Never edited; revoked by setting revoked_at/revoked_by.';

drop trigger if exists lot_fit_overrides_references on public.lot_fit_overrides;
create trigger lot_fit_overrides_references
  before insert on public.lot_fit_overrides
  for each row execute function public.guard_lot_fit_references();

-- What was approved stays approved: the only change is revocation, once.
create or replace function public.guard_lot_fit_override_revocation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null
     or new.revoked_at is null
     or (to_jsonb(new) - array['revoked_at', 'revoked_by', 'updated_at'])
        is distinct from (to_jsonb(old) - array['revoked_at', 'revoked_by', 'updated_at'])
  then
    raise exception 'A lot fit override cannot be changed, only revoked once' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_lot_fit_override_revocation() from public, anon, authenticated;

drop trigger if exists lot_fit_overrides_revocation_only on public.lot_fit_overrides;
create trigger lot_fit_overrides_revocation_only
  before update on public.lot_fit_overrides
  for each row execute function public.guard_lot_fit_override_revocation();

drop trigger if exists lot_fit_overrides_set_updated_at on public.lot_fit_overrides;
create trigger lot_fit_overrides_set_updated_at
  before update on public.lot_fit_overrides
  for each row execute function public.tg_set_updated_at();

alter table public.lot_fit_overrides enable row level security;

drop policy if exists lot_fit_overrides_read on public.lot_fit_overrides;
create policy lot_fit_overrides_read on public.lot_fit_overrides
  for select
  to authenticated
  using (public.is_org_member(org_id));

drop policy if exists lot_fit_overrides_insert on public.lot_fit_overrides;
create policy lot_fit_overrides_insert on public.lot_fit_overrides
  for insert
  to authenticated
  with check (
    public.has_org_permission(org_id, 'lot.fit_override')
    and approved_by = (select auth.uid())
    and revoked_at is null
  );

drop policy if exists lot_fit_overrides_revoke on public.lot_fit_overrides;
create policy lot_fit_overrides_revoke on public.lot_fit_overrides
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'lot.fit_override'))
  with check (
    public.has_org_permission(org_id, 'lot.fit_override')
    and revoked_by = (select auth.uid())
  );

drop policy if exists lot_fit_overrides_division_scope on public.lot_fit_overrides;
create policy lot_fit_overrides_division_scope on public.lot_fit_overrides
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or lot_id in (select public.member_reachable_lot_ids())
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or lot_id in (select public.member_reachable_lot_ids())
  );

revoke all on table public.lot_fit_overrides from anon, authenticated;
grant select, insert, update on table public.lot_fit_overrides to authenticated;
grant all on table public.lot_fit_overrides to service_role;

-- ---------------------------------------------------------------------------
-- 5. RBAC.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('lot.fit_override', 'Record and revoke evidenced exceptions that let a home stand on a lot it does not fit')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'lot.fit_override'
from public.role_permissions rp
where rp.permission_key = 'plan.release'
on conflict (role_id, permission_key) do nothing;

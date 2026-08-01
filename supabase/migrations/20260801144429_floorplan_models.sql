-- Floorplan models: the walkable 3D interpretation of a plan version's sheets.
--
-- Interpretation is expensive and its accuracy comes from human corrections,
-- so the result is stored once at the PLAN VERSION — not per project, not per
-- lot. One interpretation of Plan 2340 rev C serves every house built to it,
-- which is the whole leverage of doing this for a production builder.
--
-- `model` is the FloorplanModel document (lib/drawings/floorplan-model.ts):
-- walls, openings, rooms and confidence in real-world feet. It is geometry
-- only — no pricing, no buyer data — which is what lets the same document be
-- served to a buyer portal and a public community site unchanged.
--
-- One row per plan version, deliberately. The gameplan sketched a
-- (version, algo_version) key, but every surface asks "the model for this
-- version" and a second row would make that ambiguous — worse, it would let a
-- corrected draft and a fresh re-interpretation both claim to be current.
-- `algo_version` stays a column so the workbench can offer "re-interpret with
-- the newer algorithm" and say out loud how many corrections that discards.

create table if not exists public.floorplan_models (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  house_plan_version_id uuid not null references public.house_plan_versions(id) on delete cascade,
  status text not null default 'processing'
    check (status in ('processing', 'draft', 'published', 'failed')),
  -- Null until the interpretation job finishes, and on failure.
  model jsonb check (model is null or jsonb_typeof(model) = 'object'),
  -- Interpretation algorithm revision, so a stale model is recognisable
  -- without re-reading its geometry.
  algo_version integer not null default 1,
  -- Aggregate 0..1 score from the model's own per-element confidence.
  confidence numeric(4, 3),
  -- Sheets that became levels. Zero with status 'failed' means none matched.
  level_count integer not null default 0,
  -- Human corrections applied since the last interpretation run. The number
  -- the re-interpret confirmation quotes back.
  correction_count integer not null default 0,
  error text,
  interpreted_at timestamptz,
  published_at timestamptz,
  published_by uuid references public.app_users(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint floorplan_models_version_unique unique (house_plan_version_id)
);

create index if not exists floorplan_models_org_status_idx
  on public.floorplan_models (org_id, status, updated_at desc);
create index if not exists floorplan_models_org_version_idx
  on public.floorplan_models (org_id, house_plan_version_id);
create index if not exists floorplan_models_published_idx
  on public.floorplan_models (org_id, house_plan_version_id)
  where status = 'published';

drop trigger if exists floorplan_models_set_updated_at on public.floorplan_models;
create trigger floorplan_models_set_updated_at before update on public.floorplan_models
  for each row execute function public.tg_set_updated_at();

alter table public.floorplan_models enable row level security;

-- Reuses the house-plans RBAC keys: a model is an attribute of a plan version,
-- and anyone who can see the plan library can see its 3D model.
create policy floorplan_models_read on public.floorplan_models
  for select to authenticated
  using (public.has_org_permission(org_id, 'plan.read'));

create policy floorplan_models_insert on public.floorplan_models
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'plan.write'));

create policy floorplan_models_update on public.floorplan_models
  for update to authenticated
  using (public.has_org_permission(org_id, 'plan.write'))
  with check (public.has_org_permission(org_id, 'plan.write'));

create policy floorplan_models_delete on public.floorplan_models
  for delete to authenticated
  using (public.has_org_permission(org_id, 'plan.write'));

grant select, insert, update, delete on table public.floorplan_models to authenticated;
grant all on table public.floorplan_models to service_role;

comment on table public.floorplan_models is
  'Interpreted 3D model of a house plan version''s floorplan sheets. Geometry only.';

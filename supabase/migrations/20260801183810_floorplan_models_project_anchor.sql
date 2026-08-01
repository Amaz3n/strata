-- Floorplan models for custom homes: a second anchor.
--
-- The first cut anchored every model to a house plan version, which is right
-- for production — one interpretation of Plan 2340 serves sixty lots — and
-- impossible for residential, where there is no plan version at all. A custom
-- home's floorplan sheets live on the PROJECT's own drawing set, so that is
-- what its model hangs off.
--
-- Exactly one anchor is set, enforced below rather than by convention: a row
-- carrying both would make "the model for this house" ambiguous the moment a
-- production project (whose drawings ARE the plan set) got one of each.
--
-- `drawing_revision_id` records which issue of the drawings was interpreted.
-- A custom home's drawings are revised during construction in a way a released
-- plan version never is, so a re-issued set has to be able to mark the model
-- stale — the same job `algo_version` does for the interpreter itself.

alter table public.floorplan_models
  alter column house_plan_version_id drop not null;

alter table public.floorplan_models
  add column if not exists project_id uuid references public.projects(id) on delete cascade,
  add column if not exists drawing_revision_id uuid references public.drawing_revisions(id) on delete set null;

alter table public.floorplan_models
  drop constraint if exists floorplan_models_one_anchor;
alter table public.floorplan_models
  add constraint floorplan_models_one_anchor check (
    (house_plan_version_id is not null and project_id is null)
    or (house_plan_version_id is null and project_id is not null)
  );

-- The plan-version key stays a table constraint; Postgres treats NULLs as
-- distinct, so residential rows never collide on it. The project key needs a
-- partial index for the same reason.
create unique index if not exists floorplan_models_project_unique
  on public.floorplan_models (project_id)
  where project_id is not null;

create index if not exists floorplan_models_org_project_idx
  on public.floorplan_models (org_id, project_id)
  where project_id is not null;

comment on column public.floorplan_models.project_id is
  'Residential/commercial anchor: the project whose own drawing set was interpreted. Mutually exclusive with house_plan_version_id.';
comment on column public.floorplan_models.drawing_revision_id is
  'Which drawing revision was interpreted, so a re-issued set can mark the model stale.';

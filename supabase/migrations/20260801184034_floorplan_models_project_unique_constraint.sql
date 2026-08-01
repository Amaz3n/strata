-- Make the project anchor's uniqueness inferable by ON CONFLICT.
--
-- The previous migration expressed "one model per project" as a PARTIAL unique
-- index (`where project_id is not null`). That enforces the right thing, but
-- Postgres will not infer a partial index from a bare `on conflict (project_id)`
-- — the statement would have to repeat the index predicate, which PostgREST
-- does not emit. So every residential interpretation failed with "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification" while
-- the production path, which has always had a plain unique CONSTRAINT, worked.
--
-- The predicate was never needed: unique indexes treat NULLs as distinct, so a
-- plain `unique (project_id)` still permits the unlimited NULL rows the
-- plan-anchored records carry. This makes the two anchors structurally
-- identical — do not "optimise" either one back into a partial index.

drop index if exists public.floorplan_models_project_unique;

alter table public.floorplan_models
  drop constraint if exists floorplan_models_project_unique;
alter table public.floorplan_models
  add constraint floorplan_models_project_unique unique (project_id);

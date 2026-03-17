-- Speed up interactive project lookups in command search.
create extension if not exists pg_trgm;

create index if not exists idx_projects_name_trgm
  on public.projects using gin (name gin_trgm_ops);

create index if not exists idx_projects_org_updated_at
  on public.projects (org_id, updated_at desc);

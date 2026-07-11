create table if not exists public.project_module_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  module_key text not null check (module_key ~ '^[a-z][a-z0-9_-]*$'),
  enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_module_overrides_project_module_unique unique (project_id, module_key)
);

create index if not exists project_module_overrides_org_project_idx
  on public.project_module_overrides (org_id, project_id);

drop trigger if exists project_module_overrides_set_updated_at on public.project_module_overrides;
create trigger project_module_overrides_set_updated_at
  before update on public.project_module_overrides
  for each row execute function public.tg_set_updated_at();

alter table public.project_module_overrides enable row level security;

drop policy if exists project_module_overrides_org_access on public.project_module_overrides;
create policy project_module_overrides_org_access
  on public.project_module_overrides
  for all
  to authenticated
  using (public.is_org_member(org_id))
  with check (
    public.is_org_member(org_id)
    and exists (
      select 1
      from public.projects
      where projects.id = project_module_overrides.project_id
        and projects.org_id = project_module_overrides.org_id
    )
  );

grant all on table public.project_module_overrides to authenticated, service_role;

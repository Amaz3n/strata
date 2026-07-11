-- Workstream 04 (Phase 5): managed per-project distribution lists.
-- Members (contacts or internal users) get copied on RFI and submittal emails;
-- workstream 05's transmittals reuse this as a recipient source.

create table if not exists public.project_distribution_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  scope text not null check (scope in ('rfis', 'submittals', 'all')),
  contact_id uuid references public.contacts(id) on delete cascade,
  user_id uuid references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (contact_id is not null or user_id is not null),
  unique (project_id, scope, contact_id, user_id)
);

create index if not exists project_distribution_members_org_project_idx
  on public.project_distribution_members (org_id, project_id);

alter table public.project_distribution_members enable row level security;

drop policy if exists project_distribution_members_org_access on public.project_distribution_members;
create policy project_distribution_members_org_access
  on public.project_distribution_members
  for all
  to authenticated
  using (public.is_org_member(org_id))
  with check (
    public.is_org_member(org_id)
    and exists (
      select 1
      from public.projects
      where projects.id = project_distribution_members.project_id
        and projects.org_id = project_distribution_members.org_id
    )
  );

grant all on table public.project_distribution_members to authenticated, service_role;

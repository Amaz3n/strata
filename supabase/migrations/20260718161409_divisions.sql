create table public.divisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  code text,
  region text,
  settings jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create index divisions_org_idx on public.divisions (org_id);
create index divisions_org_active_idx on public.divisions (org_id, name) where archived_at is null;

drop trigger if exists divisions_set_updated_at on public.divisions;
create trigger divisions_set_updated_at before update on public.divisions
  for each row execute function public.tg_set_updated_at();

alter table public.divisions enable row level security;
create policy divisions_org_access on public.divisions for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant all on table public.divisions to authenticated, service_role;

alter table public.projects
  add column if not exists division_id uuid references public.divisions(id) on delete set null;
create index if not exists projects_division_idx on public.projects (org_id, division_id)
  where division_id is not null;

comment on table public.divisions is
  'Optional org scoping layer for regions, brands, reporting, RBAC visibility, and accounting-entity mapping. RLS remains org-based.';

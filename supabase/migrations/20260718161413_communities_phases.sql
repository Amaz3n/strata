create table public.communities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  division_id uuid references public.divisions(id) on delete set null,
  name text not null,
  code text,
  status text not null default 'active'
    check (status in ('planning', 'active', 'sold_out', 'closed')),
  address text,
  city text,
  state text,
  postal_code text,
  description text,
  planned_lot_count integer check (planned_lot_count is null or planned_lot_count >= 0),
  settings jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create index communities_org_idx on public.communities (org_id, status);
create index communities_division_idx on public.communities (org_id, division_id)
  where division_id is not null;

create table public.community_phases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  name text not null,
  phase_number integer not null check (phase_number > 0),
  status text not null default 'planned'
    check (status in ('planned', 'open', 'built_out')),
  target_open_date date,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, phase_number)
);

create index community_phases_org_idx on public.community_phases (org_id, community_id);

drop trigger if exists communities_set_updated_at on public.communities;
create trigger communities_set_updated_at before update on public.communities
  for each row execute function public.tg_set_updated_at();
drop trigger if exists community_phases_set_updated_at on public.community_phases;
create trigger community_phases_set_updated_at before update on public.community_phases
  for each row execute function public.tg_set_updated_at();

alter table public.communities enable row level security;
alter table public.community_phases enable row level security;
create policy communities_org_access on public.communities for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy community_phases_org_access on public.community_phases for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant all on table public.communities, public.community_phases to authenticated, service_role;

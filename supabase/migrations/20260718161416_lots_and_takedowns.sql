create table public.lot_takedowns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  community_phase_id uuid references public.community_phases(id) on delete set null,
  name text not null,
  scheduled_date date,
  actual_date date,
  lot_count integer not null default 0 check (lot_count >= 0),
  price_per_lot_cents bigint check (price_per_lot_cents is null or price_per_lot_cents >= 0),
  deposit_cents bigint not null default 0 check (deposit_cents >= 0),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'closed', 'cancelled')),
  seller_company_id uuid references public.companies(id) on delete set null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lot_takedowns_org_idx on public.lot_takedowns (org_id, community_id, status);

create table public.lots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  community_phase_id uuid references public.community_phases(id) on delete set null,
  division_id uuid references public.divisions(id) on delete set null,
  lot_number text not null,
  block text,
  status text not null default 'controlled'
    check (status in ('controlled', 'owned', 'developed', 'assigned', 'started', 'closed')),
  address text,
  dimensions jsonb not null default '{}'::jsonb,
  swing text not null default 'either' check (swing in ('left', 'right', 'either')),
  premium_cents bigint not null default 0 check (premium_cents >= 0),
  cost_basis_cents bigint check (cost_basis_cents is null or cost_basis_cents >= 0),
  takedown_id uuid references public.lot_takedowns(id) on delete set null,
  acquired_date date,
  project_id uuid references public.projects(id) on delete set null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (community_id, lot_number, block)
);

create index lots_org_community_idx on public.lots (org_id, community_id, status);
create index lots_project_idx on public.lots (project_id) where project_id is not null;
create unique index lots_project_unique on public.lots (project_id) where project_id is not null;
create index lots_takedown_idx on public.lots (takedown_id) where takedown_id is not null;
create index lots_phase_idx on public.lots (org_id, community_phase_id) where community_phase_id is not null;

drop trigger if exists lot_takedowns_set_updated_at on public.lot_takedowns;
create trigger lot_takedowns_set_updated_at before update on public.lot_takedowns
  for each row execute function public.tg_set_updated_at();
drop trigger if exists lots_set_updated_at on public.lots;
create trigger lots_set_updated_at before update on public.lots
  for each row execute function public.tg_set_updated_at();

alter table public.lot_takedowns enable row level security;
alter table public.lots enable row level security;
create policy lot_takedowns_org_access on public.lot_takedowns for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy lots_org_access on public.lots for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant all on table public.lot_takedowns, public.lots to authenticated, service_role;

create or replace function public.get_community_lot_status_counts(check_org_id uuid)
returns table (community_id uuid, status text, lot_count bigint)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select l.community_id, l.status, count(*)::bigint
  from public.lots l
  where l.org_id = check_org_id
  group by l.community_id, l.status;
$$;
grant execute on function public.get_community_lot_status_counts(uuid) to authenticated, service_role;

comment on table public.lots is
  'Production land records. Lots may exist before a project; project_id links the eventual house/job at start release.';

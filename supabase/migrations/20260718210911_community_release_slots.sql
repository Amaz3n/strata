-- Workstream 05 phase 3: materialized weekly even-flow targets.

create table public.community_release_slots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid not null references public.communities(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  target_starts integer not null default 0 check (target_starts between 0 and 20),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, week_start)
);

create index community_release_slots_org_idx
  on public.community_release_slots (org_id, community_id, week_start);

create trigger community_release_slots_set_updated_at
  before update on public.community_release_slots
  for each row execute function public.tg_set_updated_at();

alter table public.community_release_slots enable row level security;
create policy community_release_slots_org_access on public.community_release_slots
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

grant select, insert, update, delete on public.community_release_slots to authenticated;
grant all on public.community_release_slots to service_role;

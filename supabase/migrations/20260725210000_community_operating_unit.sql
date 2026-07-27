-- Community as an operating unit: who is assigned to it, how much traffic it
-- takes, and the pace it is underwritten to. Backs the community board's
-- pace-vs-required metric and the assignment-defaulted community lens.

set local lock_timeout = '3s';

alter table public.communities
  add column if not exists target_absorption_per_month numeric(6,2);

comment on column public.communities.target_absorption_per_month is
  'Net sales per month the community is underwritten to. Drives pace vs required on the community board; null means pace is derived from remaining lots and the sell-out horizon.';

-- Who works this community. A person can hold more than one role in a
-- community (small builders double up), so the key includes the role.
create table if not exists public.community_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  user_id uuid not null,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.community_assignments
  drop constraint if exists community_assignments_role_check;
alter table public.community_assignments
  add constraint community_assignments_role_check
  check (role in ('sales', 'superintendent', 'closing', 'warranty', 'land'));

create unique index if not exists community_assignments_unique_idx
  on public.community_assignments (community_id, user_id, role);
create index if not exists community_assignments_user_idx
  on public.community_assignments (org_id, user_id);
create index if not exists community_assignments_community_idx
  on public.community_assignments (community_id);

alter table public.community_assignments enable row level security;
drop policy if exists community_assignments_org_access on public.community_assignments;
create policy community_assignments_org_access on public.community_assignments
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
grant all on table public.community_assignments to authenticated, service_role;

comment on table public.community_assignments is
  'Staff assigned to a community by role. Defaults the ambient community lens and names the team on the community workbench. A convenience scope, not a security boundary — division scope remains the enforcement layer.';

-- Traffic is the input to absorption. Without it there is no conversion rate
-- and no honest answer to "is this community selling fast enough".
create table if not exists public.community_traffic (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  logged_date date not null,
  walk_ins integer not null default 0,
  appointments integer not null default 0,
  web_inquiries integer not null default 0,
  notes text,
  recorded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.community_traffic
  drop constraint if exists community_traffic_counts_check;
alter table public.community_traffic
  add constraint community_traffic_counts_check
  check (walk_ins >= 0 and appointments >= 0 and web_inquiries >= 0);

create unique index if not exists community_traffic_day_idx
  on public.community_traffic (community_id, logged_date);
create index if not exists community_traffic_org_date_idx
  on public.community_traffic (org_id, logged_date desc);

alter table public.community_traffic enable row level security;
drop policy if exists community_traffic_org_access on public.community_traffic;
create policy community_traffic_org_access on public.community_traffic
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
grant all on table public.community_traffic to authenticated, service_role;

comment on table public.community_traffic is
  'Daily walk-in / appointment / web-inquiry counts per community. One row per community per day; the Monday traffic ritual reads the trailing weeks.';

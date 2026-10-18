-- Prospect-owned brief and decision register. Writes pass through the service
-- boundary, which checks org membership and linked-project/division access.
create unique index if not exists prospects_org_id_id_uidx on public.prospects(org_id, id);

create table public.precon_workspaces (
  prospect_id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  brief jsonb not null default '{}'::jsonb check (jsonb_typeof(brief) = 'object'),
  version integer not null default 1 check (version > 0),
  updated_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, prospect_id) references public.prospects(org_id, id) on delete cascade
);
create index precon_workspaces_org_prospect_idx on public.precon_workspaces(org_id, prospect_id);
create index precon_workspaces_updated_by_idx on public.precon_workspaces(updated_by);
create trigger precon_workspaces_updated_at before update on public.precon_workspaces
  for each row execute function public.tg_set_updated_at();

create table public.precon_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  prospect_id uuid not null,
  title text not null check (length(trim(title)) between 3 and 200),
  kind text not null check (kind in ('scope','client_decision','risk','procurement','readiness')),
  detail text not null default '',
  owner_user_id uuid references public.app_users(id),
  due_date date,
  cost_impact_cents bigint,
  blocks_agreement boolean not null default false,
  blocks_start boolean not null default false,
  status text not null default 'open' check (status in ('open','resolved','waived')),
  resolution text not null default '',
  resolved_by uuid references public.app_users(id),
  version integer not null default 1 check (version > 0),
  created_by uuid not null references public.app_users(id),
  updated_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, prospect_id) references public.prospects(org_id,id) on delete cascade,
  check (status = 'open' or (length(trim(resolution)) >= 3 and resolved_by is not null)),
  check (not (blocks_agreement or blocks_start) or owner_user_id is not null)
);
create index precon_decisions_org_prospect_idx on public.precon_decisions(org_id,prospect_id,created_at desc);
create index precon_decisions_owner_idx on public.precon_decisions(owner_user_id);
create index precon_decisions_created_by_idx on public.precon_decisions(created_by);
create index precon_decisions_updated_by_idx on public.precon_decisions(updated_by);
create index precon_decisions_resolved_by_idx on public.precon_decisions(resolved_by);
create trigger precon_decisions_updated_at before update on public.precon_decisions
  for each row execute function public.tg_set_updated_at();

alter table public.precon_workspaces enable row level security;
alter table public.precon_decisions enable row level security;
revoke all on public.precon_workspaces, public.precon_decisions from public, anon, authenticated;
grant all on public.precon_workspaces, public.precon_decisions to service_role;
comment on table public.precon_workspaces is 'Prospect aggregate: org.read/org.member plus linked project authorization enforced by precon-workspace service. No direct Data API access.';
comment on table public.precon_decisions is 'Audited decision register owned by a prospect. Closed items retain resolution and actor; no delete action.';

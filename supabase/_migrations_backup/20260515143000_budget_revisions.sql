-- Durable budget revisions posted from approved change orders.

create table if not exists public.budget_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  change_order_id uuid references public.change_orders(id) on delete set null,
  revision_type text not null default 'change_order',
  status text not null default 'posted',
  title text,
  total_cents integer not null default 0,
  posted_by uuid references public.app_users(id) on delete set null,
  posted_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.budget_revision_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  budget_revision_id uuid not null references public.budget_revisions(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  change_order_line_id uuid references public.change_order_lines(id) on delete set null,
  description text,
  amount_cents integer not null default 0,
  allowance_draw_cents integer not null default 0,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists budget_revisions_change_order_unique
  on public.budget_revisions(org_id, change_order_id);

create index if not exists budget_revisions_project_idx on public.budget_revisions(project_id);
create index if not exists budget_revision_lines_revision_idx on public.budget_revision_lines(budget_revision_id);
create index if not exists budget_revision_lines_cost_code_idx on public.budget_revision_lines(cost_code_id);

drop trigger if exists budget_revisions_updated_at on public.budget_revisions;
create trigger budget_revisions_updated_at
before update on public.budget_revisions
for each row execute function public.tg_set_updated_at();

alter table public.budget_revisions enable row level security;
alter table public.budget_revision_lines enable row level security;

drop policy if exists budget_revisions_access on public.budget_revisions;
create policy budget_revisions_access on public.budget_revisions
  for all using (auth.role() = 'service_role' or public.is_org_member(org_id))
  with check (auth.role() = 'service_role' or public.is_org_member(org_id));

drop policy if exists budget_revision_lines_access on public.budget_revision_lines;
create policy budget_revision_lines_access on public.budget_revision_lines
  for all using (auth.role() = 'service_role' or public.is_org_member(org_id))
  with check (auth.role() = 'service_role' or public.is_org_member(org_id));

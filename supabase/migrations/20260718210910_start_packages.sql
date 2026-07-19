-- Workstream 05 phases 1-2: start packages, gate state, and resumable release ledger.

create table public.start_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  lot_id uuid not null references public.lots(id),
  community_id uuid not null references public.communities(id),
  project_id uuid references public.projects(id),
  status text not null default 'open'
    check (status in ('open','ready','releasing','released','attention','cancelled')),
  is_financed boolean not null default false,
  target_week date check (target_week is null or extract(isodow from target_week) = 1),
  scheduled_start_date date,
  released_at timestamptz,
  released_by uuid references public.app_users(id),
  actual_start_date date,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index start_packages_active_lot_uniq on public.start_packages (lot_id)
  where status <> 'cancelled';
create index start_packages_lot_idx on public.start_packages (lot_id);
create index start_packages_org_board_idx
  on public.start_packages (org_id, community_id, status, target_week);
create index start_packages_project_idx on public.start_packages (project_id)
  where project_id is not null;
create index start_packages_released_by_idx on public.start_packages (released_by)
  where released_by is not null;
create index start_packages_released_idx on public.start_packages (org_id, actual_start_date)
  where status = 'released';

create table public.start_package_gates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  start_package_id uuid not null references public.start_packages(id) on delete cascade,
  gate_definition_id uuid not null references public.start_gate_definitions(id),
  status text not null default 'pending'
    check (status in ('pending','passed','waived','not_applicable')),
  passed_via text check (passed_via is null or passed_via in ('auto','attested','waived')),
  attested_by uuid references public.app_users(id),
  attested_at timestamptz,
  waived_reason text,
  notes text,
  evidence_file_id uuid references public.files(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (start_package_id, gate_definition_id),
  constraint start_package_gate_waiver_reason check (
    status <> 'waived' or length(btrim(coalesce(waived_reason, ''))) >= 10
  )
);

create index start_package_gates_pkg_idx
  on public.start_package_gates (org_id, start_package_id);
create index start_package_gates_definition_idx
  on public.start_package_gates (gate_definition_id);
create index start_package_gates_attested_by_idx
  on public.start_package_gates (attested_by) where attested_by is not null;
create index start_package_gates_evidence_idx
  on public.start_package_gates (evidence_file_id) where evidence_file_id is not null;

create table public.start_release_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  start_package_id uuid not null references public.start_packages(id) on delete cascade,
  step_key text not null check (step_key in (
    'project','budget','schedule','checklists','drawings','pos','notify_trades','finalize'
  )),
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed','skipped')),
  attempt integer not null default 0 check (attempt >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (start_package_id, step_key)
);

create index start_release_steps_attention_idx
  on public.start_release_steps (org_id, status) where status = 'failed';
create index start_release_steps_package_idx
  on public.start_release_steps (start_package_id, step_key);

create trigger start_packages_set_updated_at before update on public.start_packages
  for each row execute function public.tg_set_updated_at();
create trigger start_package_gates_set_updated_at before update on public.start_package_gates
  for each row execute function public.tg_set_updated_at();
create trigger start_release_steps_set_updated_at before update on public.start_release_steps
  for each row execute function public.tg_set_updated_at();

alter table public.start_packages enable row level security;
alter table public.start_package_gates enable row level security;
alter table public.start_release_steps enable row level security;
create policy start_packages_org_access on public.start_packages
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy start_package_gates_org_access on public.start_package_gates
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy start_release_steps_org_access on public.start_release_steps
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

grant select, insert, update, delete on public.start_packages,
  public.start_package_gates, public.start_release_steps to authenticated;
grant all on public.start_packages, public.start_package_gates,
  public.start_release_steps to service_role;

-- Phase 2 schema: cost codes, budget snapshots, variance alerts
-- Cost code enhancements
alter table cost_codes add column if not exists division text;
alter table cost_codes add column if not exists standard text;
alter table cost_codes add column if not exists unit text;
alter table cost_codes add column if not exists default_unit_cost_cents integer;
alter table cost_codes add column if not exists is_active boolean default true;

alter table cost_codes alter column is_active set default true;
update cost_codes set is_active = true where is_active is null;

alter table cost_codes alter column standard set default 'custom';
update cost_codes set standard = coalesce(standard, 'custom');

-- Cost code indexes across financial line items
create index if not exists invoice_lines_cost_code_idx on invoice_lines (cost_code_id);
create index if not exists change_order_lines_cost_code_idx on change_order_lines (cost_code_id);
create index if not exists commitment_lines_cost_code_idx on commitment_lines (cost_code_id);
create index if not exists bill_lines_cost_code_idx on bill_lines (cost_code_id);

-- Budget snapshots for trend tracking
create table if not exists budget_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  budget_id uuid not null references budgets(id) on delete cascade,
  snapshot_date date not null,
  total_budget_cents integer not null,
  total_committed_cents integer not null,
  total_actual_cents integer not null,
  total_invoiced_cents integer not null,
  variance_cents integer not null,
  margin_percent numeric,
  by_cost_code jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists budget_snapshots_org_idx on budget_snapshots (org_id);
create index if not exists budget_snapshots_project_date_idx on budget_snapshots (project_id, snapshot_date);
create unique index if not exists budget_snapshots_unique_idx on budget_snapshots (budget_id, snapshot_date);

alter table budget_snapshots enable row level security;

-- Variance alerts
create table if not exists variance_alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  budget_id uuid references budgets(id) on delete set null,
  cost_code_id uuid references cost_codes(id) on delete set null,
  alert_type text not null check (alert_type in ('threshold_exceeded', 'over_budget', 'margin_warning')),
  threshold_percent integer,
  current_percent integer,
  budget_cents integer,
  actual_cents integer,
  variance_cents integer,
  status text not null default 'active' check (status in ('active', 'acknowledged', 'resolved')),
  acknowledged_by uuid references app_users(id),
  acknowledged_at timestamptz,
  notified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists variance_alerts_org_idx on variance_alerts (org_id);
create index if not exists variance_alerts_project_idx on variance_alerts (project_id);
create index if not exists variance_alerts_status_idx on variance_alerts (status) where status = 'active';

alter table variance_alerts enable row level security;

-- RLS policies (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'budget_snapshots'
      AND policyname = 'budget_snapshots_access'
  ) THEN
    CREATE POLICY "budget_snapshots_access" ON budget_snapshots
      FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id))
      WITH CHECK (auth.role() = 'service_role' OR is_org_member(org_id));
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'variance_alerts'
      AND policyname = 'variance_alerts_access'
  ) THEN
    CREATE POLICY "variance_alerts_access" ON variance_alerts
      FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id))
      WITH CHECK (auth.role() = 'service_role' OR is_org_member(org_id));
  END IF;
END$$;
;

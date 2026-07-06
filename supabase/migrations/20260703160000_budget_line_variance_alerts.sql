alter table public.variance_alerts
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

alter table public.variance_alerts
  alter column cost_code_id drop not null;

create index if not exists variance_alerts_budget_line_idx
  on public.variance_alerts (budget_line_id)
  where budget_line_id is not null;

create index if not exists variance_alerts_active_budget_bucket_idx
  on public.variance_alerts (org_id, project_id, budget_line_id, alert_type)
  where status = 'active' and budget_line_id is not null;

create index if not exists variance_alerts_active_cost_code_idx
  on public.variance_alerts (org_id, project_id, cost_code_id, alert_type)
  where status = 'active' and cost_code_id is not null;

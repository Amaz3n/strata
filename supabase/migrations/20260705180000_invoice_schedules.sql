-- Recurring invoices: a schedule holds a frozen invoice template and generates a fresh
-- invoice each period via the /api/jobs/invoice-schedules cron.
create table if not exists public.invoice_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  source_invoice_id uuid references public.invoices(id) on delete set null,
  -- InvoiceInput-shaped template (no invoice_number/dates/status — those are set per run).
  template jsonb not null,
  frequency text not null check (frequency in ('weekly', 'monthly', 'quarterly')),
  next_run_on date not null,
  -- Preferred day of month for monthly/quarterly runs (clamped to month length).
  day_of_month int check (day_of_month between 1 and 31),
  auto_send boolean not null default false,
  recipient_email text,
  active boolean not null default true,
  last_run_at timestamptz,
  last_invoice_id uuid references public.invoices(id) on delete set null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invoice_schedules_org_idx on public.invoice_schedules (org_id);
create index if not exists invoice_schedules_due_idx on public.invoice_schedules (next_run_on) where active;

alter table public.invoice_schedules enable row level security;

create policy invoice_schedules_access on public.invoice_schedules
  for all
  using (
    (auth.role() = 'service_role')
    or (
      public.is_org_member(org_id)
      and ((project_id is null) or public.is_project_member(project_id) or public.is_org_admin_member(org_id))
    )
  )
  with check (
    (auth.role() = 'service_role')
    or (
      public.is_org_member(org_id)
      and ((project_id is null) or public.is_project_member(project_id) or public.is_org_admin_member(org_id))
    )
  );

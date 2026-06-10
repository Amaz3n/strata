-- Split expenses into multiple cost-allocation lines, mirroring vendor bill_lines.
-- One project_expenses row (one receipt, one QBO transaction) can now allocate its
-- total across several projects / cost codes / QBO accounts.

create table if not exists public.project_expense_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  expense_id uuid not null references public.project_expenses(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  description text,
  amount_cents integer not null,
  qbo_expense_account_id text,
  qbo_expense_account_name text,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_expense_lines_amount_cents_check check (amount_cents >= 0)
);

create index if not exists project_expense_lines_expense_idx on public.project_expense_lines using btree (expense_id);
create index if not exists project_expense_lines_org_idx on public.project_expense_lines using btree (org_id);
create index if not exists project_expense_lines_project_idx on public.project_expense_lines using btree (project_id);
create index if not exists project_expense_lines_cost_code_idx on public.project_expense_lines using btree (cost_code_id);

alter table public.project_expense_lines owner to postgres;
alter table public.project_expense_lines enable row level security;

-- Access mirrors the parent expense: org members who can see the expense's project,
-- plus the service role.
create policy "project_expense_lines_access" on public.project_expense_lines
  using (
    (auth.role() = 'service_role')
    or (
      public.is_org_member(org_id)
      and exists (
        select 1 from public.project_expenses pe
        where pe.id = project_expense_lines.expense_id
          and pe.org_id = project_expense_lines.org_id
          and (
            public.is_project_member(pe.project_id)
            or public.is_org_admin_member(project_expense_lines.org_id)
          )
      )
    )
  )
  with check (
    (auth.role() = 'service_role')
    or (
      public.is_org_member(org_id)
      and exists (
        select 1 from public.project_expenses pe
        where pe.id = project_expense_lines.expense_id
          and pe.org_id = project_expense_lines.org_id
          and (
            public.is_project_member(pe.project_id)
            or public.is_org_admin_member(project_expense_lines.org_id)
          )
      )
    )
  );

-- Allow the per-line ledger rows to identify their source.
alter table public.billable_costs
  drop constraint if exists billable_costs_source_type_check;
alter table public.billable_costs
  add constraint billable_costs_source_type_check
  check (source_type = any (array[
    'vendor_bill_line'::text,
    'project_expense'::text,
    'project_expense_line'::text,
    'time_entry'::text,
    'manual_adjustment'::text,
    'allowance_overage'::text
  ]));

alter table public.job_cost_entries
  drop constraint if exists job_cost_entries_source_type_check;
alter table public.job_cost_entries
  add constraint job_cost_entries_source_type_check
  check (source_type in (
    'vendor_bill_line',
    'project_expense',
    'project_expense_line',
    'time_entry',
    'manual_adjustment'
  ));

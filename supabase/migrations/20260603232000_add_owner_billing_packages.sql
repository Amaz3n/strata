-- Phase 5 financial ecosystem:
-- extend cost approval batches and add invoice backup package manifests.

create table if not exists public.cost_approval_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  token_hash text unique,
  status text not null default 'pending',
  billable_cost_ids uuid[] not null default '{}'::uuid[],
  time_entry_ids uuid[] not null default '{}'::uuid[],
  expires_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cost_approval_batches
  add column if not exists billing_period_id uuid references public.project_billing_periods(id) on delete set null,
  add column if not exists invoice_id uuid references public.invoices(id) on delete set null,
  add column if not exists name text,
  add column if not exists total_cost_cents integer not null default 0,
  add column if not exists total_markup_cents integer not null default 0,
  add column if not exists total_billable_cents integer not null default 0,
  add column if not exists requested_at timestamptz,
  add column if not exists due_at timestamptz,
  add column if not exists approved_by_name text,
  add column if not exists approved_by_email text,
  add column if not exists portal_token_id uuid references public.portal_access_tokens(id) on delete set null,
  add column if not exists snapshot jsonb not null default '{}'::jsonb,
  add column if not exists created_by uuid references public.app_users(id) on delete set null,
  add column if not exists updated_by uuid references public.app_users(id) on delete set null;

update public.cost_approval_batches
set name = coalesce(name, 'Cost approval batch ' || left(id::text, 8))
where name is null;

alter table public.cost_approval_batches
  alter column name set not null;

alter table public.cost_approval_batches
  drop constraint if exists cost_approval_batches_status_check;

alter table public.cost_approval_batches
  add constraint cost_approval_batches_status_check
  check (status in ('draft', 'ready', 'pending', 'sent', 'approved', 'rejected', 'expired', 'voided'));

create index if not exists cost_approval_batches_org_project_status_idx
  on public.cost_approval_batches (org_id, project_id, status);

create index if not exists cost_approval_batches_invoice_fk_idx
  on public.cost_approval_batches (invoice_id)
  where invoice_id is not null;

create index if not exists cost_approval_batches_billing_period_fk_idx
  on public.cost_approval_batches (billing_period_id)
  where billing_period_id is not null;

create index if not exists cost_approval_batches_portal_token_fk_idx
  on public.cost_approval_batches (portal_token_id)
  where portal_token_id is not null;

drop trigger if exists cost_approval_batches_set_updated_at on public.cost_approval_batches;
create trigger cost_approval_batches_set_updated_at
  before update on public.cost_approval_batches
  for each row
  execute function public.tg_set_updated_at();

alter table public.cost_approval_batches enable row level security;

drop policy if exists cost_approval_batches_access on public.cost_approval_batches;
create policy cost_approval_batches_access
  on public.cost_approval_batches
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.cost_approval_batches to authenticated, service_role;

create table if not exists public.invoice_backup_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  approval_batch_id uuid references public.cost_approval_batches(id) on delete set null,
  billing_period_id uuid references public.project_billing_periods(id) on delete set null,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft', 'generated', 'shared', 'downloaded', 'accepted', 'voided')),
  manifest jsonb not null default '{}'::jsonb,
  manifest_hash text,
  invoice_file_id uuid references public.files(id) on delete set null,
  package_file_id uuid references public.files(id) on delete set null,
  proof_file_ids uuid[] not null default '{}'::uuid[],
  generated_at timestamptz,
  generated_by uuid references public.app_users(id) on delete set null,
  shared_at timestamptz,
  shared_by uuid references public.app_users(id) on delete set null,
  downloaded_at timestamptz,
  accepted_at timestamptz,
  portal_token_id uuid references public.portal_access_tokens(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invoice_backup_packages_org_project_status_idx
  on public.invoice_backup_packages (org_id, project_id, status);

create index if not exists invoice_backup_packages_invoice_fk_idx
  on public.invoice_backup_packages (invoice_id);

create index if not exists invoice_backup_packages_approval_batch_fk_idx
  on public.invoice_backup_packages (approval_batch_id)
  where approval_batch_id is not null;

create index if not exists invoice_backup_packages_billing_period_fk_idx
  on public.invoice_backup_packages (billing_period_id)
  where billing_period_id is not null;

create index if not exists invoice_backup_packages_invoice_file_fk_idx
  on public.invoice_backup_packages (invoice_file_id)
  where invoice_file_id is not null;

create index if not exists invoice_backup_packages_package_file_fk_idx
  on public.invoice_backup_packages (package_file_id)
  where package_file_id is not null;

create index if not exists invoice_backup_packages_portal_token_fk_idx
  on public.invoice_backup_packages (portal_token_id)
  where portal_token_id is not null;

create unique index if not exists invoice_backup_packages_active_invoice_uq
  on public.invoice_backup_packages (org_id, invoice_id)
  where status <> 'voided';

drop trigger if exists invoice_backup_packages_set_updated_at on public.invoice_backup_packages;
create trigger invoice_backup_packages_set_updated_at
  before update on public.invoice_backup_packages
  for each row
  execute function public.tg_set_updated_at();

alter table public.invoice_backup_packages enable row level security;

drop policy if exists invoice_backup_packages_access on public.invoice_backup_packages;
create policy invoice_backup_packages_access
  on public.invoice_backup_packages
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.invoice_backup_packages to authenticated, service_role;

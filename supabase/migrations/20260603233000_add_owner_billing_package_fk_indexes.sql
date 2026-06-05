-- Phase 5 follow-up: leading indexes for owner billing package foreign keys.

create index if not exists cost_approval_batches_project_fk_idx
  on public.cost_approval_batches (project_id);

create index if not exists cost_approval_batches_created_by_fk_idx
  on public.cost_approval_batches (created_by)
  where created_by is not null;

create index if not exists cost_approval_batches_updated_by_fk_idx
  on public.cost_approval_batches (updated_by)
  where updated_by is not null;

create index if not exists invoice_backup_packages_project_fk_idx
  on public.invoice_backup_packages (project_id);

create index if not exists invoice_backup_packages_created_by_fk_idx
  on public.invoice_backup_packages (created_by)
  where created_by is not null;

create index if not exists invoice_backup_packages_updated_by_fk_idx
  on public.invoice_backup_packages (updated_by)
  where updated_by is not null;

create index if not exists invoice_backup_packages_generated_by_fk_idx
  on public.invoice_backup_packages (generated_by)
  where generated_by is not null;

create index if not exists invoice_backup_packages_shared_by_fk_idx
  on public.invoice_backup_packages (shared_by)
  where shared_by is not null;

-- Phase 6 follow-up: leading indexes for project fee billing foreign keys.

create index if not exists project_fee_schedules_project_fk_idx
  on public.project_fee_schedules (project_id);

create index if not exists project_fee_schedule_lines_project_fk_idx
  on public.project_fee_schedule_lines (project_id);

create index if not exists project_fee_billings_project_fk_idx
  on public.project_fee_billings (project_id);

create index if not exists project_fee_billings_invoice_fk_idx
  on public.project_fee_billings (invoice_id)
  where invoice_id is not null;

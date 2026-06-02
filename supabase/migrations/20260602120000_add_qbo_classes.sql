alter table if exists public.projects
  add column if not exists qbo_class_id text,
  add column if not exists qbo_class_name text;

alter table if exists public.project_expenses
  add column if not exists qbo_class_id text,
  add column if not exists qbo_class_name text;

alter table if exists public.vendor_bills
  add column if not exists qbo_class_id text,
  add column if not exists qbo_class_name text;

create index if not exists projects_qbo_class_idx
  on public.projects (org_id, qbo_class_id)
  where qbo_class_id is not null;

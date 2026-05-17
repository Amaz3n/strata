alter table public.closeout_items
  add column if not exists due_date date,
  add column if not exists responsible_party text,
  add column if not exists notes text;

create index if not exists closeout_items_org_package_due_idx
  on public.closeout_items (org_id, closeout_package_id, due_date);

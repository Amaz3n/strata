-- Stage 7: Closeout packages + warranty requests

create table if not exists closeout_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  project_id uuid not null references projects(id),
  status text default 'in_progress',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists closeout_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  project_id uuid not null references projects(id),
  closeout_package_id uuid references closeout_packages(id),
  title text not null,
  status text default 'missing',
  file_id uuid references files(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists warranty_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  project_id uuid not null references projects(id),
  title text not null,
  description text,
  status text default 'open',
  priority text default 'normal',
  requested_by uuid references contacts(id),
  created_at timestamptz default now(),
  closed_at timestamptz
);

create index if not exists closeout_packages_org_project_idx on closeout_packages (org_id, project_id);
create index if not exists closeout_items_org_package_idx on closeout_items (org_id, closeout_package_id, status);
create index if not exists warranty_requests_org_project_idx on warranty_requests (org_id, project_id, status);

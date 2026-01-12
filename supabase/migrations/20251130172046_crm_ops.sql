-- CRM, files, operations (tasks/schedule/field), approvals
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  company_type text,
  phone text,
  email text,
  website text,
  address jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists companies_org_idx on companies(org_id);
create trigger companies_set_updated_at before update on companies for each row execute function public.tg_set_updated_at();

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  primary_company_id uuid references companies(id) on delete set null,
  full_name text not null,
  email citext,
  phone text,
  role text,
  contact_type text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists contacts_org_idx on contacts(org_id);
create trigger contacts_set_updated_at before update on contacts for each row execute function public.tg_set_updated_at();

create table if not exists contact_company_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  relationship text,
  created_at timestamptz not null default now(),
  unique(contact_id, company_id)
);
create index if not exists contact_company_links_org_idx on contact_company_links(org_id);

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  file_name text not null,
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  checksum text,
  visibility text not null default 'private',
  uploaded_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists files_org_idx on files(org_id);
create index if not exists files_project_idx on files(project_id);
create trigger files_set_updated_at before update on files for each row execute function public.tg_set_updated_at();

create table if not exists file_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  entity_type text not null,
  entity_id uuid not null,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);
create index if not exists file_links_org_idx on file_links(org_id);
create index if not exists file_links_project_idx on file_links(project_id);

create table if not exists doc_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  version_number integer not null default 1,
  label text,
  notes text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique(file_id, version_number)
);
create index if not exists doc_versions_org_idx on doc_versions(org_id);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  description text,
  status task_status not null default 'todo',
  priority task_priority not null default 'normal',
  start_date date,
  due_date date,
  completed_at timestamptz,
  created_by uuid references app_users(id),
  assigned_by uuid references app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_org_idx on tasks(org_id);
create index if not exists tasks_project_idx on tasks(project_id);
create trigger tasks_set_updated_at before update on tasks for each row execute function public.tg_set_updated_at();

create table if not exists task_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid references app_users(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  assigned_by uuid references app_users(id),
  role text,
  due_date date,
  created_at timestamptz not null default now(),
  check (user_id is not null or contact_id is not null)
);
create index if not exists task_assignments_org_idx on task_assignments(org_id);
create unique index if not exists task_assignments_user_unique on task_assignments(task_id,user_id) where user_id is not null;
create unique index if not exists task_assignments_contact_unique on task_assignments(task_id,contact_id) where contact_id is not null;

create table if not exists schedule_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  item_type text not null default 'task',
  status text not null default 'planned',
  start_date date,
  end_date date,
  progress integer default 0,
  assigned_to uuid references app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists schedule_items_org_idx on schedule_items(org_id);
create index if not exists schedule_items_project_idx on schedule_items(project_id);
create trigger schedule_items_set_updated_at before update on schedule_items for each row execute function public.tg_set_updated_at();

create table if not exists schedule_dependencies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  item_id uuid not null references schedule_items(id) on delete cascade,
  depends_on_item_id uuid not null references schedule_items(id) on delete cascade,
  constraint schedule_dependencies_unique unique(item_id, depends_on_item_id)
);
create index if not exists schedule_dependencies_org_idx on schedule_dependencies(org_id);
create index if not exists schedule_dependencies_project_idx on schedule_dependencies(project_id);

create table if not exists daily_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  log_date date not null,
  weather jsonb,
  summary text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists daily_logs_org_idx on daily_logs(org_id);
create index if not exists daily_logs_project_idx on daily_logs(project_id);
create trigger daily_logs_set_updated_at before update on daily_logs for each row execute function public.tg_set_updated_at();

create table if not exists daily_log_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  daily_log_id uuid not null references daily_logs(id) on delete cascade,
  entry_type text not null default 'note',
  description text,
  quantity numeric,
  hours numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists daily_log_entries_org_idx on daily_log_entries(org_id);
create index if not exists daily_log_entries_project_idx on daily_log_entries(project_id);

create table if not exists photos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  daily_log_id uuid references daily_logs(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  file_id uuid not null references files(id) on delete cascade,
  captured_by uuid references app_users(id),
  taken_at timestamptz,
  tags text[],
  created_at timestamptz not null default now()
);
create index if not exists photos_org_idx on photos(org_id);
create index if not exists photos_project_idx on photos(project_id);

create table if not exists punch_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'open',
  due_date date,
  severity text,
  location text,
  assigned_to uuid references app_users(id),
  created_by uuid references app_users(id),
  resolved_by uuid references app_users(id),
  resolved_at timestamptz,
  file_id uuid references files(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists punch_items_org_idx on punch_items(org_id);
create index if not exists punch_items_project_idx on punch_items(project_id);
create trigger punch_items_set_updated_at before update on punch_items for each row execute function public.tg_set_updated_at();

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  requested_by uuid references app_users(id),
  approver_id uuid references app_users(id),
  status approval_status not null default 'pending',
  due_at timestamptz,
  decision_at timestamptz,
  decision_notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists approvals_org_idx on approvals(org_id);
create trigger approvals_set_updated_at before update on approvals for each row execute function public.tg_set_updated_at();;

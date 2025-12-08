-- Strata: Supabase foundation schema
-- Focus: tenancy, auth, roles/permissions, billing models, audit/events, and core domain scaffolding.
-- This file is intended as the first migration for the project.

-- Extensions
create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- Enums
do $$
begin
  create type pricing_model as enum ('subscription', 'license');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type role_scope as enum ('org', 'project');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type membership_status as enum ('active', 'invited', 'suspended');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type subscription_status as enum ('trialing', 'active', 'past_due', 'canceled');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type license_status as enum ('issued', 'active', 'suspended', 'expired');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type audit_action as enum ('insert', 'update', 'delete');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type event_channel as enum ('activity', 'integration', 'notification');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type task_status as enum ('todo', 'in_progress', 'blocked', 'done');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type task_priority as enum ('low', 'normal', 'high', 'urgent');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type approval_status as enum ('pending', 'approved', 'rejected', 'canceled');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type conversation_channel as enum ('internal', 'client', 'sub');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type notification_channel as enum ('in_app', 'email', 'sms', 'webhook');
exception
  when duplicate_object then null;
end $$;

-- Generic updated_at trigger
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Auth-aware helpers
create or replace function public.is_org_member(check_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from memberships m
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.is_project_member(check_project_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from project_members pm
    join projects p on p.id = pm.project_id
    where pm.project_id = check_project_id
      and pm.user_id = auth.uid()
      and pm.status = 'active'
      and pm.org_id = p.org_id
  );
$$;

-- Users
create table if not exists app_users (
  id uuid primary key references auth.users on delete cascade,
  email citext not null,
  full_name text,
  avatar_url text,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists app_users_email_idx on app_users (lower(email));
create trigger app_users_set_updated_at before update on app_users for each row execute function public.tg_set_updated_at();

-- Tenancy
create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug citext unique,
  billing_model pricing_model not null default 'subscription',
  status text not null default 'active',
  billing_email text,
  locale text default 'en-US',
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger orgs_set_updated_at before update on orgs for each row execute function public.tg_set_updated_at();

create table if not exists org_settings (
  org_id uuid primary key references orgs(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  storage_bucket text,
  region text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger org_settings_set_updated_at before update on org_settings for each row execute function public.tg_set_updated_at();

-- Roles and permissions
create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  scope role_scope not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger roles_set_updated_at before update on roles for each row execute function public.tg_set_updated_at();

create table if not exists permissions (
  key text primary key,
  description text
);

create table if not exists role_permissions (
  role_id uuid references roles(id) on delete cascade,
  permission_key text references permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

-- Memberships
create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role_id uuid not null references roles(id),
  status membership_status not null default 'active',
  invited_by uuid references app_users(id),
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists memberships_org_user_idx on memberships (org_id, user_id);
create trigger memberships_set_updated_at before update on memberships for each row execute function public.tg_set_updated_at();

-- Projects
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  status text not null default 'active',
  start_date date,
  end_date date,
  location jsonb,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_org_idx on projects (org_id);
create trigger projects_set_updated_at before update on projects for each row execute function public.tg_set_updated_at();

create table if not exists project_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role_id uuid not null references roles(id),
  status membership_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create index if not exists project_members_org_idx on project_members (org_id);
create trigger project_members_set_updated_at before update on project_members for each row execute function public.tg_set_updated_at();

create table if not exists project_settings (
  project_id uuid primary key references projects(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger project_settings_set_updated_at before update on project_settings for each row execute function public.tg_set_updated_at();

-- Feature flags / entitlements
create table if not exists feature_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  flag_key text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, flag_key)
);

create trigger feature_flags_set_updated_at before update on feature_flags for each row execute function public.tg_set_updated_at();

-- Plans and pricing
create table if not exists plans (
  code text primary key,
  name text not null,
  pricing_model pricing_model not null default 'subscription',
  interval text default 'monthly', -- monthly, annual
  amount_cents integer,
  currency text default 'usd',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists plan_features (
  feature_key text primary key,
  name text not null,
  description text,
  category text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists plan_feature_limits (
  id uuid primary key default gen_random_uuid(),
  plan_code text references plans(code) on delete cascade,
  feature_key text references plan_features(feature_key) on delete cascade,
  limit_type text not null, -- count, storage_gb, etc
  limit_value numeric,
  metadata jsonb not null default '{}'::jsonb,
  unique (plan_code, feature_key, limit_type)
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  plan_code text references plans(code),
  status subscription_status not null default 'trialing',
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  cancel_at timestamptz,
  external_customer_id text, -- e.g., Stripe customer id
  external_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists subscriptions_org_active_idx on subscriptions (org_id) where status = 'active';

create trigger subscriptions_set_updated_at before update on subscriptions for each row execute function public.tg_set_updated_at();

create table if not exists entitlements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  feature_key text not null references plan_features(feature_key),
  limit_type text,
  limit_value numeric,
  source text not null default 'plan', -- plan, add_on, support, license
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists entitlements_org_feature_limit_idx on entitlements (org_id, feature_key, coalesce(limit_type, 'default'));

-- License-based customers
create table if not exists licenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  plan_code text references plans(code),
  status license_status not null default 'issued',
  license_key text not null unique,
  purchased_at timestamptz not null default now(),
  maintenance_expires_at timestamptz,
  support_tier text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger licenses_set_updated_at before update on licenses for each row execute function public.tg_set_updated_at();

create table if not exists support_contracts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  status text not null default 'active',
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger support_contracts_set_updated_at before update on support_contracts for each row execute function public.tg_set_updated_at();

create table if not exists change_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  requested_by uuid references app_users(id),
  title text not null,
  description text,
  status text not null default 'open',
  estimate_cents integer,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger change_requests_set_updated_at before update on change_requests for each row execute function public.tg_set_updated_at();

-- CRM
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

create index if not exists companies_org_idx on companies (org_id);
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

create index if not exists contacts_org_idx on contacts (org_id);
create trigger contacts_set_updated_at before update on contacts for each row execute function public.tg_set_updated_at();

create table if not exists contact_company_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  relationship text,
  created_at timestamptz not null default now(),
  unique (contact_id, company_id)
);

create index if not exists contact_company_links_org_idx on contact_company_links (org_id);

-- Files and documents
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

create index if not exists files_org_idx on files (org_id);
create index if not exists files_project_idx on files (project_id);
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

create index if not exists file_links_org_idx on file_links (org_id);
create index if not exists file_links_project_idx on file_links (project_id);

create table if not exists doc_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  version_number integer not null default 1,
  label text,
  notes text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique (file_id, version_number)
);

create index if not exists doc_versions_org_idx on doc_versions (org_id);

-- Operations: tasks, schedule, field
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

create index if not exists tasks_org_idx on tasks (org_id);
create index if not exists tasks_project_idx on tasks (project_id);
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

create index if not exists task_assignments_org_idx on task_assignments (org_id);
create unique index if not exists task_assignments_user_unique on task_assignments (task_id, user_id) where user_id is not null;
create unique index if not exists task_assignments_contact_unique on task_assignments (task_id, contact_id) where contact_id is not null;

create table if not exists schedule_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  item_type text not null default 'task', -- milestone, inspection, etc
  status text not null default 'planned',
  start_date date,
  end_date date,
  progress integer default 0,
  assigned_to uuid references app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists schedule_items_org_idx on schedule_items (org_id);
create index if not exists schedule_items_project_idx on schedule_items (project_id);
create trigger schedule_items_set_updated_at before update on schedule_items for each row execute function public.tg_set_updated_at();

create table if not exists schedule_dependencies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  item_id uuid not null references schedule_items(id) on delete cascade,
  depends_on_item_id uuid not null references schedule_items(id) on delete cascade,
  constraint schedule_dependencies_unique unique (item_id, depends_on_item_id)
);

create index if not exists schedule_dependencies_org_idx on schedule_dependencies (org_id);
create index if not exists schedule_dependencies_project_idx on schedule_dependencies (project_id);

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

create index if not exists daily_logs_org_idx on daily_logs (org_id);
create index if not exists daily_logs_project_idx on daily_logs (project_id);
create trigger daily_logs_set_updated_at before update on daily_logs for each row execute function public.tg_set_updated_at();

create table if not exists daily_log_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  daily_log_id uuid not null references daily_logs(id) on delete cascade,
  entry_type text not null default 'note', -- labor, equipment, visitor, issue
  description text,
  quantity numeric,
  hours numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists daily_log_entries_org_idx on daily_log_entries (org_id);
create index if not exists daily_log_entries_project_idx on daily_log_entries (project_id);

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

create index if not exists photos_org_idx on photos (org_id);
create index if not exists photos_project_idx on photos (project_id);

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

create index if not exists punch_items_org_idx on punch_items (org_id);
create index if not exists punch_items_project_idx on punch_items (project_id);
create trigger punch_items_set_updated_at before update on punch_items for each row execute function public.tg_set_updated_at();

-- Approvals (generic)
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

create index if not exists approvals_org_idx on approvals (org_id);
create trigger approvals_set_updated_at before update on approvals for each row execute function public.tg_set_updated_at();

-- Financials: estimates, budgets, change orders, billing
create table if not exists cost_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  parent_id uuid references cost_codes(id) on delete set null,
  code text not null,
  name text not null,
  category text,
  division text,
  standard text,
  unit text,
  default_unit_cost_cents integer,
  is_active boolean default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

create index if not exists cost_codes_org_idx on cost_codes (org_id);
create trigger cost_codes_set_updated_at before update on cost_codes for each row execute function public.tg_set_updated_at();

create table if not exists estimates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  status text not null default 'draft',
  version integer not null default 1,
  subtotal_cents integer,
  tax_cents integer,
  total_cents integer,
  currency text not null default 'usd',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists estimates_org_idx on estimates (org_id);
create index if not exists estimates_project_idx on estimates (project_id);
create trigger estimates_set_updated_at before update on estimates for each row execute function public.tg_set_updated_at();

create table if not exists estimate_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  estimate_id uuid not null references estimates(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  item_type text not null default 'line', -- group/line
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  markup_pct numeric,
  sort_order integer default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists estimate_items_org_idx on estimate_items (org_id);
create index if not exists estimate_items_estimate_idx on estimate_items (estimate_id);

-- Estimate templates
create table if not exists estimate_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  description text,
  lines jsonb not null default '[]'::jsonb,
  is_default boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists estimate_templates_org_idx on estimate_templates (org_id);
create trigger estimate_templates_set_updated_at before update on estimate_templates for each row execute function public.tg_set_updated_at();

create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  estimate_id uuid references estimates(id) on delete set null,
  recipient_contact_id uuid references contacts(id) on delete set null,
  status text not null default 'draft',
  sent_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists proposals_org_idx on proposals (org_id);
create index if not exists proposals_project_idx on proposals (project_id);
create trigger proposals_set_updated_at before update on proposals for each row execute function public.tg_set_updated_at();

-- Phase 3: proposal enhancements
alter table proposals add column if not exists number text;
alter table proposals add column if not exists title text;
alter table proposals add column if not exists summary text;
alter table proposals add column if not exists terms text;
alter table proposals add column if not exists valid_until date;
alter table proposals add column if not exists total_cents integer;
alter table proposals add column if not exists signature_required boolean default true;
alter table proposals add column if not exists signature_data jsonb;
alter table proposals add column if not exists token_hash text;
alter table proposals add column if not exists viewed_at timestamptz;

create unique index if not exists proposals_token_hash_idx on proposals (token_hash) where token_hash is not null;
create unique index if not exists proposals_org_number_idx on proposals (org_id, number) where number is not null;

-- Proposal line items
create table if not exists proposal_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  proposal_id uuid not null references proposals(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  line_type text not null default 'item' check (line_type in ('item', 'section', 'allowance', 'option')),
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  markup_percent numeric,
  is_optional boolean default false,
  is_selected boolean default true,
  allowance_cents integer,
  notes text,
  sort_order integer default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists proposal_lines_org_idx on proposal_lines (org_id);
create index if not exists proposal_lines_proposal_idx on proposal_lines (proposal_id);

create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  proposal_id uuid references proposals(id) on delete set null,
  title text not null,
  status text not null default 'draft',
  total_cents integer,
  currency text not null default 'usd',
  signed_at timestamptz,
  effective_date date,
  terms text,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contracts_org_idx on contracts (org_id);
create index if not exists contracts_project_idx on contracts (project_id);
create trigger contracts_set_updated_at before update on contracts for each row execute function public.tg_set_updated_at();

-- Phase 3: contract enhancements
alter table contracts add column if not exists number text;
alter table contracts add column if not exists contract_type text default 'fixed' check (contract_type in ('fixed', 'cost_plus', 'time_materials'));
alter table contracts add column if not exists markup_percent numeric;
alter table contracts add column if not exists retainage_percent numeric default 0;
alter table contracts add column if not exists retainage_release_trigger text;
alter table contracts add column if not exists signature_data jsonb;

create unique index if not exists contracts_org_number_idx on contracts (org_id, number) where number is not null;

-- Retainage tracking
create table if not exists retainage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contract_id uuid not null references contracts(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null default 'held' check (status in ('held', 'released', 'invoiced', 'paid')),
  held_at timestamptz not null default now(),
  released_at timestamptz,
  release_invoice_id uuid references invoices(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists retainage_org_idx on retainage (org_id);
create index if not exists retainage_project_idx on retainage (project_id);
create index if not exists retainage_contract_idx on retainage (contract_id);
create index if not exists retainage_status_idx on retainage (status);
create trigger retainage_set_updated_at before update on retainage for each row execute function public.tg_set_updated_at();

-- Allowance tracking
create table if not exists allowances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contract_id uuid references contracts(id) on delete set null,
  selection_category_id uuid,
  name text not null,
  budget_cents integer not null check (budget_cents >= 0),
  used_cents integer not null default 0 check (used_cents >= 0),
  status text not null default 'open' check (status in ('open', 'at_budget', 'over', 'closed')),
  overage_handling text default 'co' check (overage_handling in ('co', 'client_direct', 'absorb')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists allowances_org_idx on allowances (org_id);
create index if not exists allowances_project_idx on allowances (project_id);
create trigger allowances_set_updated_at before update on allowances for each row execute function public.tg_set_updated_at();

create table if not exists change_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contract_id uuid references contracts(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'draft',
  reason text,
  total_cents integer,
  currency text not null default 'usd',
  requested_by uuid references app_users(id),
  approved_by uuid references app_users(id),
  approved_at timestamptz,
  rejected_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists change_orders_org_idx on change_orders (org_id);
create index if not exists change_orders_project_idx on change_orders (project_id);
create trigger change_orders_set_updated_at before update on change_orders for each row execute function public.tg_set_updated_at();

create table if not exists change_order_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  change_order_id uuid not null references change_orders(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);

create index if not exists change_order_lines_org_idx on change_order_lines (org_id);
create index if not exists change_order_lines_change_order_idx on change_order_lines (change_order_id);
create index if not exists change_order_lines_cost_code_idx on change_order_lines (cost_code_id);

create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  version integer not null default 1,
  status text not null default 'draft',
  total_cents integer,
  currency text not null default 'usd',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists budgets_org_idx on budgets (org_id);
create index if not exists budgets_project_idx on budgets (project_id);
create trigger budgets_set_updated_at before update on budgets for each row execute function public.tg_set_updated_at();

create table if not exists budget_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  budget_id uuid not null references budgets(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  amount_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);

create index if not exists budget_lines_org_idx on budget_lines (org_id);
create index if not exists budget_lines_budget_idx on budget_lines (budget_id);

-- Guard against editing locked budgets
create or replace function budget_lock_guard()
returns trigger as $$
begin
  if old.status = 'locked' then
    if new.status <> 'locked'
      or new.total_cents is distinct from old.total_cents
      or new.project_id is distinct from old.project_id
      or new.metadata is distinct from old.metadata then
      raise exception 'Budget is locked and cannot be edited';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_budget_lock_guard on budgets;
create trigger trg_budget_lock_guard
  before update on budgets
  for each row execute procedure budget_lock_guard();

create or replace function budget_line_lock_guard()
returns trigger as $$
declare
  status text;
begin
  select status into status from budgets where id = coalesce(new.budget_id, old.budget_id) limit 1;
  if status = 'locked' then
    raise exception 'Budget is locked and lines cannot be modified';
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_budget_line_lock_guard on budget_lines;
create trigger trg_budget_line_lock_guard
  before insert or update or delete on budget_lines
  for each row execute procedure budget_line_lock_guard();

-- Budget snapshots for trend tracking
create table if not exists budget_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  budget_id uuid not null references budgets(id) on delete cascade,
  snapshot_date date not null,
  total_budget_cents integer not null,
  total_committed_cents integer not null,
  total_actual_cents integer not null,
  total_invoiced_cents integer not null,
  variance_cents integer not null,
  margin_percent numeric,
  by_cost_code jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists budget_snapshots_org_idx on budget_snapshots (org_id);
create index if not exists budget_snapshots_project_date_idx on budget_snapshots (project_id, snapshot_date);
create unique index if not exists budget_snapshots_unique_idx on budget_snapshots (budget_id, snapshot_date);

-- Variance alerts
create table if not exists variance_alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  budget_id uuid references budgets(id) on delete set null,
  cost_code_id uuid references cost_codes(id) on delete set null,
  alert_type text not null check (alert_type in ('threshold_exceeded', 'over_budget', 'margin_warning')),
  threshold_percent integer,
  current_percent integer,
  budget_cents integer,
  actual_cents integer,
  variance_cents integer,
  status text not null default 'active' check (status in ('active', 'acknowledged', 'resolved')),
  acknowledged_by uuid references app_users(id),
  acknowledged_at timestamptz,
  notified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists variance_alerts_org_idx on variance_alerts (org_id);
create index if not exists variance_alerts_project_idx on variance_alerts (project_id);
create index if not exists variance_alerts_status_idx on variance_alerts (status) where status = 'active';

create table if not exists commitments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid references companies(id) on delete set null,
  title text not null,
  status text not null default 'draft',
  total_cents integer,
  currency text not null default 'usd',
  issued_at timestamptz,
  start_date date,
  end_date date,
  external_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists commitments_org_idx on commitments (org_id);
create index if not exists commitments_project_idx on commitments (project_id);
create trigger commitments_set_updated_at before update on commitments for each row execute function public.tg_set_updated_at();

create table if not exists commitment_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  commitment_id uuid not null references commitments(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);

create index if not exists commitment_lines_org_idx on commitment_lines (org_id);
create index if not exists commitment_lines_commitment_idx on commitment_lines (commitment_id);
create index if not exists commitment_lines_cost_code_idx on commitment_lines (cost_code_id);

create table if not exists vendor_bills (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  commitment_id uuid references commitments(id) on delete set null,
  bill_number text,
  status text not null default 'pending',
  bill_date date,
  due_date date,
  total_cents integer,
  currency text not null default 'usd',
  submitted_by_contact_id uuid references contacts(id) on delete set null,
  file_id uuid references files(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendor_bills_org_idx on vendor_bills (org_id);
create index if not exists vendor_bills_project_idx on vendor_bills (project_id);
create trigger vendor_bills_set_updated_at before update on vendor_bills for each row execute function public.tg_set_updated_at();

create table if not exists bill_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bill_id uuid not null references vendor_bills(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);

create index if not exists bill_lines_org_idx on bill_lines (org_id);
create index if not exists bill_lines_bill_idx on bill_lines (bill_id);
create index if not exists bill_lines_cost_code_idx on bill_lines (cost_code_id);

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  invoice_number text,
  status text not null default 'draft',
  issue_date date,
  due_date date,
  total_cents integer,
  balance_due_cents integer,
  tax_rate numeric,
  currency text not null default 'usd',
  recipient_contact_id uuid references contacts(id) on delete set null,
  file_id uuid references files(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invoices_org_idx on invoices (org_id);
create index if not exists invoices_project_idx on invoices (project_id);
create trigger invoices_set_updated_at before update on invoices for each row execute function public.tg_set_updated_at();

alter table if not exists invoices add column if not exists balance_due_cents integer;
alter table if not exists invoices add column if not exists tax_rate numeric;

create table if not exists invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_price_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);

create index if not exists invoice_lines_org_idx on invoice_lines (org_id);
create index if not exists invoice_lines_invoice_idx on invoice_lines (invoice_id);
create index if not exists invoice_lines_cost_code_idx on invoice_lines (cost_code_id);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  invoice_id uuid references invoices(id) on delete set null,
  bill_id uuid references vendor_bills(id) on delete set null,
  amount_cents integer not null,
  currency text not null default 'usd',
  method text,
  reference text,
  received_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  provider text,
  provider_payment_id text,
  fee_cents integer default 0,
  net_cents integer,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payments_org_idx on payments (org_id);
create index if not exists payments_project_idx on payments (project_id);
create index if not exists payments_status_idx on payments (status);
create index if not exists payments_provider_idx on payments (provider_payment_id);
create unique index if not exists payments_idempotency_idx on payments (idempotency_key) where idempotency_key is not null;
create trigger payments_set_updated_at before update on payments for each row execute function public.tg_set_updated_at();

-- Payment intents (provider-facing pre-authorization records)
create table if not exists payment_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  invoice_id uuid references invoices(id) on delete set null,
  provider text not null default 'stripe',
  provider_intent_id text,
  status text not null default 'requires_payment_method',
  amount_cents integer not null,
  currency text not null default 'usd',
  client_secret text,
  idempotency_key text,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_intents_provider_intent_idx on payment_intents (provider_intent_id) where provider_intent_id is not null;
create unique index if not exists payment_intents_idempotency_idx on payment_intents (idempotency_key) where idempotency_key is not null;
create index if not exists payment_intents_org_idx on payment_intents (org_id);
create index if not exists payment_intents_invoice_idx on payment_intents (invoice_id);
create index if not exists payment_intents_status_idx on payment_intents (status);
create trigger payment_intents_set_updated_at before update on payment_intents for each row execute function public.tg_set_updated_at();

-- Payment methods (stored provider tokens)
create table if not exists payment_methods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  provider text not null default 'stripe',
  provider_method_id text,
  type text not null default 'ach',
  fingerprint text,
  last4 text,
  bank_brand text,
  exp_last4 text,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_methods_provider_method_idx on payment_methods (provider, provider_method_id) where provider_method_id is not null;
create index if not exists payment_methods_org_idx on payment_methods (org_id);
create index if not exists payment_methods_contact_idx on payment_methods (contact_id);
create trigger payment_methods_set_updated_at before update on payment_methods for each row execute function public.tg_set_updated_at();

-- Payment links (signed link flow for portal payments)
create table if not exists payment_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  token_hash text not null,
  nonce text not null,
  expires_at timestamptz,
  max_uses integer,
  used_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_links_token_hash_idx on payment_links (token_hash);
create index if not exists payment_links_org_idx on payment_links (org_id);
create index if not exists payment_links_invoice_idx on payment_links (invoice_id);
create trigger payment_links_set_updated_at before update on payment_links for each row execute function public.tg_set_updated_at();

-- Late fees rules
create table if not exists late_fees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  strategy text not null default 'fixed',
  amount_cents integer,
  percent_rate numeric,
  grace_days integer default 0,
  repeat_days integer,
  max_applications integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists late_fees_org_idx on late_fees (org_id);
create index if not exists late_fees_project_idx on late_fees (project_id);
create trigger late_fees_set_updated_at before update on late_fees for each row execute function public.tg_set_updated_at();

-- Reminders rules for invoices
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete cascade,
  channel text not null default 'email',
  schedule text not null default 'before_due',
  offset_days integer not null default 0,
  template_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reminders_org_idx on reminders (org_id);
create index if not exists reminders_invoice_idx on reminders (invoice_id);
create trigger reminders_set_updated_at before update on reminders for each row execute function public.tg_set_updated_at();

create table if not exists draw_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  contract_id uuid references contracts(id) on delete set null,
  draw_number integer not null,
  title text not null,
  description text,
  amount_cents integer not null check (amount_cents >= 0),
  percent_of_contract numeric,
  due_date date,
  due_trigger text,
  milestone_id uuid references schedule_items(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'invoiced', 'partial', 'paid')),
  invoiced_at timestamptz,
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists draw_schedules_org_idx on draw_schedules (org_id);
create index if not exists draw_schedules_project_idx on draw_schedules (project_id);
create index if not exists draw_schedules_status_idx on draw_schedules (status);
create unique index if not exists draw_schedules_project_number_idx on draw_schedules (project_id, draw_number);
create trigger draw_schedules_set_updated_at before update on draw_schedules for each row execute function public.tg_set_updated_at();

create table if not exists lien_waivers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  payment_id uuid references payments(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  waiver_type text not null check (waiver_type in ('conditional', 'unconditional', 'final')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'signed', 'rejected', 'expired')),
  amount_cents integer not null check (amount_cents >= 0),
  through_date date not null,
  claimant_name text not null,
  property_description text,
  document_file_id uuid references files(id) on delete set null,
  signed_file_id uuid references files(id) on delete set null,
  signature_data jsonb,
  sent_at timestamptz,
  signed_at timestamptz,
  expires_at timestamptz,
  token_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lien_waivers_org_idx on lien_waivers (org_id);
create index if not exists lien_waivers_project_idx on lien_waivers (project_id);
create index if not exists lien_waivers_payment_idx on lien_waivers (payment_id);
create index if not exists lien_waivers_status_idx on lien_waivers (status);
create unique index if not exists lien_waivers_token_idx on lien_waivers (token_hash) where token_hash is not null;
create trigger lien_waivers_set_updated_at before update on lien_waivers for each row execute function public.tg_set_updated_at();

create table if not exists payment_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  payment_method_id uuid references payment_methods(id) on delete set null,
  total_amount_cents integer not null check (total_amount_cents > 0),
  installment_amount_cents integer not null check (installment_amount_cents > 0),
  installments_total integer not null check (installments_total > 0),
  installments_paid integer not null default 0,
  frequency text not null default 'monthly' check (frequency in ('weekly', 'biweekly', 'monthly')),
  next_charge_date date,
  status text not null default 'active' check (status in ('active', 'paused', 'completed', 'canceled', 'failed')),
  auto_charge boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_schedules_org_idx on payment_schedules (org_id);
create index if not exists payment_schedules_next_charge_idx on payment_schedules (next_charge_date) where status = 'active';
create trigger payment_schedules_set_updated_at before update on payment_schedules for each row execute function public.tg_set_updated_at();

create table if not exists reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  reminder_id uuid not null references reminders(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  channel text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'failed', 'clicked')),
  sent_at timestamptz,
  delivered_at timestamptz,
  clicked_at timestamptz,
  error_message text,
  provider_message_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists reminder_deliveries_org_idx on reminder_deliveries (org_id);
create index if not exists reminder_deliveries_invoice_idx on reminder_deliveries (invoice_id);
create unique index if not exists reminder_deliveries_unique_idx on reminder_deliveries (reminder_id, invoice_id, channel, date(created_at));

create table if not exists late_fee_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  late_fee_rule_id uuid not null references late_fees(id) on delete cascade,
  invoice_line_id uuid references invoice_lines(id) on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  applied_at timestamptz not null default now(),
  application_number integer not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists late_fee_applications_org_idx on late_fee_applications (org_id);
create index if not exists late_fee_applications_invoice_idx on late_fee_applications (invoice_id);
create unique index if not exists late_fee_applications_unique_idx on late_fee_applications (invoice_id, late_fee_rule_id, application_number);

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  payment_id uuid references payments(id) on delete cascade,
  file_id uuid references files(id) on delete set null,
  issued_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists receipts_org_idx on receipts (org_id);

-- Communication
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  subject text,
  channel conversation_channel not null default 'internal',
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);

create index if not exists conversations_org_idx on conversations (org_id);
create index if not exists conversations_project_idx on conversations (project_id);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid references app_users(id),
  message_type text not null default 'text',
  body text,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz not null default now()
);

create index if not exists messages_org_idx on messages (org_id);
create index if not exists messages_conversation_idx on messages (conversation_id);

create table if not exists mentions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid references app_users(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists mentions_org_idx on mentions (org_id);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  notification_type text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_org_idx on notifications (org_id);
create index if not exists notifications_user_idx on notifications (user_id);

create table if not exists notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  notification_id uuid not null references notifications(id) on delete cascade,
  channel notification_channel not null default 'in_app',
  status text not null default 'pending',
  sent_at timestamptz,
  response jsonb not null default '{}'::jsonb
);

create index if not exists notification_deliveries_org_idx on notification_deliveries (org_id);

-- User notification preferences
create table if not exists user_notification_prefs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  email_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index user_notification_prefs_user_org_idx on user_notification_prefs (user_id, org_id);
alter table user_notification_prefs enable row level security;

-- Customization
create table if not exists custom_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  entity_type text not null,
  key text not null,
  label text not null,
  field_type text not null,
  required boolean not null default false,
  options jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, entity_type, key)
);

create index if not exists custom_fields_org_idx on custom_fields (org_id);
create trigger custom_fields_set_updated_at before update on custom_fields for each row execute function public.tg_set_updated_at();

create table if not exists custom_field_values (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  field_id uuid not null references custom_fields(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (field_id, entity_id)
);

create index if not exists custom_field_values_org_idx on custom_field_values (org_id);
create trigger custom_field_values_set_updated_at before update on custom_field_values for each row execute function public.tg_set_updated_at();

create table if not exists form_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  entity_type text,
  version integer not null default 1,
  schema jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists form_templates_org_idx on form_templates (org_id);
create trigger form_templates_set_updated_at before update on form_templates for each row execute function public.tg_set_updated_at();

create table if not exists form_instances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  template_id uuid references form_templates(id) on delete set null,
  entity_type text,
  entity_id uuid,
  status text not null default 'draft',
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists form_instances_org_idx on form_instances (org_id);
create trigger form_instances_set_updated_at before update on form_instances for each row execute function public.tg_set_updated_at();

create table if not exists form_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  form_instance_id uuid references form_instances(id) on delete cascade,
  responder_id uuid references app_users(id),
  responses jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now()
);

create index if not exists form_responses_org_idx on form_responses (org_id);

create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  trigger text not null,
  conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflows_org_idx on workflows (org_id);
create trigger workflows_set_updated_at before update on workflows for each row execute function public.tg_set_updated_at();

create table if not exists workflow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists workflow_runs_org_idx on workflow_runs (org_id);
create index if not exists workflow_runs_workflow_idx on workflow_runs (workflow_id);

-- Audit trail and events
create table if not exists audit_log (
  id bigserial primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  actor_user_id uuid references app_users(id),
  action audit_action not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  source text,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_org_idx on audit_log (org_id);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  channel event_channel not null default 'activity',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists events_org_idx on events (org_id);

create table if not exists outbox (
  id bigserial primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  event_id uuid references events(id) on delete cascade,
  job_type text not null,
  status text not null default 'pending',
  run_at timestamptz not null default now(),
  retry_count integer not null default 0,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outbox_org_idx on outbox (org_id);
create trigger outbox_set_updated_at before update on outbox for each row execute function public.tg_set_updated_at();

-- Row Level Security
alter table app_users enable row level security;
alter table orgs enable row level security;
alter table org_settings enable row level security;
alter table roles enable row level security;
alter table permissions enable row level security;
alter table role_permissions enable row level security;
alter table memberships enable row level security;
alter table projects enable row level security;
alter table project_members enable row level security;
alter table project_settings enable row level security;
alter table feature_flags enable row level security;
alter table plans enable row level security;
alter table plan_features enable row level security;
alter table plan_feature_limits enable row level security;
alter table subscriptions enable row level security;
alter table entitlements enable row level security;
alter table licenses enable row level security;
alter table support_contracts enable row level security;
alter table change_requests enable row level security;
alter table companies enable row level security;
alter table contacts enable row level security;
alter table contact_company_links enable row level security;
alter table files enable row level security;
alter table file_links enable row level security;
alter table doc_versions enable row level security;
alter table tasks enable row level security;
alter table task_assignments enable row level security;
alter table schedule_items enable row level security;
alter table schedule_dependencies enable row level security;
alter table daily_logs enable row level security;
alter table daily_log_entries enable row level security;
alter table photos enable row level security;
alter table punch_items enable row level security;
alter table approvals enable row level security;
alter table cost_codes enable row level security;
alter table estimates enable row level security;
alter table estimate_items enable row level security;
alter table estimate_templates enable row level security;
alter table proposals enable row level security;
alter table proposal_lines enable row level security;
alter table contracts enable row level security;
alter table retainage enable row level security;
alter table change_orders enable row level security;
alter table change_order_lines enable row level security;
alter table allowances enable row level security;
alter table budgets enable row level security;
alter table budget_lines enable row level security;
alter table budget_snapshots enable row level security;
alter table variance_alerts enable row level security;
alter table commitments enable row level security;
alter table commitment_lines enable row level security;
alter table vendor_bills enable row level security;
alter table bill_lines enable row level security;
alter table invoices enable row level security;
alter table invoice_lines enable row level security;
alter table draw_schedules enable row level security;
alter table lien_waivers enable row level security;
alter table payments enable row level security;
alter table payment_intents enable row level security;
alter table payment_methods enable row level security;
alter table payment_schedules enable row level security;
alter table payment_links enable row level security;
alter table late_fees enable row level security;
alter table late_fee_applications enable row level security;
alter table reminders enable row level security;
alter table reminder_deliveries enable row level security;
alter table receipts enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table mentions enable row level security;
alter table notifications enable row level security;
alter table notification_deliveries enable row level security;
alter table custom_fields enable row level security;
alter table custom_field_values enable row level security;
alter table form_templates enable row level security;
alter table form_instances enable row level security;
alter table form_responses enable row level security;
alter table workflows enable row level security;
alter table workflow_runs enable row level security;
alter table audit_log enable row level security;
alter table events enable row level security;
alter table outbox enable row level security;

-- RLS policies
create policy "app_users_owner_access" on app_users
  for select using (auth.role() = 'service_role' or id = auth.uid());

create policy "app_users_self_update" on app_users
  for update using (auth.role() = 'service_role' or id = auth.uid());

create policy "orgs_access" on orgs
  for all using (auth.role() = 'service_role' or is_org_member(id))
  with check (auth.role() = 'service_role' or auth.uid() is not null);

create policy "org_settings_access" on org_settings
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "roles_access" on roles
  for all using (auth.role() = 'service_role');

create policy "permissions_access" on permissions
  for select using (true);

create policy "role_permissions_access" on role_permissions
  for all using (auth.role() = 'service_role');

create policy "memberships_access" on memberships
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "projects_access" on projects
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "project_members_access" on project_members
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "project_settings_access" on project_settings
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "feature_flags_access" on feature_flags
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "plans_read" on plans
  for select using (true);

create policy "plan_features_read" on plan_features
  for select using (true);

create policy "plan_feature_limits_read" on plan_feature_limits
  for select using (true);

create policy "subscriptions_access" on subscriptions
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "entitlements_access" on entitlements
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "licenses_access" on licenses
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "support_contracts_access" on support_contracts
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "change_requests_access" on change_requests
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "companies_access" on companies
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "contacts_access" on contacts
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "contact_company_links_access" on contact_company_links
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "files_access" on files
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "file_links_access" on file_links
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "doc_versions_access" on doc_versions
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "tasks_access" on tasks
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "task_assignments_access" on task_assignments
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "schedule_items_access" on schedule_items
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "schedule_dependencies_access" on schedule_dependencies
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "daily_logs_access" on daily_logs
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "daily_log_entries_access" on daily_log_entries
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "photos_access" on photos
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "punch_items_access" on punch_items
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "approvals_access" on approvals
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "cost_codes_access" on cost_codes
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "estimates_access" on estimates
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "estimate_items_access" on estimate_items
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "estimate_templates_access" on estimate_templates
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "proposals_access" on proposals
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "proposal_lines_access" on proposal_lines
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "contracts_access" on contracts
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "retainage_access" on retainage
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "change_orders_access" on change_orders
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "change_order_lines_access" on change_order_lines
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "allowances_access" on allowances
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "budgets_access" on budgets
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "budget_lines_access" on budget_lines
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "budget_snapshots_access" on budget_snapshots
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "variance_alerts_access" on variance_alerts
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "commitments_access" on commitments
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "commitment_lines_access" on commitment_lines
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "vendor_bills_access" on vendor_bills
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "bill_lines_access" on bill_lines
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "invoices_access" on invoices
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "invoice_lines_access" on invoice_lines
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "draw_schedules_access" on draw_schedules
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "lien_waivers_access" on lien_waivers
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "payments_access" on payments
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "payment_intents_access" on payment_intents
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "payment_methods_access" on payment_methods
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "payment_schedules_access" on payment_schedules
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "payment_links_access" on payment_links
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "late_fees_access" on late_fees
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "late_fee_applications_access" on late_fee_applications
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "reminders_access" on reminders
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "reminder_deliveries_access" on reminder_deliveries
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "receipts_access" on receipts
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "conversations_access" on conversations
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "messages_access" on messages
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "mentions_access" on mentions
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "notifications_access" on notifications
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "notification_deliveries_access" on notification_deliveries
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "user_notification_prefs_access" on user_notification_prefs
  for all using (auth.role() = 'service_role' or (auth.uid() = user_id and is_org_member(org_id)))
  with check (auth.role() = 'service_role' or (auth.uid() = user_id and is_org_member(org_id)));

create policy "custom_fields_access" on custom_fields
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "custom_field_values_access" on custom_field_values
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "form_templates_access" on form_templates
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "form_instances_access" on form_instances
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "form_responses_access" on form_responses
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "workflows_access" on workflows
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "workflow_runs_access" on workflow_runs
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "audit_log_read" on audit_log
  for select using (auth.role() = 'service_role' or is_org_member(org_id));

create policy "events_access" on events
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "outbox_access" on outbox
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

-- Portal access tokens
create table if not exists portal_access_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  token text not null default encode(gen_random_bytes(32), 'hex'),
  portal_type text not null check (portal_type in ('client', 'sub')),
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_accessed_at timestamptz,
  revoked_at timestamptz,
  access_count integer not null default 0,
  max_access_count integer,
  can_view_schedule boolean not null default true,
  can_view_photos boolean not null default true,
  can_view_documents boolean not null default true,
  can_download_files boolean not null default true,
  can_view_daily_logs boolean not null default false,
  can_view_budget boolean not null default false,
  can_approve_change_orders boolean not null default true,
  can_submit_selections boolean not null default true,
  can_create_punch_items boolean not null default false,
  can_message boolean not null default true,
  can_view_invoices boolean not null default true,
  can_pay_invoices boolean not null default false,
  can_view_rfis boolean not null default true,
  can_view_submittals boolean not null default true,
  can_respond_rfis boolean not null default true,
  can_submit_submittals boolean not null default true
);

create index if not exists portal_access_tokens_org_idx on portal_access_tokens(org_id);
create index if not exists portal_access_tokens_project_idx on portal_access_tokens(project_id);
create index if not exists portal_access_tokens_token_idx on portal_access_tokens(token);
alter table portal_access_tokens enable row level security;

create policy "portal_tokens_access" on portal_access_tokens
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

-- Seed recommended roles and permissions (idempotent)
insert into permissions (key, description) values
  ('org.admin', 'Full org administration'),
  ('org.member', 'Standard org access'),
  ('org.read', 'Read-only org access'),
  ('project.manage', 'Create and manage projects'),
  ('project.read', 'Read projects'),
  ('billing.manage', 'Manage billing and subscriptions'),
  ('audit.read', 'Read audit logs'),
  ('features.manage', 'Manage feature flags'),
  ('members.manage', 'Manage org memberships')
on conflict do nothing;

insert into roles (key, label, scope, description) values
  ('owner', 'Owner', 'org', 'Org owner with full permissions'),
  ('admin', 'Admin', 'org', 'Org admin'),
  ('staff', 'Staff', 'org', 'Standard staff role'),
  ('readonly', 'Read-only', 'org', 'Read-only org member'),
  ('pm', 'Project Manager', 'project', 'Project-level manager'),
  ('field', 'Field', 'project', 'Field user'),
  ('client', 'Client', 'project', 'Client portal role')
on conflict (key) do nothing;

-- Map org-level permissions
insert into role_permissions (role_id, permission_key)
select r.id, perms.permission_key
from roles r
join lateral (
  select unnest(
    case r.key
      when 'owner' then array['org.admin','org.member','org.read','project.manage','project.read','billing.manage','audit.read','features.manage','members.manage']::text[]
      when 'admin' then array['org.member','org.read','project.manage','project.read','billing.manage','features.manage','members.manage']::text[]
      when 'staff' then array['org.member','org.read','project.read']::text[]
      when 'readonly' then array['org.read','project.read']::text[]
      else array[]::text[]
    end
  ) as permission_key
) perms on true
where r.scope = 'org' and perms.permission_key is not null
on conflict do nothing;

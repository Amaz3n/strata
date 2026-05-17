-- Foundation core retry: extensions, enums, updated_at, core tables, helper functions, billing/licensing
create extension if not exists "pgcrypto";
create extension if not exists "citext";

do $$ begin create type pricing_model as enum ('subscription','license'); exception when duplicate_object then null; end $$;
do $$ begin create type role_scope as enum ('org','project'); exception when duplicate_object then null; end $$;
do $$ begin create type membership_status as enum ('active','invited','suspended'); exception when duplicate_object then null; end $$;
do $$ begin create type subscription_status as enum ('trialing','active','past_due','canceled'); exception when duplicate_object then null; end $$;
do $$ begin create type license_status as enum ('issued','active','suspended','expired'); exception when duplicate_object then null; end $$;
do $$ begin create type audit_action as enum ('insert','update','delete'); exception when duplicate_object then null; end $$;
do $$ begin create type event_channel as enum ('activity','integration','notification'); exception when duplicate_object then null; end $$;
do $$ begin create type task_status as enum ('todo','in_progress','blocked','done'); exception when duplicate_object then null; end $$;
do $$ begin create type task_priority as enum ('low','normal','high','urgent'); exception when duplicate_object then null; end $$;
do $$ begin create type approval_status as enum ('pending','approved','rejected','canceled'); exception when duplicate_object then null; end $$;
do $$ begin create type conversation_channel as enum ('internal','client','sub'); exception when duplicate_object then null; end $$;
do $$ begin create type notification_channel as enum ('in_app','email','sms','webhook'); exception when duplicate_object then null; end $$;

create or replace function public.tg_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

-- Core tables
create table if not exists app_users (
  id uuid primary key references auth.users on delete cascade,
  email citext not null,
  full_name text,
  avatar_url text,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists app_users_email_idx on app_users(lower(email));
create trigger app_users_set_updated_at before update on app_users for each row execute function public.tg_set_updated_at();

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

create table if not exists permissions (key text primary key, description text);
create table if not exists role_permissions (
  role_id uuid references roles(id) on delete cascade,
  permission_key text references permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

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
create unique index if not exists memberships_org_user_idx on memberships(org_id,user_id);
create trigger memberships_set_updated_at before update on memberships for each row execute function public.tg_set_updated_at();

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
create index if not exists projects_org_idx on projects(org_id);
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
  unique(project_id,user_id)
);
create index if not exists project_members_org_idx on project_members(org_id);
create trigger project_members_set_updated_at before update on project_members for each row execute function public.tg_set_updated_at();

create table if not exists project_settings (
  project_id uuid primary key references projects(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger project_settings_set_updated_at before update on project_settings for each row execute function public.tg_set_updated_at();

create table if not exists feature_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  flag_key text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id,flag_key)
);
create trigger feature_flags_set_updated_at before update on feature_flags for each row execute function public.tg_set_updated_at();

create table if not exists plans (
  code text primary key,
  name text not null,
  pricing_model pricing_model not null default 'subscription',
  interval text default 'monthly',
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
  limit_type text not null,
  limit_value numeric,
  metadata jsonb not null default '{}'::jsonb,
  unique(plan_code,feature_key,limit_type)
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
  external_customer_id text,
  external_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists subscriptions_org_active_idx on subscriptions(org_id) where status='active';
create trigger subscriptions_set_updated_at before update on subscriptions for each row execute function public.tg_set_updated_at();

create table if not exists entitlements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  feature_key text not null references plan_features(feature_key),
  limit_type text,
  limit_value numeric,
  source text not null default 'plan',
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists entitlements_org_feature_limit_idx on entitlements(org_id,feature_key,coalesce(limit_type,'default'));

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

-- Auth-aware helpers created after dependent tables exist
create or replace function public.is_org_member(check_org_id uuid) returns boolean language sql security definer set search_path=public stable as $$ select exists (select 1 from memberships m where m.org_id=check_org_id and m.user_id=auth.uid() and m.status='active'); $$;
create or replace function public.is_project_member(check_project_id uuid) returns boolean language sql security definer set search_path=public stable as $$ select exists (select 1 from project_members pm join projects p on p.id=pm.project_id where pm.project_id=check_project_id and pm.user_id=auth.uid() and pm.status='active' and pm.org_id=p.org_id); $$;;

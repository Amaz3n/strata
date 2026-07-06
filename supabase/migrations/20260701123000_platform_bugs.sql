create sequence if not exists public.platform_bug_issue_seq;

create table if not exists public.platform_bugs (
  id uuid primary key default gen_random_uuid(),
  issue_key text not null unique default ('ARC-' || lpad(nextval('public.platform_bug_issue_seq'::regclass)::text, 3, '0')),
  title text not null,
  description text,
  status text not null default 'triage',
  priority text not null default 'medium',
  severity text not null default 'minor',
  area text not null default 'platform',
  source text not null default 'manual',
  reporter_name text,
  reporter_email text,
  environment text,
  url text,
  org_id uuid references public.orgs(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  reproduction_steps text,
  expected_behavior text,
  actual_behavior text,
  assignee_user_id uuid references public.app_users(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  due_at timestamptz,
  started_at timestamptz,
  resolved_at timestamptz,
  archived_at timestamptz,
  labels text[] not null default '{}',
  attachment_names text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_bugs_status_check
    check (status in ('triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'wont_fix')),
  constraint platform_bugs_priority_check
    check (priority in ('urgent', 'high', 'medium', 'low')),
  constraint platform_bugs_severity_check
    check (severity in ('blocker', 'major', 'minor', 'papercut'))
);

alter table public.platform_bugs
  alter column issue_key set default ('ARC-' || lpad(nextval('public.platform_bug_issue_seq'::regclass)::text, 3, '0'));

select setval(
  'public.platform_bug_issue_seq',
  greatest(
    coalesce((
      select max(nullif(regexp_replace(issue_key, '^ARC-', ''), '')::integer)
      from public.platform_bugs
      where issue_key ~ '^ARC-[0-9]+$'
    ), 0),
    1
  ),
  coalesce((
    select max(nullif(regexp_replace(issue_key, '^ARC-', ''), '')::integer)
    from public.platform_bugs
    where issue_key ~ '^ARC-[0-9]+$'
  ), 0) > 0
);

create index if not exists platform_bugs_status_idx
  on public.platform_bugs (status, updated_at desc);

create index if not exists platform_bugs_priority_idx
  on public.platform_bugs (priority, updated_at desc);

create index if not exists platform_bugs_assignee_idx
  on public.platform_bugs (assignee_user_id);

create index if not exists platform_bugs_org_idx
  on public.platform_bugs (org_id);

create index if not exists platform_bugs_project_idx
  on public.platform_bugs (project_id);

create index if not exists platform_bugs_created_at_idx
  on public.platform_bugs (created_at desc);

drop trigger if exists platform_bugs_set_updated_at on public.platform_bugs;
create trigger platform_bugs_set_updated_at
before update on public.platform_bugs
for each row execute function public.tg_set_updated_at();

create table if not exists public.platform_bug_events (
  id uuid primary key default gen_random_uuid(),
  bug_id uuid not null references public.platform_bugs(id) on delete cascade,
  actor_user_id uuid references public.app_users(id) on delete set null,
  event_type text not null,
  body text,
  from_value text,
  to_value text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint platform_bug_events_type_check
    check (event_type in ('created', 'status_changed', 'priority_changed', 'severity_changed', 'assignee_changed', 'commented', 'edited', 'archived'))
);

create index if not exists platform_bug_events_bug_created_idx
  on public.platform_bug_events (bug_id, created_at desc);

create table if not exists public.platform_bug_attachments (
  id uuid primary key default gen_random_uuid(),
  bug_id uuid not null references public.platform_bugs(id) on delete cascade,
  uploaded_by uuid references public.app_users(id) on delete set null,
  bucket_id text not null default 'platform-bug-attachments',
  storage_path text not null,
  file_name text not null,
  content_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

create index if not exists platform_bug_attachments_bug_idx
  on public.platform_bug_attachments (bug_id, created_at desc);

alter table public.platform_bugs enable row level security;
alter table public.platform_bug_events enable row level security;
alter table public.platform_bug_attachments enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'platform-bug-attachments',
  'platform-bug-attachments',
  false,
  10485760,
  array['image/*', 'application/pdf']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Platform bug tracking is intentionally service-role only. Application reads
-- and writes go through server actions that require env superadmin or the
-- platform_super_admin role, keeping this Arc-owner-only while still storing
-- shared state in Supabase.
grant all on table public.platform_bugs to service_role;
grant all on table public.platform_bug_events to service_role;
grant all on table public.platform_bug_attachments to service_role;
grant usage, select on sequence public.platform_bug_issue_seq to service_role;

create table if not exists public.platform_bug_ai_fixes (
  id uuid primary key default gen_random_uuid(),
  bug_id uuid not null references public.platform_bugs(id) on delete cascade,
  review_id uuid references public.platform_bug_ai_reviews(id) on delete set null,
  status text not null default 'queued',
  provider text not null default 'codex',
  requested_by uuid references public.app_users(id) on delete set null,
  github_owner text,
  github_repo text,
  github_workflow text,
  github_ref text,
  github_run_id text,
  github_run_url text,
  branch_name text,
  commit_sha text,
  pr_number integer,
  pr_url text,
  summary text,
  raw_output text,
  error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_bug_ai_fixes_status_check
    check (status in ('queued', 'dispatched', 'running', 'pr_ready', 'failed', 'cancelled')),
  constraint platform_bug_ai_fixes_provider_check
    check (provider in ('codex'))
);

create index if not exists platform_bug_ai_fixes_bug_updated_idx
  on public.platform_bug_ai_fixes (bug_id, updated_at desc);

create index if not exists platform_bug_ai_fixes_status_idx
  on public.platform_bug_ai_fixes (status, updated_at desc);

create index if not exists platform_bug_ai_fixes_review_idx
  on public.platform_bug_ai_fixes (review_id);

drop trigger if exists platform_bug_ai_fixes_set_updated_at on public.platform_bug_ai_fixes;
create trigger platform_bug_ai_fixes_set_updated_at
before update on public.platform_bug_ai_fixes
for each row execute function public.tg_set_updated_at();

alter table public.platform_bug_ai_fixes enable row level security;

grant all on table public.platform_bug_ai_fixes to service_role;

create table if not exists public.platform_bug_ai_reviews (
  id uuid primary key default gen_random_uuid(),
  bug_id uuid not null references public.platform_bugs(id) on delete cascade,
  status text not null default 'queued',
  provider text not null default 'codex',
  requested_by uuid references public.app_users(id) on delete set null,
  github_owner text,
  github_repo text,
  github_workflow text,
  github_ref text,
  github_run_id text,
  github_run_url text,
  summary text,
  proposal jsonb not null default '{}'::jsonb,
  raw_output text,
  error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_bug_ai_reviews_status_check
    check (status in ('queued', 'dispatched', 'running', 'proposal_ready', 'failed', 'cancelled')),
  constraint platform_bug_ai_reviews_provider_check
    check (provider in ('codex'))
);

create index if not exists platform_bug_ai_reviews_bug_updated_idx
  on public.platform_bug_ai_reviews (bug_id, updated_at desc);

create index if not exists platform_bug_ai_reviews_status_idx
  on public.platform_bug_ai_reviews (status, updated_at desc);

drop trigger if exists platform_bug_ai_reviews_set_updated_at on public.platform_bug_ai_reviews;
create trigger platform_bug_ai_reviews_set_updated_at
before update on public.platform_bug_ai_reviews
for each row execute function public.tg_set_updated_at();

alter table public.platform_bug_ai_reviews enable row level security;

grant all on table public.platform_bug_ai_reviews to service_role;

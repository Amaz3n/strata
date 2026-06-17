create table if not exists public.ai_workflow_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ai_search_session_id uuid references public.ai_search_sessions(id) on delete set null,
  workflow_key text not null,
  title text not null,
  summary text not null default '',
  status text not null default 'collecting',
  slots jsonb not null default '{}'::jsonb,
  missing_slots jsonb not null default '[]'::jsonb,
  questions jsonb not null default '[]'::jsonb,
  preview jsonb,
  result jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  executed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint ai_workflow_sessions_status_check check (status in ('collecting', 'preview_ready', 'executing', 'executed', 'failed', 'cancelled'))
);

create index if not exists idx_ai_workflow_sessions_org_user_updated
  on public.ai_workflow_sessions(org_id, user_id, updated_at desc);

create index if not exists idx_ai_workflow_sessions_status
  on public.ai_workflow_sessions(org_id, user_id, status, updated_at desc);

drop trigger if exists ai_workflow_sessions_set_updated_at on public.ai_workflow_sessions;
create trigger ai_workflow_sessions_set_updated_at
before update on public.ai_workflow_sessions
for each row execute function public.tg_set_updated_at();

alter table public.ai_workflow_sessions enable row level security;

drop policy if exists ai_workflow_sessions_access on public.ai_workflow_sessions;
create policy ai_workflow_sessions_access
on public.ai_workflow_sessions
for all
using (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and auth.uid() = user_id
  )
)
with check (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and auth.uid() = user_id
  )
);

grant all on table public.ai_workflow_sessions to anon;
grant all on table public.ai_workflow_sessions to authenticated;
grant all on table public.ai_workflow_sessions to service_role;

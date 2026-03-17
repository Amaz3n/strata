create table if not exists public.ai_search_action_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.ai_search_sessions(id) on delete set null,
  tool_key text not null,
  title text not null,
  summary text not null,
  args jsonb not null default '{}'::jsonb,
  requires_approval boolean not null default true,
  status text not null default 'proposed',
  result jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  executed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint ai_search_action_requests_status_check check (status in ('proposed', 'executed', 'rejected', 'failed'))
);

create index if not exists idx_ai_search_action_requests_org_user_created
  on public.ai_search_action_requests(org_id, user_id, created_at desc);

create index if not exists idx_ai_search_action_requests_status
  on public.ai_search_action_requests(org_id, user_id, status, created_at desc);

drop trigger if exists ai_search_action_requests_set_updated_at on public.ai_search_action_requests;
create trigger ai_search_action_requests_set_updated_at
before update on public.ai_search_action_requests
for each row execute function public.tg_set_updated_at();

alter table public.ai_search_action_requests enable row level security;

drop policy if exists ai_search_action_requests_access on public.ai_search_action_requests;
create policy ai_search_action_requests_access
on public.ai_search_action_requests
for all
using (
  auth.role() = 'service_role'
  or (
    is_org_member(org_id)
    and auth.uid() = user_id
  )
)
with check (
  auth.role() = 'service_role'
  or (
    is_org_member(org_id)
    and auth.uid() = user_id
  )
);

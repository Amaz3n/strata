create unique index if not exists idx_search_embeddings_document_model
  on public.search_embeddings(document_id, model);

create or replace function public.match_search_embeddings(
  p_org_id uuid,
  p_query_embedding text,
  p_limit integer default 20,
  p_entity_types text[] default null
)
returns table (
  document_id uuid,
  entity_type text,
  entity_id uuid,
  project_id uuid,
  title text,
  metadata jsonb,
  updated_at timestamptz,
  similarity double precision
)
language sql
stable
set search_path = public
as $$
  select
    d.id as document_id,
    d.entity_type,
    d.entity_id,
    d.project_id,
    d.title,
    d.metadata,
    d.updated_at,
    1 - (e.embedding <=> (p_query_embedding::vector)) as similarity
  from public.search_embeddings e
  join public.search_documents d on d.id = e.document_id
  where d.org_id = p_org_id
    and (
      coalesce(array_length(p_entity_types, 1), 0) = 0
      or d.entity_type = any(p_entity_types)
    )
  order by e.embedding <=> (p_query_embedding::vector)
  limit greatest(1, least(coalesce(p_limit, 20), 120));
$$;

grant execute on function public.match_search_embeddings(uuid, text, integer, text[]) to authenticated;
grant execute on function public.match_search_embeddings(uuid, text, integer, text[]) to service_role;

create table if not exists public.ai_search_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  session_id uuid references public.ai_search_sessions(id) on delete set null,
  query text not null,
  assistant_mode text not null default 'org',
  plan jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  citations_count integer not null default 0,
  results_count integer not null default 0,
  latency_ms integer not null default 0,
  success boolean not null default true,
  error text,
  created_at timestamptz not null default now(),
  constraint ai_search_events_assistant_mode_check check (assistant_mode in ('org', 'general'))
);

create index if not exists idx_ai_search_events_org_created
  on public.ai_search_events(org_id, created_at desc);

create index if not exists idx_ai_search_events_org_success_created
  on public.ai_search_events(org_id, success, created_at desc);

create index if not exists idx_ai_search_events_user_created
  on public.ai_search_events(user_id, created_at desc);

alter table public.ai_search_events enable row level security;

drop policy if exists ai_search_events_access on public.ai_search_events;
create policy ai_search_events_access
on public.ai_search_events
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

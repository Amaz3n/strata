create extension if not exists vector;

create table if not exists public.ai_search_artifacts (
  id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  title text not null,
  columns text[] not null default '{}',
  rows jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 day')
);

create index if not exists idx_ai_search_artifacts_org_created
  on public.ai_search_artifacts(org_id, created_at desc);

create index if not exists idx_ai_search_artifacts_expires
  on public.ai_search_artifacts(expires_at);

alter table public.ai_search_artifacts enable row level security;

drop policy if exists ai_search_artifacts_access on public.ai_search_artifacts;
create policy ai_search_artifacts_access
on public.ai_search_artifacts
for all
using (auth.role() = 'service_role' or is_org_member(org_id))
with check (auth.role() = 'service_role' or is_org_member(org_id));

create table if not exists public.ai_search_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'org',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_search_sessions_mode_check check (mode in ('org', 'general'))
);

create index if not exists idx_ai_search_sessions_org_user_updated
  on public.ai_search_sessions(org_id, user_id, updated_at desc);

drop trigger if exists ai_search_sessions_set_updated_at on public.ai_search_sessions;
create trigger ai_search_sessions_set_updated_at
before update on public.ai_search_sessions
for each row execute function public.tg_set_updated_at();

alter table public.ai_search_sessions enable row level security;

drop policy if exists ai_search_sessions_access on public.ai_search_sessions;
create policy ai_search_sessions_access
on public.ai_search_sessions
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

create table if not exists public.ai_search_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.ai_search_sessions(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_search_messages_role_check check (role in ('system', 'user', 'assistant'))
);

create index if not exists idx_ai_search_messages_session_created
  on public.ai_search_messages(session_id, created_at desc);

create index if not exists idx_ai_search_messages_org_user_created
  on public.ai_search_messages(org_id, user_id, created_at desc);

alter table public.ai_search_messages enable row level security;

drop policy if exists ai_search_messages_access on public.ai_search_messages;
create policy ai_search_messages_access
on public.ai_search_messages
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

create table if not exists public.search_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  project_id uuid references public.projects(id) on delete set null,
  title text not null default '',
  body text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce(body, '')
    )
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_search_documents_entity
  on public.search_documents(org_id, entity_type, entity_id);

create index if not exists idx_search_documents_project_updated
  on public.search_documents(org_id, project_id, updated_at desc);

create index if not exists idx_search_documents_vector
  on public.search_documents using gin(search_vector);

drop trigger if exists search_documents_set_updated_at on public.search_documents;
create trigger search_documents_set_updated_at
before update on public.search_documents
for each row execute function public.tg_set_updated_at();

alter table public.search_documents enable row level security;

drop policy if exists search_documents_access on public.search_documents;
create policy search_documents_access
on public.search_documents
for all
using (auth.role() = 'service_role' or is_org_member(org_id))
with check (auth.role() = 'service_role' or is_org_member(org_id));

create table if not exists public.search_embeddings (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.search_documents(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  model text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_search_embeddings_org_model
  on public.search_embeddings(org_id, model, updated_at desc);

create index if not exists idx_search_embeddings_vector_cosine
  on public.search_embeddings
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

drop trigger if exists search_embeddings_set_updated_at on public.search_embeddings;
create trigger search_embeddings_set_updated_at
before update on public.search_embeddings
for each row execute function public.tg_set_updated_at();

alter table public.search_embeddings enable row level security;

drop policy if exists search_embeddings_access on public.search_embeddings;
create policy search_embeddings_access
on public.search_embeddings
for all
using (auth.role() = 'service_role' or is_org_member(org_id))
with check (auth.role() = 'service_role' or is_org_member(org_id));

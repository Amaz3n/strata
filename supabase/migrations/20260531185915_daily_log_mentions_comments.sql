create table if not exists public.daily_log_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  daily_log_id uuid not null references public.daily_logs(id) on delete cascade,
  body text not null check (length(btrim(body)) > 0),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists daily_log_comments_org_project_idx on public.daily_log_comments(org_id, project_id);
create index if not exists daily_log_comments_daily_log_idx on public.daily_log_comments(daily_log_id, created_at);
create index if not exists daily_log_comments_created_by_idx on public.daily_log_comments(created_by);

drop trigger if exists daily_log_comments_set_updated_at on public.daily_log_comments;
create trigger daily_log_comments_set_updated_at
before update on public.daily_log_comments
for each row execute function public.tg_set_updated_at();

alter table public.daily_log_comments enable row level security;

drop policy if exists daily_log_comments_access on public.daily_log_comments;
create policy daily_log_comments_access on public.daily_log_comments
for all
using (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  )
)
with check (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  )
);

create table if not exists public.daily_log_mentions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  daily_log_id uuid not null references public.daily_logs(id) on delete cascade,
  daily_log_comment_id uuid references public.daily_log_comments(id) on delete cascade,
  mentioned_user_id uuid not null references public.app_users(id) on delete cascade,
  mentioned_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (mentioned_user_id <> mentioned_by or mentioned_by is null)
);

create unique index if not exists daily_log_mentions_log_unique
  on public.daily_log_mentions(daily_log_id, mentioned_user_id)
  where daily_log_comment_id is null;

create unique index if not exists daily_log_mentions_comment_unique
  on public.daily_log_mentions(daily_log_comment_id, mentioned_user_id)
  where daily_log_comment_id is not null;

create index if not exists daily_log_mentions_org_project_idx on public.daily_log_mentions(org_id, project_id);
create index if not exists daily_log_mentions_daily_log_idx on public.daily_log_mentions(daily_log_id);
create index if not exists daily_log_mentions_user_idx on public.daily_log_mentions(mentioned_user_id, created_at desc);
create index if not exists daily_log_mentions_comment_idx on public.daily_log_mentions(daily_log_comment_id);

alter table public.daily_log_mentions enable row level security;

drop policy if exists daily_log_mentions_access on public.daily_log_mentions;
create policy daily_log_mentions_access on public.daily_log_mentions
for all
using (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  )
)
with check (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  )
);

grant all on table public.daily_log_comments to anon, authenticated, service_role;
grant all on table public.daily_log_mentions to anon, authenticated, service_role;

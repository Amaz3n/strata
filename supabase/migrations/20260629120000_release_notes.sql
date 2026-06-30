create table if not exists public.release_notes (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  summary text not null,
  body text,
  category text not null default 'improved',
  visibility text not null default 'badge',
  href text,
  cta_label text,
  org_id uuid references public.orgs(id) on delete cascade,
  audience_roles text[] not null default '{}',
  audience_permissions text[] not null default '{}',
  audience_features text[] not null default '{}',
  is_published boolean not null default false,
  published_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint release_notes_category_check
    check (category in ('new', 'improved', 'fixed', 'admin', 'mobile')),
  constraint release_notes_visibility_check
    check (visibility in ('quiet', 'badge', 'announce')),
  constraint release_notes_publish_requires_date
    check (is_published = false or published_at is not null)
);

create index if not exists release_notes_published_idx
  on public.release_notes (is_published, published_at desc);

create index if not exists release_notes_org_idx
  on public.release_notes (org_id);

create table if not exists public.release_note_views (
  id uuid primary key default gen_random_uuid(),
  release_note_id uuid not null references public.release_notes(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  seen_at timestamptz,
  announced_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (release_note_id, org_id, user_id)
);

create index if not exists release_note_views_user_org_idx
  on public.release_note_views (user_id, org_id);

alter table public.release_notes enable row level security;
alter table public.release_note_views enable row level security;

create policy "release_notes_read_published"
  on public.release_notes
  for select
  to authenticated
  using (
    is_published = true
    and published_at <= now()
    and (expires_at is null or expires_at > now())
    and (
      org_id is null
      or org_id in (
        select memberships.org_id
        from public.memberships
        where memberships.user_id = auth.uid()
          and memberships.status = 'active'
      )
    )
  );

create policy "release_note_views_user_access"
  on public.release_note_views
  for all
  to authenticated
  using (
    user_id = auth.uid()
    and org_id in (
      select memberships.org_id
      from public.memberships
      where memberships.user_id = auth.uid()
        and memberships.status = 'active'
    )
  )
  with check (
    user_id = auth.uid()
    and org_id in (
      select memberships.org_id
      from public.memberships
      where memberships.user_id = auth.uid()
        and memberships.status = 'active'
    )
  );

grant select on table public.release_notes to authenticated;
grant all on table public.release_notes to service_role;
grant all on table public.release_note_views to authenticated;
grant all on table public.release_note_views to service_role;

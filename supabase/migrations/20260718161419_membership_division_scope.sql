set local lock_timeout = '3s';

alter table public.memberships
  add column if not exists division_scope text not null default 'all';
alter table public.memberships
  drop constraint if exists memberships_division_scope_check;
alter table public.memberships
  add constraint memberships_division_scope_check
  check (division_scope in ('all', 'assigned'));

create table public.membership_divisions (
  membership_id uuid not null references public.memberships(id) on delete cascade,
  division_id uuid not null references public.divisions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (membership_id, division_id)
);
create index membership_divisions_division_idx on public.membership_divisions (division_id, membership_id);

alter table public.membership_divisions enable row level security;
create policy membership_divisions_select on public.membership_divisions for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.id = membership_id and public.is_org_member(m.org_id)
  ));
create policy membership_divisions_insert on public.membership_divisions for insert to authenticated
  with check (exists (
    select 1 from public.memberships m
    where m.id = membership_id and public.can_manage_members(m.org_id)
  ));
create policy membership_divisions_update on public.membership_divisions for update to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.id = membership_id and public.can_manage_members(m.org_id)
  ))
  with check (exists (
    select 1 from public.memberships m
    where m.id = membership_id and public.can_manage_members(m.org_id)
  ));
create policy membership_divisions_delete on public.membership_divisions for delete to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.id = membership_id and public.can_manage_members(m.org_id)
  ));
grant all on table public.membership_divisions to authenticated, service_role;

comment on column public.memberships.division_scope is
  'Division visibility: all = every division, assigned = only membership_divisions rows. A service-layer filter on top of org RLS.';

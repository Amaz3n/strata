-- Division ancestry, kept true by the database, and remembered.
--
-- Division scope is the enforcement layer, and a lot or a home inherits its
-- division from the community it stands in. Until now that inheritance was
-- three PostgREST calls in updateCommunity (community, then lots, then homes),
-- so a failure between them left lots or homes filed under the division the
-- community had just left -- stale ancestry that kept a moved home inside the
-- old division's reach. Nothing recorded which division a home was in on a
-- given day either, so moving a community rewrote its history.
--
-- This migration:
--   1. stamps lots.division_id from the lot's community on every write, so a
--      lot can never disagree with the community it belongs to;
--   2. cascades a community's division change to its lots and homes inside the
--      same statement, and files a home under its lot's division when it is
--      attached to one;
--   3. keeps project_division_history, an effective-dated record of every
--      home's division, with project_division_at() to read it as of a moment;
--   4. extends the restrictive division backstop (20261011010000) to
--      communities, lots, the search index and the remaining project tables.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. A lot's division is its community's division.
-- ---------------------------------------------------------------------------

-- Definer so the lot is stamped with the community's real division even when
-- the writer cannot see that community: a writer outside its division then
-- fails the lots backstop below instead of filing the lot somewhere else.
create or replace function public.tg_lots_inherit_community_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_division_id uuid;
begin
  select c.division_id into v_division_id
  from public.communities c
  where c.id = new.community_id and c.org_id = new.org_id;
  if not found then
    raise exception 'Lot community is not in the lot''s organization' using errcode = '23503';
  end if;
  new.division_id := v_division_id;
  return new;
end;
$$;

revoke all on function public.tg_lots_inherit_community_division() from public, anon, authenticated;

drop trigger if exists lots_inherit_community_division on public.lots;
create trigger lots_inherit_community_division
  before insert or update of community_id, division_id on public.lots
  for each row execute function public.tg_lots_inherit_community_division();

-- Repair any lot that already disagrees with its community.
update public.lots l
   set division_id = c.division_id
  from public.communities c
 where c.id = l.community_id
   and c.org_id = l.org_id
   and l.division_id is distinct from c.division_id;

-- ---------------------------------------------------------------------------
-- 2. Moving a community moves its lots and homes, in the same statement.
-- ---------------------------------------------------------------------------

-- A community taken out of every division leaves its homes where they are, as
-- detaching a home from its lot does: a home with no division is outside every
-- division-scoped member's reach, and that is never a side effect of a move.
create or replace function public.tg_communities_cascade_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.lots l
     set division_id = new.division_id
   where l.org_id = new.org_id
     and l.community_id = new.id
     and l.division_id is distinct from new.division_id;

  if new.division_id is not null then
    update public.projects p
       set division_id = new.division_id
      from public.lots l
     where l.org_id = new.org_id
       and l.community_id = new.id
       and p.org_id = l.org_id
       and p.id = l.project_id
       and p.division_id is distinct from new.division_id;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_communities_cascade_division() from public, anon, authenticated;

drop trigger if exists communities_cascade_division on public.communities;
create trigger communities_cascade_division
  after update of division_id on public.communities
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_communities_cascade_division();

-- A home attached to a lot stands in the lot's division. attachProjectToLot
-- already writes the same value first; this makes every other writer (the
-- reservation conversion, imports, the starts worker) agree with it.
--
-- Definer, because the home is often outside the caller's division until it
-- moves. That would let a member pull any home in the org into their own
-- division by naming it on one of their lots, so a member must already reach
-- the home where it stands. The service role (no auth.uid()) is trusted.
create or replace function public.tg_lots_file_project_under_lot_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.projects%rowtype;
begin
  select * into v_project
  from public.projects p
  where p.id = new.project_id and p.org_id = new.org_id;
  if not found then
    raise exception 'Lot project is not in the lot''s organization' using errcode = '23503';
  end if;
  if v_project.division_id is not distinct from new.division_id then
    return null;
  end if;
  if (select auth.uid()) is not null
    and not (
      v_project.org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or public.member_can_reach_project(v_project.org_id, v_project.id, v_project.division_id)
    ) then
    raise exception 'Home is outside the caller''s division access' using errcode = '42501';
  end if;
  update public.projects
     set division_id = new.division_id
   where org_id = v_project.org_id and id = v_project.id;
  return null;
end;
$$;

revoke all on function public.tg_lots_file_project_under_lot_division() from public, anon, authenticated;

drop trigger if exists lots_file_project_under_lot_division on public.lots;
create trigger lots_file_project_under_lot_division
  after insert or update of project_id on public.lots
  for each row
  when (new.project_id is not null and new.division_id is not null)
  execute function public.tg_lots_file_project_under_lot_division();

-- ---------------------------------------------------------------------------
-- 3. Which division a home was in, and when.
-- ---------------------------------------------------------------------------

create table if not exists public.project_division_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null,
  division_id uuid references public.divisions(id) on delete set null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  changed_by uuid references public.app_users(id) on delete set null,
  constraint project_division_history_project_fkey
    foreign key (org_id, project_id) references public.projects(org_id, id) on delete cascade,
  constraint project_division_history_valid_range check (valid_to is null or valid_to >= valid_from)
);

create index if not exists project_division_history_org_project_idx
  on public.project_division_history (org_id, project_id);
create index if not exists project_division_history_project_from_idx
  on public.project_division_history (project_id, valid_from);
create index if not exists project_division_history_division_idx
  on public.project_division_history (division_id) where division_id is not null;
create unique index if not exists project_division_history_one_open_idx
  on public.project_division_history (project_id) where valid_to is null;

comment on table public.project_division_history is
  'Effective-dated division of every project (home). One open row (valid_to null) per project. Written only by tg_projects_division_history; read with project_division_at().';

create or replace function public.tg_projects_division_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_at timestamptz := case when tg_op = 'INSERT' then coalesce(new.created_at, now()) else now() end;
begin
  if tg_op = 'UPDATE' then
    update public.project_division_history
       set valid_to = v_at
     where project_id = new.id and valid_to is null;
  end if;
  insert into public.project_division_history (org_id, project_id, division_id, valid_from, changed_by)
  values (
    new.org_id,
    new.id,
    new.division_id,
    v_at,
    case when exists (select 1 from public.app_users u where u.id = v_actor) then v_actor end
  );
  return null;
end;
$$;

revoke all on function public.tg_projects_division_history() from public, anon, authenticated;

drop trigger if exists projects_division_history_insert on public.projects;
create trigger projects_division_history_insert
  after insert on public.projects
  for each row execute function public.tg_projects_division_history();

drop trigger if exists projects_division_history_update on public.projects;
create trigger projects_division_history_update
  after update of division_id on public.projects
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_projects_division_history();

insert into public.project_division_history (org_id, project_id, division_id, valid_from)
select p.org_id, p.id, p.division_id, p.created_at
from public.projects p
where not exists (
  select 1 from public.project_division_history h where h.project_id = p.id and h.valid_to is null
);

alter table public.project_division_history enable row level security;

drop policy if exists project_division_history_read on public.project_division_history;
create policy project_division_history_read on public.project_division_history
  for select
  to authenticated
  using (
    public.is_org_member(org_id)
    and (
      org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
  );

revoke all on table public.project_division_history from anon, authenticated;
grant select on table public.project_division_history to authenticated;
grant all on table public.project_division_history to service_role;

create or replace function public.project_division_at(p_project_id uuid, p_at timestamptz)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select h.division_id
  from public.project_division_history h
  where h.project_id = p_project_id
    and h.valid_from <= p_at
    and (h.valid_to is null or h.valid_to > p_at)
  order by h.valid_from desc
  limit 1;
$$;

comment on function public.project_division_at(uuid, timestamptz) is
  'The division a project (home) was filed under at a moment, from project_division_history. Null before the project existed, when it had no division, or when the caller cannot reach it.';

revoke all on function public.project_division_at(uuid, timestamptz) from public, anon;
grant execute on function public.project_division_at(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The division backstop, extended.
-- ---------------------------------------------------------------------------

-- Communities and lots carry their own division. Division scope applies to
-- them; project scope does not (an assigned-only superintendent still sees the
-- community a house stands in). As on projects, a row with no division is out
-- of a division-restricted member's scope.
create or replace function public.member_division_unscoped_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.org_id), '{}'::uuid[])
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (m.division_scope = 'all' or public.membership_is_org_admin(m.id, m.role_id));
$$;

comment on function public.member_division_unscoped_org_ids() is
  'Orgs in which the caller reaches every division (division_scope all, or an org admin). Call as (select ...)::uuid[] so it runs once per statement.';

create or replace function public.member_reachable_division_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select md.division_id
  from public.memberships m
  join public.membership_divisions md on md.membership_id = m.id
  join public.divisions d on d.id = md.division_id and d.org_id = m.org_id
  where m.user_id = (select auth.uid())
    and m.status = 'active';
$$;

comment on function public.member_reachable_division_ids() is
  'Divisions a division-restricted caller is assigned to, in their own orgs. Policies use it as an uncorrelated IN so it is built once per statement.';

revoke all on function public.member_division_unscoped_org_ids() from public, anon;
revoke all on function public.member_reachable_division_ids() from public, anon;
grant execute on function public.member_division_unscoped_org_ids() to authenticated, service_role;
grant execute on function public.member_reachable_division_ids() to authenticated, service_role;

do $$
declare
  scoped_table text;
begin
  foreach scoped_table in array array['communities', 'lots'] loop
    execute format('drop policy if exists %I on public.%I', scoped_table || '_division_scope', scoped_table);
    execute format(
      $policy$
        create policy %I on public.%I
          as restrictive
          for all
          to authenticated
          using (
            org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
            or division_id in (select public.member_reachable_division_ids())
          )
          with check (
            org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
            or division_id in (select public.member_reachable_division_ids())
          )
      $policy$,
      scoped_table || '_division_scope',
      scoped_table
    );
  end loop;
end
$$;

-- Project-scoped tables, as in 20261011010000: a row with no project (a
-- personal task, an org-level search document) is unaffected. The search RPCs
-- (match_search_documents_fuzzy, match_search_embeddings) are security invoker,
-- so the search_documents policy scopes them too.
do $$
declare
  scoped_table text;
begin
  foreach scoped_table in array array[
    'search_documents',
    'tasks',
    'rfis',
    'submittals',
    'daily_logs',
    'punch_items',
    'closings'
  ] loop
    execute format('drop policy if exists %I on public.%I', scoped_table || '_division_scope', scoped_table);
    execute format(
      $policy$
        create policy %I on public.%I
          as restrictive
          for all
          to authenticated
          using (
            project_id is null
            or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
            or project_id in (select public.member_reachable_project_ids())
          )
          with check (
            project_id is null
            or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
            or project_id in (select public.member_reachable_project_ids())
          )
      $policy$,
      scoped_table || '_division_scope',
      scoped_table
    );
  end loop;
end
$$;

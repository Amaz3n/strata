-- Plans, elevations and option catalogs have identifiable revisions, and every
-- home keeps the revisions it was priced and released against.
--
-- 1. Revisions. A released plan version was already immutable (its takeoff and
--    template bundle are frozen with it), but elevations, options and packages
--    are edited in place, so "the Craftsman elevation" or "the covered patio"
--    meant whatever the row said today. Each now carries `revision`, bumped by
--    the database when — and only when — a column that changes what is built
--    or sold changes. Sort order, imagery, internal cost and lead time are
--    presentation or purchasing and leave the revision alone. Nothing a client
--    sends can set the number.
--
--      house_plan_elevations  house_plan_id, code, name, swing_applicable,
--                             heated_sqft_delta, is_active
--      selection_options      category_id, community_id, parent_option_id,
--                             name, description, option_scope, price_cents,
--                             price_type, cost_code_id, sku, vendor,
--                             model_changes, is_default, is_available,
--                             is_archived
--      selection_packages     community_id, name, description, price_cents,
--                             is_available, is_archived, and its member options
--
--    A package's members live in selection_package_items and are replaced
--    after the package row in the same transaction, so a package is revisioned
--    once at commit, by a deferred trigger that compares the final definition
--    with its last recorded one: a save that reprices it and swaps a member is
--    one revision, not three.
--
-- 2. product_definition_revisions: the definition of every revision, written
--    by the same triggers, append-only. It is how a revision a home recorded
--    months ago can still be read after the row moved on, and how a sale is
--    resolved to the revisions current when it was priced. Existing rows are
--    recorded as revision 1.
--
-- 3. A released plan version describes its elevations. The bundle snapshot
--    `release_house_plan_version` stores now carries each elevation's id,
--    code and revision as they stood at release, written in the release
--    transaction rather than trusted from the caller.
--
-- 4. project_selections.selected_option_revision: the revision of the option a
--    selection chose, set by the database whenever the chosen option changes,
--    on every path that writes a selection (design studio, portal, change
--    order, agreement execution, import). Selections chosen before this
--    migration have none.
--
-- 5. home_product_revisions: the set a home was sold against (stage
--    'agreement', one per agreement) and released against (stage 'release',
--    one per home) — plan version, elevation and option/package revisions —
--    written once by the service role and never rewritten. Shaped like
--    home_margin_baselines, captured at the same two moments.

-- ---------------------------------------------------------------------------
-- 1. Revision columns.
-- ---------------------------------------------------------------------------

alter table public.house_plan_elevations
  add column if not exists revision integer not null default 1 constraint house_plan_elevations_revision_check check (revision > 0);
alter table public.selection_options
  add column if not exists revision integer not null default 1 constraint selection_options_revision_check check (revision > 0);
alter table public.selection_packages
  add column if not exists revision integer not null default 1 constraint selection_packages_revision_check check (revision > 0);
alter table public.project_selections
  add column if not exists selected_option_revision integer
    constraint project_selections_selected_option_revision_check check (selected_option_revision is null or selected_option_revision > 0);

-- ---------------------------------------------------------------------------
-- 2. The history.
-- ---------------------------------------------------------------------------

create table if not exists public.product_definition_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  revision integer not null,
  snapshot jsonb not null,
  changed_by uuid,
  created_at timestamptz not null default now(),
  constraint product_definition_revisions_entity_type_check
    check (entity_type in ('house_plan_elevation', 'selection_option', 'selection_package')),
  constraint product_definition_revisions_revision_check check (revision > 0),
  constraint product_definition_revisions_entity_revision_key unique (org_id, entity_type, entity_id, revision)
);

create index if not exists product_definition_revisions_entity_idx
  on public.product_definition_revisions (org_id, entity_type, entity_id, revision desc);

comment on table public.product_definition_revisions is
  'Every revision of a plan elevation, catalog option and catalog package: the definition columns as they stood. Written only by the revision triggers; append-only; removed only with the organization.';

-- The definition columns of a row, as one comparable value.
create or replace function public.product_definition_of(p_row jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, p_row -> k), '{}'::jsonb) from unnest(p_keys) as k
$$;

revoke all on function public.product_definition_of(jsonb, text[]) from public, anon, authenticated;

-- Elevations and options: the revision moves with the definition, in the same
-- statement, so the row a save returns already carries its new revision.
-- tg_argv[0] is the entity type, tg_argv[1] the definition columns.
create or replace function public.tg_product_definition_revision_bump()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  keys constant text[] := string_to_array(tg_argv[1], ',');
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
  elsif public.product_definition_of(to_jsonb(new), keys) is distinct from public.product_definition_of(to_jsonb(old), keys) then
    new.revision := old.revision + 1;
  else
    new.revision := old.revision;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_product_definition_revision_bump() from public, anon, authenticated, service_role;

create or replace function public.tg_product_definition_revision_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.revision = old.revision then
    return null;
  end if;
  insert into public.product_definition_revisions (org_id, entity_type, entity_id, revision, snapshot, changed_by)
  values (new.org_id, tg_argv[0], new.id, new.revision,
          public.product_definition_of(to_jsonb(new), string_to_array(tg_argv[1], ',')), (select auth.uid()));
  return null;
end;
$$;

revoke all on function public.tg_product_definition_revision_record() from public, anon, authenticated, service_role;

drop trigger if exists house_plan_elevations_revision_bump on public.house_plan_elevations;
create trigger house_plan_elevations_revision_bump
  before insert or update on public.house_plan_elevations
  for each row execute function public.tg_product_definition_revision_bump(
    'house_plan_elevation', 'house_plan_id,code,name,swing_applicable,heated_sqft_delta,is_active');
drop trigger if exists house_plan_elevations_revision_record on public.house_plan_elevations;
create trigger house_plan_elevations_revision_record
  after insert or update on public.house_plan_elevations
  for each row execute function public.tg_product_definition_revision_record(
    'house_plan_elevation', 'house_plan_id,code,name,swing_applicable,heated_sqft_delta,is_active');

drop trigger if exists selection_options_revision_bump on public.selection_options;
create trigger selection_options_revision_bump
  before insert or update on public.selection_options
  for each row execute function public.tg_product_definition_revision_bump(
    'selection_option',
    'category_id,community_id,parent_option_id,name,description,option_scope,price_cents,price_type,cost_code_id,sku,vendor,model_changes,is_default,is_available,is_archived');
drop trigger if exists selection_options_revision_record on public.selection_options;
create trigger selection_options_revision_record
  after insert or update on public.selection_options
  for each row execute function public.tg_product_definition_revision_record(
    'selection_option',
    'category_id,community_id,parent_option_id,name,description,option_scope,price_cents,price_type,cost_code_id,sku,vendor,model_changes,is_default,is_available,is_archived');

-- Packages: a new package starts at revision 1; afterwards only the deferred
-- sync below moves the number (it is the only writer nested inside a trigger).
create or replace function public.tg_selection_package_revision_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
  elsif pg_trigger_depth() < 2 then
    new.revision := old.revision;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_selection_package_revision_guard() from public, anon, authenticated, service_role;

create or replace function public.selection_package_definition(p_package public.selection_packages)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select public.product_definition_of(to_jsonb(p_package),
           array['community_id', 'name', 'description', 'price_cents', 'is_available', 'is_archived'])
    || jsonb_build_object('option_ids', coalesce((
         select jsonb_agg(i.option_id order by i.option_id)
           from public.selection_package_items i
          where i.org_id = p_package.org_id and i.package_id = p_package.id
       ), '[]'::jsonb))
$$;

revoke all on function public.selection_package_definition(public.selection_packages) from public, anon, authenticated;

create or replace function public.tg_selection_package_revision_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
  pkg public.selection_packages%rowtype;
  definition jsonb;
  latest_revision integer;
  latest_snapshot jsonb;
  next_revision integer;
begin
  if tg_table_name = 'selection_packages' then
    target := new.id;
  elsif tg_op = 'DELETE' then
    target := old.package_id;
  else
    target := new.package_id;
  end if;

  select * into pkg from public.selection_packages where id = target for update;
  if not found then
    return null;
  end if;
  definition := public.selection_package_definition(pkg);

  select r.revision, r.snapshot into latest_revision, latest_snapshot
    from public.product_definition_revisions r
   where r.org_id = pkg.org_id and r.entity_type = 'selection_package' and r.entity_id = pkg.id
   order by r.revision desc
   limit 1;
  if latest_snapshot = definition then
    return null;
  end if;

  next_revision := coalesce(latest_revision, 0) + 1;
  insert into public.product_definition_revisions (org_id, entity_type, entity_id, revision, snapshot, changed_by)
  values (pkg.org_id, 'selection_package', pkg.id, next_revision, definition, (select auth.uid()));
  if pkg.revision is distinct from next_revision then
    update public.selection_packages set revision = next_revision where id = pkg.id;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_selection_package_revision_sync() from public, anon, authenticated, service_role;

drop trigger if exists selection_packages_revision_guard on public.selection_packages;
create trigger selection_packages_revision_guard
  before insert or update on public.selection_packages
  for each row execute function public.tg_selection_package_revision_guard();
drop trigger if exists selection_packages_revision_sync on public.selection_packages;
create constraint trigger selection_packages_revision_sync
  after insert or update on public.selection_packages
  deferrable initially deferred
  for each row execute function public.tg_selection_package_revision_sync();
drop trigger if exists selection_package_items_revision_sync on public.selection_package_items;
create constraint trigger selection_package_items_revision_sync
  after insert or update or delete on public.selection_package_items
  deferrable initially deferred
  for each row execute function public.tg_selection_package_revision_sync();

-- Append-only. The only way a revision leaves is its organization being
-- deleted: inside that cascade the org row is already gone.
create or replace function public.guard_product_definition_revision_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs o where o.id = old.org_id) then
    return old;
  end if;
  raise exception 'Product definition revisions are append-only' using errcode = '42501';
end;
$$;

revoke all on function public.guard_product_definition_revision_append_only() from public, anon, authenticated, service_role;

drop trigger if exists product_definition_revisions_append_only on public.product_definition_revisions;
create trigger product_definition_revisions_append_only
  before update or delete on public.product_definition_revisions
  for each row execute function public.guard_product_definition_revision_append_only();

alter table public.product_definition_revisions enable row level security;

drop policy if exists product_definition_revisions_read on public.product_definition_revisions;
create policy product_definition_revisions_read on public.product_definition_revisions
  for select
  to authenticated
  using (public.is_org_member(org_id));

revoke all on table public.product_definition_revisions from anon, authenticated, service_role;
grant select on table public.product_definition_revisions to authenticated, service_role;

-- Everything that exists today is its own first revision, dated from the
-- row's creation: it is the only definition on record, and a sale priced
-- before this migration resolves to it.
insert into public.product_definition_revisions (org_id, entity_type, entity_id, revision, snapshot, created_at)
select e.org_id, 'house_plan_elevation', e.id, e.revision,
       public.product_definition_of(to_jsonb(e), array['house_plan_id', 'code', 'name', 'swing_applicable', 'heated_sqft_delta', 'is_active']),
       e.created_at
  from public.house_plan_elevations e
on conflict on constraint product_definition_revisions_entity_revision_key do nothing;

insert into public.product_definition_revisions (org_id, entity_type, entity_id, revision, snapshot, created_at)
select o.org_id, 'selection_option', o.id, o.revision,
       public.product_definition_of(to_jsonb(o), array['category_id', 'community_id', 'parent_option_id', 'name', 'description',
         'option_scope', 'price_cents', 'price_type', 'cost_code_id', 'sku', 'vendor', 'model_changes', 'is_default', 'is_available', 'is_archived']),
       o.created_at
  from public.selection_options o
on conflict on constraint product_definition_revisions_entity_revision_key do nothing;

insert into public.product_definition_revisions (org_id, entity_type, entity_id, revision, snapshot, created_at)
select p.org_id, 'selection_package', p.id, p.revision, public.selection_package_definition(p), p.created_at
  from public.selection_packages p
on conflict on constraint product_definition_revisions_entity_revision_key do nothing;

-- ---------------------------------------------------------------------------
-- 3. A released version records its elevations' revisions.
-- ---------------------------------------------------------------------------

create or replace function public.release_house_plan_version(
  p_org_id uuid,
  p_version_id uuid,
  p_actor_id uuid,
  p_bundle_snapshot jsonb,
  p_released_at timestamptz default now()
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_plan_id uuid;
  elevations jsonb;
begin
  select house_plan_id into target_plan_id
  from public.house_plan_versions
  where org_id = p_org_id and id = p_version_id and status = 'draft'
  for update;

  if target_plan_id is null then
    raise exception 'Plan version is not a releasable draft';
  end if;
  if p_bundle_snapshot is null then
    raise exception 'Bundle snapshot is required';
  end if;

  perform 1 from public.house_plan_versions
  where org_id = p_org_id and house_plan_id = target_plan_id
  for update;

  -- The elevations as they stand at release, read under the lock above.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'code', e.code, 'name', e.name, 'revision', e.revision,
           'swing_applicable', e.swing_applicable, 'heated_sqft_delta', e.heated_sqft_delta, 'is_active', e.is_active
         ) order by e.sort_order, e.code), '[]'::jsonb)
    into elevations
    from public.house_plan_elevations e
   where e.org_id = p_org_id and e.house_plan_id = target_plan_id;

  update public.house_plan_versions
  set status = 'superseded'
  where org_id = p_org_id and house_plan_id = target_plan_id and status = 'released';

  update public.house_plan_versions
  set status = 'released', bundle_snapshot = p_bundle_snapshot || jsonb_build_object('elevations', elevations),
      released_at = p_released_at, released_by = p_actor_id
  where org_id = p_org_id and id = p_version_id and status = 'draft';

  if not found then
    raise exception 'Plan version release lost a concurrent update';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A selection records the revision it chose.
-- ---------------------------------------------------------------------------

create or replace function public.tg_project_selection_option_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.selected_option_id is not distinct from old.selected_option_id then
    new.selected_option_revision := old.selected_option_revision;
  elsif new.selected_option_id is null then
    new.selected_option_revision := null;
  else
    select o.revision into new.selected_option_revision
      from public.selection_options o
     where o.org_id = new.org_id and o.id = new.selected_option_id;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_project_selection_option_revision() from public, anon, authenticated, service_role;

drop trigger if exists project_selections_option_revision on public.project_selections;
create trigger project_selections_option_revision
  before insert or update on public.project_selections
  for each row execute function public.tg_project_selection_option_revision();

-- ---------------------------------------------------------------------------
-- 5. What each home was sold and released against.
-- ---------------------------------------------------------------------------

create table if not exists public.home_product_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null,
  contract_id uuid references public.contracts(id),
  stage text not null,
  house_plan_version_id uuid references public.house_plan_versions(id),
  plan_version_number integer,
  -- Plain references: the record must outlive an elevation that is retired
  -- and deleted.
  elevation_id uuid,
  elevation_revision integer,
  revisions jsonb not null,
  as_of timestamptz not null,
  captured_at timestamptz not null default now(),
  captured_by uuid references public.app_users(id),
  constraint home_product_revisions_project_fkey
    foreign key (org_id, project_id) references public.projects(org_id, id) on delete cascade,
  constraint home_product_revisions_stage_check check (stage in ('agreement', 'release')),
  constraint home_product_revisions_agreement_has_contract check (stage <> 'agreement' or contract_id is not null),
  constraint home_product_revisions_set_check check (jsonb_typeof(revisions) = 'object')
);

create unique index if not exists home_product_revisions_release_key
  on public.home_product_revisions (project_id) where stage = 'release';
create unique index if not exists home_product_revisions_agreement_key
  on public.home_product_revisions (contract_id) where stage = 'agreement';
create index if not exists home_product_revisions_org_project_idx
  on public.home_product_revisions (org_id, project_id);
create index if not exists home_product_revisions_plan_version_idx
  on public.home_product_revisions (org_id, house_plan_version_id) where house_plan_version_id is not null;
create index if not exists home_product_revisions_contract_idx
  on public.home_product_revisions (contract_id) where contract_id is not null;
create index if not exists home_product_revisions_version_fk_idx
  on public.home_product_revisions (house_plan_version_id) where house_plan_version_id is not null;
create index if not exists home_product_revisions_captured_by_idx
  on public.home_product_revisions (captured_by) where captured_by is not null;

comment on table public.home_product_revisions is
  'The plan version, elevation and option/package revisions a production home was sold against (agreement) and released against (release). Written once by the service role (lib/services/home-product-revisions.ts); never updated; removed only with the home or the organization.';

create or replace function public.guard_home_product_revisions_write_once()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.projects p where p.id = old.project_id and p.org_id = old.org_id) then
      return old;
    end if;
    raise exception 'A home''s recorded product revisions cannot be deleted' using errcode = '42501';
  end if;
  raise exception 'A home''s recorded product revisions cannot be changed' using errcode = '42501';
end;
$$;

revoke all on function public.guard_home_product_revisions_write_once() from public, anon, authenticated, service_role;

drop trigger if exists home_product_revisions_write_once on public.home_product_revisions;
create trigger home_product_revisions_write_once
  before update or delete on public.home_product_revisions
  for each row execute function public.guard_home_product_revisions_write_once();

alter table public.home_product_revisions enable row level security;

drop policy if exists home_product_revisions_read on public.home_product_revisions;
create policy home_product_revisions_read on public.home_product_revisions
  for select
  to authenticated
  using (public.is_org_member(org_id));

-- The division wall, as on every other table that hangs off a home.
drop policy if exists home_product_revisions_division_scope on public.home_product_revisions;
create policy home_product_revisions_division_scope on public.home_product_revisions
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

revoke all on table public.home_product_revisions from anon, authenticated;
grant select on table public.home_product_revisions to authenticated;
grant all on table public.home_product_revisions to service_role;

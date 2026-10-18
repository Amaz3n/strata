-- Pending approval. Do not enable production_configuration_rules until this
-- migration and its dedicated-QA acceptance have completed.
begin;
create unique index if not exists selection_options_org_id_id_configuration_key
  on public.selection_options(org_id, id);

create table public.selection_configuration_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source_option_id uuid not null,
  target_option_id uuid not null,
  kind text not null check (kind in ('requires', 'excludes')),
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  constraint configuration_rule_source_fk foreign key (org_id, source_option_id)
    references public.selection_options(org_id, id) on delete restrict,
  constraint configuration_rule_target_fk foreign key (org_id, target_option_id)
    references public.selection_options(org_id, id) on delete restrict,
  constraint configuration_rule_distinct_options check (source_option_id <> target_option_id),
  constraint configuration_rule_pair_unique unique (org_id, source_option_id, target_option_id)
);
create index configuration_rules_target_idx
  on public.selection_configuration_rules(org_id, target_option_id);
alter table public.selection_configuration_rules enable row level security;
-- Office mutations and reads pass through the server's permission/division
-- checks. Never grant browser clients a path around those checks.
revoke all on public.selection_configuration_rules from public, anon, authenticated;
grant all on public.selection_configuration_rules to service_role;
-- A real row write serializes authors and also forces a serialization failure
-- instead of stale validation under repeatable-read/serializable isolation.
create table public.selection_configuration_rule_locks (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  revision bigint not null default 0
);
alter table public.selection_configuration_rule_locks enable row level security;
revoke all on public.selection_configuration_rule_locks from public, anon, authenticated;

create function public.validate_selection_configuration_rule()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  source_row public.selection_options%rowtype;
  target_row public.selection_options%rowtype;
  conflict_root uuid;
  conflict_name text;
begin
  if tg_op = 'UPDATE' and new.org_id <> old.org_id then
    raise exception 'Configuration rules cannot move between organizations';
  end if;
  insert into public.selection_configuration_rule_locks(org_id, revision)
    values(new.org_id, 1)
    on conflict (org_id) do update set revision = selection_configuration_rule_locks.revision + 1;

  select * into source_row from public.selection_options where org_id = new.org_id and id = new.source_option_id;
  select * into target_row from public.selection_options where org_id = new.org_id and id = new.target_option_id;
  -- Let the composite foreign keys report missing/cross-organization records.
  if source_row.id is null or target_row.id is null then return new; end if;
  if source_row.is_archived or target_row.is_archived then
    raise exception 'Restore archived options before configuring rules';
  end if;
  if not source_row.is_available or not target_row.is_available then
    raise exception 'Restore unavailable options before configuring rules';
  end if;
  if coalesce(source_row.parent_option_id, source_row.id) = coalesce(target_row.parent_option_id, target_row.id) then
    raise exception 'An option cannot require or exclude itself';
  end if;
  if target_row.community_id is not null and target_row.community_id is distinct from source_row.community_id then
    raise exception 'The target option is not available in the source option community';
  end if;
  if (select count(*) from public.selection_configuration_rules
      where org_id = new.org_id and source_option_id = new.source_option_id and id <> new.id) >= 200 then
    raise exception 'An option supports at most 200 configuration rules';
  end if;

  -- Parent implication matches runtime override inheritance. UNION (not UNION
  -- ALL) in the closure terminates cycles; mutually required options are legal.
  -- Only roots reaching the changed source can acquire a new contradiction.
  with recursive rules as (
    select source_option_id s, target_option_id t, kind
      from public.selection_configuration_rules where org_id = new.org_id and id <> new.id
    union all select new.source_option_id, new.target_option_id, new.kind
  ), nodes as (
    select s id from rules union select t from rules
  ), requirements as (
    select s, t from rules where kind = 'requires'
    union select o.id, o.parent_option_id from public.selection_options o
      join nodes n on n.id = o.id
      where o.org_id = new.org_id and o.parent_option_id is not null
  ), affected_roots(id) as (
    select new.source_option_id
    union
    select r.s from affected_roots a join requirements r on r.t = a.id
  ), closure(root, choice) as (
    select id, id from affected_roots
    union
    select c.root, r.t from closure c join requirements r on r.s = c.choice
  )
  select c.root into conflict_root from rules x
    join closure c on c.choice = x.s
    join closure d on d.root = c.root and d.choice = x.t
    where x.kind = 'excludes' limit 1;
  if conflict_root is not null then
    select name into conflict_name from public.selection_options where org_id = new.org_id and id = conflict_root;
    raise exception 'These rules create an impossible configuration for %. Review its requirements and exclusions.', coalesce(conflict_name, conflict_root::text);
  end if;
  return new;
end;
$$;
revoke all on function public.validate_selection_configuration_rule() from public, anon, authenticated;
create trigger validate_selection_configuration_rule
  before insert or update on public.selection_configuration_rules
  for each row execute function public.validate_selection_configuration_rule();

-- Catalog identity/availability changes share the rule writer lock. Otherwise
-- a concurrent rule insert can validate an option immediately before it moves
-- community, acquires a different parent, or becomes unavailable.
create function public.protect_configured_catalog_option()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id then
      raise exception 'Catalog options cannot move between organizations';
    end if;
    if new.parent_option_id is not distinct from old.parent_option_id
      and new.community_id is not distinct from old.community_id
      and not (new.is_archived and not old.is_archived)
      and not (not new.is_available and old.is_available) then
      return new;
    end if;
  end if;
  -- An organization cascade has already removed its owning row.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then return old; end if;
  insert into public.selection_configuration_rule_locks(org_id, revision)
    values(old.org_id, 1)
    on conflict (org_id) do update set revision = selection_configuration_rule_locks.revision + 1;

  if exists (
    with affected as (
      select old.id id
      union select id from public.selection_options
        where org_id = old.org_id and parent_option_id = old.id
    )
    select 1 from public.selection_configuration_rules r
      where r.org_id = old.org_id and (
        r.source_option_id in (select id from affected)
        or r.target_option_id in (select id from affected)
      )
  ) then
    raise exception 'This option participates in configuration rules. Review and remove or replace those rules before changing its scope, inheritance, or availability.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.protect_configured_catalog_option() from public, anon, authenticated;
create trigger protect_configured_catalog_option_update
  before update of org_id, parent_option_id, community_id, is_archived, is_available on public.selection_options
  for each row execute function public.protect_configured_catalog_option();
create trigger protect_configured_catalog_option_delete
  before delete on public.selection_options
  for each row execute function public.protect_configured_catalog_option();

comment on table public.selection_configuration_rules is
  'Option requirements and exclusions. Controlled server access; production_configuration_rules rollout flag remains disabled until approved acceptance.';
commit;

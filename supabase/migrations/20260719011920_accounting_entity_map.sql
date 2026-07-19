-- Workstream 08 / Phase C1: hierarchical accounting routing and legacy project
-- QBO dimension backfill. This migration remains additive.
set lock_timeout = '5s';
set statement_timeout = '120s';

create table public.accounting_entity_map (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.accounting_connections(id) on delete restrict,
  division_id uuid references public.divisions(id) on delete cascade,
  community_id uuid references public.communities(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  scope text generated always as (
    case when project_id is not null then 'project'
         when community_id is not null then 'community'
         when division_id is not null then 'division'
         else 'org_default' end
  ) stored,
  dimensions jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id),
  reassignment_acknowledged_at timestamptz,
  reassignment_acknowledged_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_entity_map_one_scope check (
    (project_id is not null)::integer
      + (community_id is not null)::integer
      + (division_id is not null)::integer <= 1
  )
);

create unique index accounting_entity_map_project_idx
  on public.accounting_entity_map (org_id, project_id) where project_id is not null;
create unique index accounting_entity_map_community_idx
  on public.accounting_entity_map (org_id, community_id) where community_id is not null;
create unique index accounting_entity_map_division_idx
  on public.accounting_entity_map (org_id, division_id) where division_id is not null;
create unique index accounting_entity_map_org_default_idx
  on public.accounting_entity_map (org_id)
  where project_id is null and community_id is null and division_id is null;
create index accounting_entity_map_connection_idx
  on public.accounting_entity_map (connection_id);
create index accounting_entity_map_division_fk_idx
  on public.accounting_entity_map (division_id);
create index accounting_entity_map_community_fk_idx
  on public.accounting_entity_map (community_id);
create index accounting_entity_map_project_fk_idx
  on public.accounting_entity_map (project_id);
create index accounting_entity_map_created_by_idx
  on public.accounting_entity_map (created_by);
create index accounting_entity_map_reassignment_by_idx
  on public.accounting_entity_map (reassignment_acknowledged_by);

create trigger accounting_entity_map_set_updated_at
  before update on public.accounting_entity_map
  for each row execute function public.tg_set_updated_at();

alter table public.accounting_entity_map enable row level security;
create policy accounting_entity_map_org_access on public.accounting_entity_map
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
grant select, insert, update, delete on public.accounting_entity_map to authenticated;
grant all on public.accounting_entity_map to service_role;

create or replace function public.validate_accounting_entity_map_scope()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (
    select 1 from public.accounting_connections c
    where c.id = new.connection_id and c.org_id = new.org_id
  ) then raise exception 'Accounting connection must belong to the mapping organization'; end if;
  if new.project_id is not null and not exists (
    select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id
  ) then raise exception 'Project must belong to the mapping organization'; end if;
  if new.division_id is not null and not exists (
    select 1 from public.divisions d where d.id = new.division_id and d.org_id = new.org_id
  ) then raise exception 'Division must belong to the mapping organization'; end if;
  if new.community_id is not null and not exists (
    select 1 from public.communities c where c.id = new.community_id and c.org_id = new.org_id
  ) then raise exception 'Community must belong to the mapping organization'; end if;
  return new;
end;
$$;

create trigger accounting_entity_map_validate_scope
  before insert or update on public.accounting_entity_map
  for each row execute function public.validate_accounting_entity_map_scope();

revoke all on function public.validate_accounting_entity_map_scope() from public, anon, authenticated;

with active_connection as (
  select distinct on (org_id) org_id, id
  from public.accounting_connections
  where status = 'active'
  order by org_id, connected_at, id
)
insert into public.accounting_entity_map (org_id, connection_id, project_id, dimensions)
select p.org_id, c.id, p.id,
  jsonb_strip_nulls(jsonb_build_object(
    'class', case when p.qbo_class_id is not null then
      jsonb_build_object('id', p.qbo_class_id, 'name', p.qbo_class_name) end,
    'customer', case when p.qbo_customer_id is not null then
      jsonb_build_object('id', p.qbo_customer_id, 'name', p.qbo_customer_name) end
  ))
from public.projects p
join active_connection c on c.org_id = p.org_id
where p.qbo_class_id is not null or p.qbo_customer_id is not null
on conflict (org_id, project_id) where project_id is not null do nothing;

with active_connection as (
  select distinct on (org_id) org_id, id
  from public.accounting_connections
  where status = 'active'
  order by org_id, connected_at, id
)
insert into public.accounting_entity_map (org_id, connection_id, dimensions)
select org_id, id, '{}'::jsonb from active_connection
on conflict (org_id) where project_id is null and community_id is null and division_id is null
do nothing;

create or replace function public.guard_accounting_project_reassignment()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.connection_id is not distinct from new.connection_id or old.project_id is null then
    return new;
  end if;
  if new.reassignment_acknowledged_at is distinct from old.reassignment_acknowledged_at
     and new.reassignment_acknowledged_by is not null then
    return new;
  end if;
  if exists (
    select 1
    from public.accounting_sync_records r
    where r.org_id = old.org_id and r.connection_id = old.connection_id
      and coalesce(r.external_id, '') <> ''
      and (
        (r.entity_type = 'invoice' and exists (select 1 from public.invoices i where i.id=r.entity_id and i.project_id=old.project_id))
        or (r.entity_type = 'project_expense' and exists (select 1 from public.project_expenses e where e.id=r.entity_id and e.project_id=old.project_id))
        or (r.entity_type in ('bill','vendor_credit') and exists (select 1 from public.vendor_bills b where b.id=r.entity_id and b.project_id=old.project_id))
      )
  ) then
    raise exception 'Accounting connection cannot change after transactions have synced';
  end if;
  return new;
end;
$$;

create trigger accounting_entity_map_connection_stability
  before update of connection_id on public.accounting_entity_map
  for each row execute function public.guard_accounting_project_reassignment();

revoke all on function public.guard_accounting_project_reassignment() from public, anon, authenticated;

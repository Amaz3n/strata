-- Workstream 08: provider-neutral, connection-scoped links between Arc
-- counterparties and the corresponding vendor/customer in an accounting book.
-- This is additive so it can ship while the compatibility views are still in use.
set lock_timeout = '5s';
set statement_timeout = '120s';

create table public.accounting_counterparty_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.accounting_connections(id) on delete cascade,
  provider text not null default 'qbo',
  role text not null,
  entity_type text not null,
  entity_id uuid not null,
  external_id text not null,
  external_version text,
  external_name text,
  status text not null default 'synced',
  error_message text,
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_counterparty_links_provider_check check (provider in ('qbo')),
  constraint accounting_counterparty_links_role_check check (role in ('vendor', 'customer')),
  constraint accounting_counterparty_links_entity_type_check check (entity_type in ('company', 'contact', 'project')),
  constraint accounting_counterparty_links_status_check check (status in ('synced', 'needs_review', 'error')),
  constraint accounting_counterparty_links_role_entity_check check (
    (role = 'vendor' and entity_type = 'company')
    or (role = 'customer' and entity_type in ('company', 'contact', 'project'))
  ),
  unique (org_id, connection_id, role, entity_type, entity_id)
);

create index accounting_counterparty_links_external_idx
  on public.accounting_counterparty_links (connection_id, role, external_id);
create index accounting_counterparty_links_entity_idx
  on public.accounting_counterparty_links (org_id, entity_type, entity_id);

create trigger accounting_counterparty_links_set_updated_at
  before update on public.accounting_counterparty_links
  for each row execute function public.tg_set_updated_at();

create or replace function public.validate_accounting_counterparty_link()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (
    select 1 from public.accounting_connections c
    where c.id = new.connection_id
      and c.org_id = new.org_id
      and c.provider = new.provider
  ) then
    raise exception 'Accounting connection must belong to the link organization and provider';
  end if;

  if new.entity_type = 'company' and not exists (
    select 1 from public.companies c where c.id = new.entity_id and c.org_id = new.org_id
  ) then
    raise exception 'Company must belong to the link organization';
  elsif new.entity_type = 'contact' and not exists (
    select 1 from public.contacts c where c.id = new.entity_id and c.org_id = new.org_id
  ) then
    raise exception 'Contact must belong to the link organization';
  elsif new.entity_type = 'project' and not exists (
    select 1 from public.projects p where p.id = new.entity_id and p.org_id = new.org_id
  ) then
    raise exception 'Project must belong to the link organization';
  end if;

  return new;
end;
$$;

create trigger accounting_counterparty_links_validate
  before insert or update on public.accounting_counterparty_links
  for each row execute function public.validate_accounting_counterparty_link();

revoke all on function public.validate_accounting_counterparty_link() from public, anon, authenticated;

alter table public.accounting_counterparty_links enable row level security;
create policy accounting_counterparty_links_org_access on public.accounting_counterparty_links
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
grant select, insert, update, delete on public.accounting_counterparty_links to authenticated;
grant all on public.accounting_counterparty_links to service_role;

-- Migrate the relationship rows that were historically stored in the
-- transaction sync ledger. Keep those legacy rows until the post-soak cleanup.
insert into public.accounting_counterparty_links (
  org_id, connection_id, provider, role, entity_type, entity_id,
  external_id, external_version, external_name, status, error_message,
  last_synced_at, metadata, created_at
)
select
  org_id,
  connection_id,
  provider,
  case entity_type when 'vendor' then 'vendor' else 'customer' end,
  case entity_type when 'vendor' then 'company' else 'project' end,
  entity_id,
  external_id,
  external_version,
  nullif(metadata ->> 'display_name', ''),
  case when status in ('synced', 'needs_review', 'error') then status else 'needs_review' end,
  error_message,
  last_synced_at,
  metadata,
  created_at
from public.accounting_sync_records
where entity_type in ('vendor', 'customer')
  and coalesce(external_id, '') <> ''
on conflict (org_id, connection_id, role, entity_type, entity_id) do update set
  external_id = excluded.external_id,
  external_version = excluded.external_version,
  external_name = excluded.external_name,
  status = excluded.status,
  error_message = excluded.error_message,
  last_synced_at = excluded.last_synced_at,
  metadata = excluded.metadata;

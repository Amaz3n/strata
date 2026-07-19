-- Workstream 08 / Phase B1: introduce provider-neutral connections while
-- preserving every live QBO connection id for in-flight sync records.
set lock_timeout = '5s';
set statement_timeout = '120s';

create table public.accounting_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null default 'qbo' check (provider in ('qbo')),
  label text not null default 'QuickBooks',
  external_account_id text not null,
  external_account_name text,
  access_token text not null,
  refresh_token text not null,
  client_id text,
  credentials jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  status text not null default 'active'
    check (status in ('active','expired','disconnected','error')),
  connected_by uuid references public.app_users(id),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz,
  refresh_failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index accounting_connections_provider_account_active_idx
  on public.accounting_connections (org_id, provider, external_account_id)
  where status = 'active';
create index accounting_connections_org_idx
  on public.accounting_connections (org_id, status);
create index accounting_connections_connected_by_idx
  on public.accounting_connections (connected_by);
create index accounting_connections_expires_idx
  on public.accounting_connections (token_expires_at) where status = 'active';
create index accounting_connections_refresh_expiry_idx
  on public.accounting_connections (status, refresh_token_expires_at) where status = 'active';

create trigger accounting_connections_set_updated_at
  before update on public.accounting_connections
  for each row execute function public.tg_set_updated_at();

alter table public.accounting_connections enable row level security;
create policy accounting_connections_org_access on public.accounting_connections
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

grant select, insert, update, delete on public.accounting_connections to authenticated;
grant all on public.accounting_connections to service_role;

insert into public.accounting_connections (
  id, org_id, provider, label, external_account_id, external_account_name,
  access_token, refresh_token, client_id, credentials, settings, status,
  connected_by, connected_at, disconnected_at, last_sync_at, last_error,
  token_expires_at, refresh_token_expires_at, refresh_failure_count,
  created_at, updated_at
)
select
  id, org_id, 'qbo', coalesce(nullif(company_name, ''), 'QuickBooks'), realm_id,
  company_name, access_token, refresh_token, client_id,
  jsonb_strip_nulls(jsonb_build_object(
    'access_token', access_token,
    'refresh_token', refresh_token,
    'client_id', client_id
  )), settings, status,
  connected_by, connected_at, disconnected_at, last_sync_at, last_error,
  token_expires_at, refresh_token_expires_at, refresh_failure_count,
  created_at, updated_at
from public.qbo_connections
on conflict (id) do nothing;

alter table public.qbo_connections rename to qbo_connections_legacy;

create view public.qbo_connections with (security_invoker = true) as
select
  id, org_id, external_account_id as realm_id, access_token, refresh_token,
  token_expires_at, external_account_name as company_name, connected_by,
  connected_at, disconnected_at, status, last_sync_at, last_error, settings,
  created_at, updated_at, refresh_token_expires_at, refresh_failure_count, client_id
from public.accounting_connections
where provider = 'qbo';

grant select, insert, update, delete on public.qbo_connections to authenticated;
grant all on public.qbo_connections to service_role;

create or replace function public.update_qbo_cdc_cursor(
  p_connection_id uuid,
  p_cursor timestamptz
) returns void
language sql
security definer
set search_path = public
as $$
  update public.accounting_connections
  set settings = coalesce(settings, '{}'::jsonb)
    || jsonb_build_object('qbo_cdc_last_synced_at', p_cursor)
  where id = p_connection_id and provider = 'qbo';
$$;
revoke all on function public.update_qbo_cdc_cursor(uuid, timestamptz) from public;
revoke execute on function public.update_qbo_cdc_cursor(uuid, timestamptz) from anon, authenticated;
grant execute on function public.update_qbo_cdc_cursor(uuid, timestamptz) to service_role;

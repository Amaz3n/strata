-- QuickBooks Online integration foundation
-- Schema: connections, sync tracking, invoice number reservations

-- QBO connections per org
create table if not exists qbo_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  realm_id text not null,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  company_name text,
  connected_by uuid references app_users(id),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  status text not null default 'active' check (status in ('active', 'expired', 'disconnected', 'error')),
  last_sync_at timestamptz,
  last_error text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists qbo_connections_org_active_idx on qbo_connections (org_id) where status = 'active';
create index if not exists qbo_connections_expires_idx on qbo_connections (token_expires_at) where status = 'active';
create trigger qbo_connections_set_updated_at before update on qbo_connections for each row execute function public.tg_set_updated_at();
alter table qbo_connections enable row level security;
create policy "qbo_connections_access" on qbo_connections
  for all using (auth.role() = 'service_role' or is_org_member(org_id));

-- Sync tracking (invoice/payment/customer/item mappings)
create table if not exists qbo_sync_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  connection_id uuid not null references qbo_connections(id) on delete cascade,
  entity_type text not null check (entity_type in ('invoice', 'payment', 'customer', 'item')),
  entity_id uuid not null,
  qbo_id text not null,
  qbo_sync_token text,
  last_synced_at timestamptz not null default now(),
  sync_direction text not null default 'outbound' check (sync_direction in ('outbound', 'inbound', 'bidirectional')),
  status text not null default 'synced' check (status in ('synced', 'pending', 'error', 'conflict')),
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists qbo_sync_records_entity_idx on qbo_sync_records (org_id, entity_type, entity_id);
create index if not exists qbo_sync_records_qbo_idx on qbo_sync_records (connection_id, qbo_id);
alter table qbo_sync_records enable row level security;
create policy "qbo_sync_records_access" on qbo_sync_records
  for all using (auth.role() = 'service_role' or is_org_member(org_id));

-- Invoice → QBO references
alter table invoices add column if not exists qbo_id text;
alter table invoices add column if not exists qbo_synced_at timestamptz;
alter table invoices add column if not exists qbo_sync_status text check (qbo_sync_status is null or qbo_sync_status in ('pending', 'synced', 'error', 'skipped'));
create index if not exists invoices_qbo_sync_idx on invoices (org_id, qbo_sync_status) where qbo_sync_status is not null;

-- Invoice number reservations to avoid DocNumber conflicts
create table if not exists qbo_invoice_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  reserved_number text not null,
  reserved_by uuid references app_users(id),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  used_by_invoice_id uuid references invoices(id) on delete set null,
  status text not null default 'reserved' check (status in ('reserved', 'used', 'expired', 'released'))
);

create unique index if not exists qbo_invoice_reservations_active_idx
  on qbo_invoice_reservations (org_id, reserved_number)
  where status = 'reserved';

create index if not exists qbo_invoice_reservations_expires_idx
  on qbo_invoice_reservations (expires_at)
  where status = 'reserved';

alter table qbo_invoice_reservations enable row level security;
create policy "qbo_invoice_reservations_access" on qbo_invoice_reservations
  for all using (auth.role() = 'service_role' or is_org_member(org_id));

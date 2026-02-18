-- External portal account layer (hybrid link + account access).

alter table if exists portal_access_tokens
  add column if not exists require_account boolean not null default false;

alter table if exists bid_access_tokens
  add column if not exists require_account boolean not null default false;

create table if not exists external_portal_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  email citext not null,
  full_name text,
  password_hash text not null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'revoked')),
  last_login_at timestamptz,
  paused_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, email)
);

create index if not exists external_portal_accounts_org_status_idx
  on external_portal_accounts (org_id, status);

create table if not exists external_portal_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  account_id uuid not null references external_portal_accounts(id) on delete cascade,
  session_token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create index if not exists external_portal_sessions_account_idx
  on external_portal_sessions (account_id, expires_at)
  where revoked_at is null;

create table if not exists external_portal_account_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  account_id uuid not null references external_portal_accounts(id) on delete cascade,
  portal_access_token_id uuid references portal_access_tokens(id) on delete cascade,
  bid_access_token_id uuid references bid_access_tokens(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'paused', 'revoked')),
  paused_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (portal_access_token_id is not null)::int +
    (bid_access_token_id is not null)::int = 1
  )
);

create unique index if not exists external_portal_grants_account_portal_token_uidx
  on external_portal_account_grants (account_id, portal_access_token_id)
  where portal_access_token_id is not null;

create unique index if not exists external_portal_grants_account_bid_token_uidx
  on external_portal_account_grants (account_id, bid_access_token_id)
  where bid_access_token_id is not null;

create index if not exists external_portal_grants_portal_token_idx
  on external_portal_account_grants (portal_access_token_id, status)
  where portal_access_token_id is not null;

create index if not exists external_portal_grants_bid_token_idx
  on external_portal_account_grants (bid_access_token_id, status)
  where bid_access_token_id is not null;

alter table external_portal_accounts enable row level security;
alter table external_portal_sessions enable row level security;
alter table external_portal_account_grants enable row level security;

drop policy if exists external_portal_accounts_service_role on external_portal_accounts;
create policy external_portal_accounts_service_role on external_portal_accounts
  for all using (auth.role() = 'service_role');

drop policy if exists external_portal_sessions_service_role on external_portal_sessions;
create policy external_portal_sessions_service_role on external_portal_sessions
  for all using (auth.role() = 'service_role');

drop policy if exists external_portal_account_grants_service_role on external_portal_account_grants;
create policy external_portal_account_grants_service_role on external_portal_account_grants
  for all using (auth.role() = 'service_role');

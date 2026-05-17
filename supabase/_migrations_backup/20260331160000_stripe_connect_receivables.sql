create table if not exists public.stripe_connected_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  stripe_account_id text not null,
  status text not null default 'pending' check (status in ('pending', 'onboarding', 'restricted', 'active', 'disconnected', 'error')),
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  country text,
  default_currency text,
  dashboard_type text,
  requirement_collection text,
  onboarding_started_at timestamptz,
  onboarding_completed_at timestamptz,
  disabled_reason text,
  requirements_currently_due jsonb not null default '[]'::jsonb,
  requirements_eventually_due jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists stripe_connected_accounts_org_idx
  on public.stripe_connected_accounts (org_id);
create unique index if not exists stripe_connected_accounts_account_idx
  on public.stripe_connected_accounts (stripe_account_id);
create index if not exists stripe_connected_accounts_status_idx
  on public.stripe_connected_accounts (org_id, status);

drop trigger if exists stripe_connected_accounts_set_updated_at on public.stripe_connected_accounts;
create trigger stripe_connected_accounts_set_updated_at
before update on public.stripe_connected_accounts
for each row execute function public.tg_set_updated_at();

alter table public.stripe_connected_accounts enable row level security;

drop policy if exists stripe_connected_accounts_access on public.stripe_connected_accounts;
create policy stripe_connected_accounts_access
  on public.stripe_connected_accounts
  for all
  using ((auth.role() = 'service_role'::text) or is_org_member(org_id))
  with check ((auth.role() = 'service_role'::text) or is_org_member(org_id));

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete set null,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  status text not null default 'received' check (status in ('received', 'processed', 'failed', 'ignored')),
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists webhook_events_provider_event_idx
  on public.webhook_events (provider, provider_event_id);
create index if not exists webhook_events_org_idx
  on public.webhook_events (org_id, created_at desc);

alter table public.webhook_events enable row level security;

drop policy if exists webhook_events_access on public.webhook_events;
create policy webhook_events_access
  on public.webhook_events
  for all
  using ((auth.role() = 'service_role'::text) or is_org_member(org_id))
  with check ((auth.role() = 'service_role'::text) or is_org_member(org_id));

alter table if exists public.payment_intents
  add column if not exists connected_account_id text,
  add column if not exists charge_type text,
  add column if not exists provider_charge_id text,
  add column if not exists provider_transfer_id text,
  add column if not exists application_fee_amount integer,
  add column if not exists processor_fee_cents integer,
  add column if not exists platform_fee_cents integer,
  add column if not exists on_behalf_of_account_id text;

create index if not exists payment_intents_connected_account_idx
  on public.payment_intents (connected_account_id);

alter table if exists public.payments
  add column if not exists connected_account_id text,
  add column if not exists provider_charge_id text,
  add column if not exists provider_balance_transaction_id text,
  add column if not exists provider_transfer_id text,
  add column if not exists application_fee_cents integer not null default 0,
  add column if not exists processor_fee_cents integer not null default 0,
  add column if not exists platform_fee_cents integer not null default 0,
  add column if not exists gross_cents integer;

create index if not exists payments_connected_account_idx
  on public.payments (connected_account_id);

-- Payments phase1 scaffold retry without IF on policies
alter table if exists payments add column if not exists status text not null default 'pending';
alter table if exists payments add column if not exists provider text;
alter table if exists payments add column if not exists provider_payment_id text;
alter table if exists payments add column if not exists fee_cents integer default 0;
alter table if exists payments add column if not exists net_cents integer;
alter table if exists payments add column if not exists idempotency_key text;
alter table if exists payments add column if not exists updated_at timestamptz not null default now();
create index if not exists payments_status_idx on payments(status);
create index if not exists payments_provider_idx on payments(provider_payment_id);
create unique index if not exists payments_idempotency_idx on payments(idempotency_key) where idempotency_key is not null;
drop trigger if exists payments_set_updated_at on payments;
create trigger payments_set_updated_at before update on payments for each row execute function public.tg_set_updated_at();

create table if not exists payment_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  invoice_id uuid references invoices(id) on delete set null,
  provider text not null default 'stripe',
  provider_intent_id text,
  status text not null default 'requires_payment_method',
  amount_cents integer not null,
  currency text not null default 'usd',
  client_secret text,
  idempotency_key text,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists payment_intents_provider_intent_idx on payment_intents (provider_intent_id) where provider_intent_id is not null;
create unique index if not exists payment_intents_idempotency_idx on payment_intents (idempotency_key) where idempotency_key is not null;
create index if not exists payment_intents_org_idx on payment_intents (org_id);
create index if not exists payment_intents_invoice_idx on payment_intents (invoice_id);
create index if not exists payment_intents_status_idx on payment_intents (status);
drop trigger if exists payment_intents_set_updated_at on payment_intents;
create trigger payment_intents_set_updated_at before update on payment_intents for each row execute function public.tg_set_updated_at();
alter table payment_intents enable row level security;

create table if not exists payment_methods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  provider text not null default 'stripe',
  provider_method_id text,
  type text not null default 'ach',
  fingerprint text,
  last4 text,
  bank_brand text,
  exp_last4 text,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists payment_methods_provider_method_idx on payment_methods (provider, provider_method_id) where provider_method_id is not null;
create index if not exists payment_methods_org_idx on payment_methods (org_id);
create index if not exists payment_methods_contact_idx on payment_methods (contact_id);
drop trigger if exists payment_methods_set_updated_at on payment_methods;
create trigger payment_methods_set_updated_at before update on payment_methods for each row execute function public.tg_set_updated_at();
alter table payment_methods enable row level security;

create table if not exists payment_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  token_hash text not null,
  nonce text not null,
  expires_at timestamptz,
  max_uses integer,
  used_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists payment_links_token_hash_idx on payment_links (token_hash);
create index if not exists payment_links_org_idx on payment_links (org_id);
create index if not exists payment_links_invoice_idx on payment_links (invoice_id);
drop trigger if exists payment_links_set_updated_at on payment_links;
create trigger payment_links_set_updated_at before update on payment_links for each row execute function public.tg_set_updated_at();
alter table payment_links enable row level security;

create table if not exists late_fees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  strategy text not null default 'fixed',
  amount_cents integer,
  percent_rate numeric,
  grace_days integer default 0,
  repeat_days integer,
  max_applications integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists late_fees_org_idx on late_fees (org_id);
create index if not exists late_fees_project_idx on late_fees (project_id);
drop trigger if exists late_fees_set_updated_at on late_fees;
create trigger late_fees_set_updated_at before update on late_fees for each row execute function public.tg_set_updated_at();
alter table late_fees enable row level security;

create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete cascade,
  channel text not null default 'email',
  schedule text not null default 'before_due',
  offset_days integer not null default 0,
  template_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reminders_org_idx on reminders (org_id);
create index if not exists reminders_invoice_idx on reminders (invoice_id);
drop trigger if exists reminders_set_updated_at on reminders;
create trigger reminders_set_updated_at before update on reminders for each row execute function public.tg_set_updated_at();
alter table reminders enable row level security;

create policy "payment_intents_access" on payment_intents
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "payment_methods_access" on payment_methods
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "payment_links_access" on payment_links
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "late_fees_access" on late_fees
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "reminders_access" on reminders
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));
;

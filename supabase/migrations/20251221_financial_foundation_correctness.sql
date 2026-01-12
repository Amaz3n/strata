-- Stage 7 (Unified MVP Gameplan): Financial foundation correctness + missing primitives
-- Focus: invoice balance correctness, invoice views, receipts, and required indexing.

-- Invoices: add columns used by app services (production-compatible deltas)
alter table if exists invoices alter column project_id drop not null;

alter table if exists invoices add column if not exists token uuid;
alter table if exists invoices add column if not exists title text;
alter table if exists invoices add column if not exists notes text;
alter table if exists invoices add column if not exists client_visible boolean not null default false;
alter table if exists invoices add column if not exists subtotal_cents integer;
alter table if exists invoices add column if not exists tax_cents integer;
alter table if exists invoices add column if not exists viewed_at timestamptz;
alter table if exists invoices add column if not exists sent_at timestamptz;
alter table if exists invoices add column if not exists sent_to_emails text[];
alter table if exists invoices add column if not exists qbo_id text;
alter table if exists invoices add column if not exists qbo_synced_at timestamptz;
alter table if exists invoices add column if not exists qbo_sync_status text;

create index if not exists invoices_org_project_issue_date_idx on invoices (org_id, project_id, issue_date);
create index if not exists invoices_org_status_due_date_idx on invoices (org_id, status, due_date);
create unique index if not exists invoices_org_token_unique_idx on invoices (org_id, token) where token is not null;

-- Invoice lines: add indexes used by rollups/list queries
create index if not exists invoice_lines_org_invoice_idx on invoice_lines (org_id, invoice_id);
create index if not exists invoice_lines_org_cost_code_idx on invoice_lines (org_id, cost_code_id);

-- Invoice views: used by public invoice view tracking
create table if not exists invoice_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  token uuid,
  user_agent text,
  ip_address text,
  viewed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists invoice_views_org_invoice_viewed_idx on invoice_views (org_id, invoice_id, viewed_at desc);

alter table invoice_views enable row level security;

do $$
begin
  create policy "invoice_views_read" on invoice_views
    for select using ((auth.role() = 'service_role'::text) or is_org_member(org_id));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create policy "invoice_views_insert_service" on invoice_views
    for insert with check (auth.role() = 'service_role'::text);
exception
  when duplicate_object then null;
end $$;

-- Payments: ensure indexes/constraints align with service-level idempotency and reporting
create index if not exists payments_org_invoice_status_received_idx on payments (org_id, invoice_id, status, received_at);
create index if not exists payments_org_bill_status_received_idx on payments (org_id, bill_id, status, received_at);
create unique index if not exists payments_org_provider_payment_id_unique_idx on payments (org_id, provider_payment_id) where provider_payment_id is not null;

-- Receipts: make receipts "real" (AR-focused) + idempotency per payment
alter table if exists receipts add column if not exists project_id uuid references projects(id) on delete set null;
alter table if exists receipts add column if not exists invoice_id uuid references invoices(id) on delete set null;
alter table if exists receipts add column if not exists amount_cents integer;
alter table if exists receipts add column if not exists issued_to_email text;
alter table if exists receipts add column if not exists created_at timestamptz not null default now();

create unique index if not exists receipts_payment_unique_idx on receipts (payment_id) where payment_id is not null;
create index if not exists receipts_org_invoice_idx on receipts (org_id, invoice_id);


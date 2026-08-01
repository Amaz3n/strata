-- Arc Books B1-B5.8 accounting foundation.
--
-- Additive only. Arc Books is optional per organization: external accounting
-- providers remain a permanent supported posture. This migration deliberately
-- stores provider references rather than bank-feed or tax-vault secrets.
--
-- IMPORTANT: migration is written, not applied. Production approval is required.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- RBAC and accountant role
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('books.read', 'View Arc Books ledgers, periods, reconciliations, and statements'),
  ('books.manage', 'Manage accounting setup, coding rules, and opening balances'),
  ('books.adjust', 'Create and approve adjusting and reversing journal entries'),
  ('books.reconcile', 'Manage accounting comparisons and bank reconciliations'),
  ('books.close', 'Review and close accounting periods'),
  ('books.reopen', 'Reopen a closed accounting period'),
  ('books.cutover', 'Change the organization ledger of record'),
  ('books.export', 'Create complete accounting and accountant-package exports'),
  ('books.tax', 'Manage tax readiness and accountant handoff data')
on conflict (key) do update set description = excluded.description;

insert into public.roles (key, label, scope, description) values (
  'org_accountant',
  'Accountant',
  'org',
  'Reviews books, reconciliations, statements, tax readiness, and approved adjustments without operational administration.'
)
on conflict (key) do update set
  label = excluded.label,
  scope = excluded.scope,
  description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'books.read','books.manage','books.adjust','books.reconcile','books.close',
  'books.reopen','books.cutover','books.export','books.tax'
]) p(permission_key)
where r.key in ('org_owner','org_admin')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'books.read','books.manage','books.adjust','books.reconcile','books.close',
  'books.export','books.tax'
]) p(permission_key)
where r.key in ('org_office_admin','org_bookkeeper')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'books.read','books.adjust','books.reconcile','books.close','books.export','books.tax'
]) p(permission_key)
where r.key = 'org_accountant'
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'report.read'
from public.roles r
where r.key = 'org_accountant'
on conflict (role_id, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- B5.0: accounting constitution and authority posture
-- ---------------------------------------------------------------------------

create table public.books_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.orgs(id) on delete cascade,
  ledger_authority text not null default 'external'
    check (ledger_authority in ('external','arc')),
  arc_ledger_mode text not null default 'disabled'
    check (arc_ledger_mode in ('disabled','shadow','parallel','official')),
  external_sync_posture text not null default 'normal'
    check (external_sync_posture in ('normal','outbound_mirror','disconnected')),
  external_provider text,
  functional_currency text not null default 'usd'
    check (functional_currency = lower(functional_currency) and length(functional_currency) = 3),
  reporting_basis text not null default 'accrual'
    check (reporting_basis = 'accrual'),
  fiscal_year_start_month smallint not null default 1
    check (fiscal_year_start_month between 1 and 12),
  active_policy_version integer not null default 1 check (active_policy_version > 0),
  authoritative_at timestamptz,
  authoritative_by uuid references public.app_users(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint books_settings_authority_mode_check check (
    (ledger_authority = 'external' and arc_ledger_mode in ('disabled','shadow','parallel') and external_sync_posture = 'normal')
    or
    (ledger_authority = 'arc' and arc_ledger_mode = 'official' and external_sync_posture in ('outbound_mirror','disconnected'))
  )
);

create table public.accounting_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft','approved','superseded')),
  effective_on date not null,
  policy jsonb not null default '{}'::jsonb check (jsonb_typeof(policy) = 'object'),
  approved_by uuid references public.app_users(id) on delete set null,
  approved_at timestamptz,
  approval_note text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, version),
  constraint accounting_policies_approval_check check (
    (status = 'draft' and approved_at is null)
    or (status in ('approved','superseded') and approved_at is not null)
  )
);

-- ---------------------------------------------------------------------------
-- B1: deterministic coding rules and touch instrumentation support
-- ---------------------------------------------------------------------------

create table public.coding_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  match_kind text not null
    check (match_kind in ('vendor','vendor_memo','card_scope','email_sender')),
  company_id uuid references public.companies(id) on delete cascade,
  match_value text not null check (length(btrim(match_value)) > 0),
  memo_pattern text,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  budget_line_id uuid references public.budget_lines(id) on delete set null,
  accounting_coding jsonb not null default '{}'::jsonb check (jsonb_typeof(accounting_coding) = 'object'),
  confidence numeric(5,4) not null default 0 check (confidence between 0 and 1),
  hit_count integer not null default 0 check (hit_count >= 0),
  correction_count integer not null default 0 check (correction_count >= 0),
  last_hit_at timestamptz,
  last_corrected_at timestamptz,
  created_from text not null check (created_from in ('user_correction','import','seed')),
  active boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (org_id, match_kind, company_id, match_value, memo_pattern)
);

create index coding_rules_match_idx
  on public.coding_rules (org_id, active, match_kind, match_value);
create index coding_rules_company_idx
  on public.coding_rules (org_id, company_id, active) where company_id is not null;

-- ---------------------------------------------------------------------------
-- Corrected B4: chart, immutable facts, journal, and organization periods
-- ---------------------------------------------------------------------------

create table public.gl_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  code text not null check (length(btrim(code)) > 0),
  name text not null check (length(btrim(name)) > 0),
  account_type text not null
    check (account_type in ('asset','liability','equity','income','cogs','expense')),
  subtype text not null,
  normal_balance text not null check (normal_balance in ('debit','credit')),
  cash_flow_category text check (cash_flow_category in ('operating','investing','financing','cash')),
  parent_id uuid references public.gl_accounts(id) on delete restrict,
  is_system boolean not null default false,
  active boolean not null default true,
  description text,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

create index gl_accounts_org_type_idx on public.gl_accounts (org_id, account_type, active);
create index gl_accounts_parent_idx on public.gl_accounts (parent_id) where parent_id is not null;

create table public.accounting_account_mappings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.accounting_connections(id) on delete cascade,
  gl_account_id uuid not null references public.gl_accounts(id) on delete cascade,
  external_account_id text not null,
  external_account_name text,
  mapping_source text not null default 'manual' check (mapping_source in ('manual','import','suggested')),
  approved_by uuid references public.app_users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, connection_id, gl_account_id),
  unique (org_id, connection_id, external_account_id)
);

create index accounting_account_mappings_connection_idx
  on public.accounting_account_mappings (org_id, connection_id, gl_account_id);

create table public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  fiscal_year integer not null,
  fiscal_period smallint not null check (fiscal_period between 1 and 13),
  status text not null default 'open' check (status in ('open','reviewing','closed','reopened')),
  close_digest text,
  closed_by uuid references public.app_users(id) on delete set null,
  closed_at timestamptz,
  reopened_by uuid references public.app_users(id) on delete set null,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, period_start),
  unique (org_id, fiscal_year, fiscal_period),
  check (period_end >= period_start),
  constraint accounting_periods_close_state_check check (
    (status <> 'closed') or (closed_at is not null and closed_by is not null and close_digest is not null)
  )
);

create index accounting_periods_org_dates_idx
  on public.accounting_periods (org_id, period_start, period_end);
create index accounting_periods_org_status_idx
  on public.accounting_periods (org_id, status, period_end desc);

create table public.accounting_facts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source_type text not null,
  source_id uuid not null,
  source_version integer not null check (source_version > 0),
  fact_kind text not null,
  occurred_at timestamptz not null,
  accounting_date date not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_hash text not null check (length(payload_hash) >= 32),
  policy_version integer not null check (policy_version > 0),
  supersedes_fact_id uuid references public.accounting_facts(id) on delete restrict,
  reversal_of_fact_id uuid references public.accounting_facts(id) on delete restrict,
  idempotency_key text not null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, source_type, source_id, source_version),
  unique (org_id, idempotency_key)
);

create index accounting_facts_org_date_idx
  on public.accounting_facts (org_id, accounting_date, created_at);
create index accounting_facts_source_idx
  on public.accounting_facts (org_id, source_type, source_id, source_version desc);
create index accounting_facts_supersedes_idx
  on public.accounting_facts (supersedes_fact_id) where supersedes_fact_id is not null;

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  fact_id uuid references public.accounting_facts(id) on delete restrict,
  period_id uuid references public.accounting_periods(id) on delete restrict,
  entry_date date not null,
  entry_kind text not null
    check (entry_kind in ('operational','adjusting','opening','poc','closing','reversal')),
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  memo text not null,
  posting_key text not null,
  projection_version integer not null default 1 check (projection_version > 0),
  policy_version integer not null check (policy_version > 0),
  source_type text,
  source_id uuid,
  reversal_of_entry_id uuid references public.journal_entries(id) on delete restrict,
  posted_by uuid references public.app_users(id) on delete set null,
  posted_at timestamptz,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, posting_key),
  constraint journal_entries_posted_state_check check (
    (status = 'draft' and posted_at is null)
    or (status in ('posted','reversed') and posted_at is not null)
  )
);

create index journal_entries_org_date_idx
  on public.journal_entries (org_id, entry_date, status);
create index journal_entries_fact_idx on public.journal_entries (fact_id) where fact_id is not null;
create index journal_entries_period_idx on public.journal_entries (period_id) where period_id is not null;
create index journal_entries_source_idx
  on public.journal_entries (org_id, source_type, source_id) where source_id is not null;

create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  entry_id uuid not null references public.journal_entries(id) on delete cascade,
  line_no smallint not null check (line_no > 0),
  account_id uuid not null references public.gl_accounts(id) on delete restrict,
  project_id uuid references public.projects(id) on delete restrict,
  company_id uuid references public.companies(id) on delete restrict,
  description text,
  debit_cents bigint not null default 0 check (debit_cents >= 0),
  credit_cents bigint not null default 0 check (credit_cents >= 0),
  dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions) = 'object'),
  created_at timestamptz not null default now(),
  unique (entry_id, line_no),
  check (
    (debit_cents > 0 and credit_cents = 0)
    or (credit_cents > 0 and debit_cents = 0)
  )
);

create index journal_lines_org_account_idx
  on public.journal_lines (org_id, account_id, entry_id);
create index journal_lines_org_project_idx
  on public.journal_lines (org_id, project_id, entry_id) where project_id is not null;
create index journal_lines_company_idx on public.journal_lines (company_id) where company_id is not null;

-- ---------------------------------------------------------------------------
-- B2/B3/B5.1: continuous reconciliation, POC snapshots, parallel comparisons
-- ---------------------------------------------------------------------------

create table public.accounting_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid references public.accounting_connections(id) on delete set null,
  run_date date not null,
  status text not null check (status in ('running','passed','warning','failed')),
  checked_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(checked_counts) = 'object'),
  discrepancy_count integer not null default 0 check (discrepancy_count >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

create index accounting_reconciliation_runs_org_date_idx
  on public.accounting_reconciliation_runs (org_id, run_date desc, created_at desc);

create table public.accounting_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid not null references public.accounting_reconciliation_runs(id) on delete cascade,
  category text not null,
  entity_type text,
  entity_id uuid,
  local_amount_cents bigint,
  external_amount_cents bigint,
  difference_cents bigint,
  status text not null default 'open' check (status in ('open','explained','resolved','ignored')),
  explanation text,
  resolved_by uuid references public.app_users(id) on delete set null,
  resolved_at timestamptz,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index accounting_reconciliation_items_run_idx
  on public.accounting_reconciliation_items (run_id, status, category);
create index accounting_reconciliation_items_org_entity_idx
  on public.accounting_reconciliation_items (org_id, entity_type, entity_id);

create table public.poc_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  as_of date not null,
  original_contract_cents bigint not null,
  approved_change_orders_cents bigint not null,
  revised_contract_cents bigint not null,
  cost_to_date_cents bigint not null,
  eac_cents bigint not null,
  percent_complete numeric(8,5) not null,
  earned_revenue_cents bigint not null,
  billed_cents bigint not null,
  over_under_cents bigint not null,
  forecast_gross_profit_cents bigint not null,
  inputs_hash text not null,
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  created_at timestamptz not null default now(),
  unique (org_id, project_id, as_of, inputs_hash)
);

create index poc_snapshots_org_date_idx on public.poc_snapshots (org_id, as_of desc);
create index poc_snapshots_project_date_idx on public.poc_snapshots (project_id, as_of desc);

create table public.books_comparison_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.accounting_connections(id) on delete restrict,
  period_id uuid not null references public.accounting_periods(id) on delete restrict,
  status text not null default 'running' check (status in ('running','passed','warning','failed','approved')),
  policy_version integer not null,
  chart_version integer not null default 1,
  variance_count integer not null default 0 check (variance_count >= 0),
  unexplained_variance_count integer not null default 0 check (unexplained_variance_count >= 0),
  digest text,
  approval_note text,
  created_by uuid references public.app_users(id) on delete set null,
  approved_by uuid references public.app_users(id) on delete set null,
  approved_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, connection_id, period_id)
);

create table public.books_comparison_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid not null references public.books_comparison_runs(id) on delete cascade,
  account_id uuid references public.gl_accounts(id) on delete restrict,
  external_account_id text,
  category text not null,
  arc_amount_cents bigint not null,
  external_amount_cents bigint not null,
  difference_cents bigint not null,
  variance_reason text check (variance_reason in ('timing','mapping','missing_source','policy','duplicate','rounding','defect')),
  explanation text,
  status text not null default 'unexplained' check (status in ('unexplained','explained','resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index books_comparison_items_run_idx on public.books_comparison_items (run_id, status, category);

-- ---------------------------------------------------------------------------
-- B5.2: guided opening balances
-- ---------------------------------------------------------------------------

create table public.opening_balance_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid references public.accounting_connections(id) on delete set null,
  cutover_date date not null,
  status text not null default 'draft'
    check (status in ('draft','validated','approved','posted','reversed')),
  source_filename text,
  source_content_hash text,
  source_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(source_metadata) = 'object'),
  debit_total_cents bigint not null default 0,
  credit_total_cents bigint not null default 0,
  validation_errors jsonb not null default '[]'::jsonb check (jsonb_typeof(validation_errors) = 'array'),
  digest text,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  approved_by uuid references public.app_users(id) on delete set null,
  approved_at timestamptz,
  posted_at timestamptz,
  reversed_at timestamptz,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (org_id, cutover_date, source_content_hash)
);

create table public.opening_balance_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  batch_id uuid not null references public.opening_balance_batches(id) on delete cascade,
  line_no integer not null check (line_no > 0),
  account_id uuid not null references public.gl_accounts(id) on delete restrict,
  subledger_type text check (subledger_type in ('ar','ap','bank','credit_card','loan','fixed_asset','deposit','equity','other')),
  source_entity_type text,
  source_entity_id text,
  project_id uuid references public.projects(id) on delete restrict,
  company_id uuid references public.companies(id) on delete restrict,
  description text,
  debit_cents bigint not null default 0 check (debit_cents >= 0),
  credit_cents bigint not null default 0 check (credit_cents >= 0),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  unique (batch_id, line_no),
  check (
    (debit_cents > 0 and credit_cents = 0)
    or (credit_cents > 0 and debit_cents = 0)
  )
);

create index opening_balance_lines_batch_idx on public.opening_balance_lines (batch_id, line_no);
create index opening_balance_lines_org_account_idx on public.opening_balance_lines (org_id, account_id);

create table public.opening_balance_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  batch_id uuid not null references public.opening_balance_batches(id) on delete cascade,
  approval_role text not null check (approval_role in ('owner','accountant')),
  approved_by uuid not null references public.app_users(id) on delete restrict,
  approved_digest text not null,
  approved_at timestamptz not null default now(),
  unique (batch_id, approval_role),
  unique (batch_id, approved_by)
);

-- ---------------------------------------------------------------------------
-- B5.3: Plaid-first provider-neutral bank feeds and reconciliation
-- ---------------------------------------------------------------------------

create table public.bank_feed_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null default 'plaid',
  external_item_id text not null,
  secret_ref text not null,
  institution_id text,
  institution_name text,
  status text not null default 'active'
    check (status in ('pending','active','reauth_required','error','disconnected')),
  cursor text,
  consent_expires_at timestamptz,
  last_refresh_at timestamptz,
  last_webhook_at timestamptz,
  last_error text,
  connected_by uuid references public.app_users(id) on delete set null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_item_id)
);

create index bank_feed_connections_org_status_idx
  on public.bank_feed_connections (org_id, status);

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.bank_feed_connections(id) on delete cascade,
  provider text not null default 'plaid',
  external_account_id text not null,
  gl_account_id uuid references public.gl_accounts(id) on delete restrict,
  name text not null,
  official_name text,
  mask text,
  account_type text not null check (account_type in ('depository','credit','loan','investment','other')),
  account_subtype text,
  currency text not null default 'usd',
  current_balance_cents bigint,
  available_balance_cents bigint,
  balance_as_of timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, external_account_id)
);

create index bank_accounts_org_active_idx on public.bank_accounts (org_id, active, account_type);
create index bank_accounts_gl_idx on public.bank_accounts (gl_account_id) where gl_account_id is not null;

create table public.bank_feed_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.bank_feed_connections(id) on delete cascade,
  provider text not null,
  provider_event_id text,
  event_type text not null,
  signature_verified boolean not null default false,
  payload_hash text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  processing_status text not null default 'pending'
    check (processing_status in ('pending','processing','processed','failed','ignored')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processed_at timestamptz,
  error_message text,
  received_at timestamptz not null default now(),
  unique nulls not distinct (provider, provider_event_id, payload_hash)
);

create index bank_feed_events_processing_idx
  on public.bank_feed_events (processing_status, received_at);

create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  provider text not null,
  external_transaction_id text not null,
  lifecycle_status text not null
    check (lifecycle_status in ('pending','posted','removed','voided')),
  transaction_date date not null,
  authorized_date date,
  amount_cents bigint not null,
  direction text not null check (direction in ('inflow','outflow')),
  currency text not null default 'usd',
  merchant_name text,
  description text not null,
  pending_external_id text,
  category jsonb not null default '[]'::jsonb check (jsonb_typeof(category) = 'array'),
  excluded boolean not null default false,
  latest_revision integer not null default 1 check (latest_revision > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_transaction_id)
);

create index bank_transactions_org_date_idx
  on public.bank_transactions (org_id, transaction_date desc, id);
create index bank_transactions_account_status_idx
  on public.bank_transactions (bank_account_id, lifecycle_status, transaction_date desc);

create table public.bank_transaction_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  revision integer not null check (revision > 0),
  change_kind text not null check (change_kind in ('added','modified','removed','pending_posted')),
  payload_hash text not null,
  normalized_payload jsonb not null check (jsonb_typeof(normalized_payload) = 'object'),
  provider_event_id uuid references public.bank_feed_events(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (bank_transaction_id, revision),
  unique (bank_transaction_id, payload_hash)
);

create index bank_transaction_revisions_org_txn_idx
  on public.bank_transaction_revisions (org_id, bank_transaction_id, revision desc);

create table public.bank_transaction_matches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  journal_line_id uuid references public.journal_lines(id) on delete restrict,
  matched_amount_cents bigint not null check (matched_amount_cents > 0),
  match_type text not null check (match_type in ('provider_identity','transfer','exact','suggested','manual_split','excluded')),
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  status text not null default 'suggested' check (status in ('suggested','confirmed','rejected','reversed')),
  confirmed_by uuid references public.app_users(id) on delete set null,
  confirmed_at timestamptz,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bank_transaction_matches_txn_idx
  on public.bank_transaction_matches (bank_transaction_id, status);
create index bank_transaction_matches_line_idx
  on public.bank_transaction_matches (journal_line_id) where journal_line_id is not null;

create table public.bank_reconciliations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete restrict,
  statement_start date not null,
  statement_end date not null,
  beginning_balance_cents bigint not null,
  ending_balance_cents bigint not null,
  cleared_balance_cents bigint not null default 0,
  difference_cents bigint not null default 0,
  status text not null default 'draft' check (status in ('draft','reviewing','closed','reopened')),
  statement_file_id uuid references public.files(id) on delete set null,
  digest text,
  closed_by uuid references public.app_users(id) on delete set null,
  closed_at timestamptz,
  reopened_by uuid references public.app_users(id) on delete set null,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bank_account_id, statement_end),
  check (statement_end >= statement_start),
  constraint bank_reconciliations_close_check check (
    status <> 'closed' or (difference_cents = 0 and closed_at is not null and closed_by is not null and digest is not null)
  )
);

create index bank_reconciliations_org_end_idx
  on public.bank_reconciliations (org_id, statement_end desc);

create table public.bank_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  reconciliation_id uuid not null references public.bank_reconciliations(id) on delete cascade,
  bank_transaction_id uuid references public.bank_transactions(id) on delete restrict,
  journal_line_id uuid references public.journal_lines(id) on delete restrict,
  amount_cents bigint not null,
  item_status text not null check (item_status in ('cleared','outstanding','excluded')),
  created_at timestamptz not null default now(),
  unique nulls not distinct (reconciliation_id, bank_transaction_id, journal_line_id)
);

create index bank_reconciliation_items_reconciliation_idx
  on public.bank_reconciliation_items (reconciliation_id, item_status);

-- ---------------------------------------------------------------------------
-- B5.4: ordinary business bookkeeping and recurring journals
-- ---------------------------------------------------------------------------

create table public.recurring_posting_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  memo text not null,
  frequency text not null check (frequency in ('weekly','monthly','quarterly','annually')),
  next_run_on date not null,
  end_on date,
  status text not null default 'active' check (status in ('active','paused','completed')),
  auto_post boolean not null default false,
  requires_approval boolean not null default true,
  last_notified_on date,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_on is null or end_on >= next_run_on)
);

create table public.recurring_posting_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  template_id uuid not null references public.recurring_posting_templates(id) on delete cascade,
  line_no smallint not null check (line_no > 0),
  account_id uuid not null references public.gl_accounts(id) on delete restrict,
  project_id uuid references public.projects(id) on delete restrict,
  company_id uuid references public.companies(id) on delete restrict,
  debit_cents bigint not null default 0 check (debit_cents >= 0),
  credit_cents bigint not null default 0 check (credit_cents >= 0),
  description text,
  unique (template_id, line_no),
  check (
    (debit_cents > 0 and credit_cents = 0)
    or (credit_cents > 0 and debit_cents = 0)
  )
);

create index recurring_posting_templates_due_idx
  on public.recurring_posting_templates (status, next_run_on);

-- ---------------------------------------------------------------------------
-- B5.5: close checklist and official statement snapshots
-- ---------------------------------------------------------------------------

create table public.books_close_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  period_id uuid not null references public.accounting_periods(id) on delete cascade,
  code text not null,
  label text not null,
  category text not null,
  blocking boolean not null default true,
  status text not null default 'pending' check (status in ('pending','passed','warning','failed','acknowledged')),
  issue_count integer not null default 0 check (issue_count >= 0),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  acknowledged_by uuid references public.app_users(id) on delete set null,
  acknowledged_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (period_id, code)
);

create index books_close_items_period_idx on public.books_close_items (period_id, status, blocking);

create table public.financial_statement_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  period_id uuid not null references public.accounting_periods(id) on delete restrict,
  statement_type text not null
    check (statement_type in ('trial_balance','general_ledger','profit_loss','balance_sheet','cash_flow','ar_aging','ap_aging','wip','project_profitability')),
  basis text not null check (basis in ('accrual','cash')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  content_hash text not null,
  generated_at timestamptz not null default now(),
  generated_by uuid references public.app_users(id) on delete set null,
  unique (period_id, statement_type, basis, content_hash)
);

create index financial_statement_snapshots_org_period_idx
  on public.financial_statement_snapshots (org_id, period_id, statement_type);

-- ---------------------------------------------------------------------------
-- B5.6: effective-dated tax policy and accountant packages
-- ---------------------------------------------------------------------------

alter table public.companies
  add column if not exists w9_version text,
  add column if not exists w9_signed_on date,
  add column if not exists tax_exempt boolean not null default false,
  add column if not exists filing_name text,
  add column if not exists filing_address jsonb not null default '{}'::jsonb,
  add column if not exists tin_verification_status text not null default 'unverified',
  add column if not exists backup_withholding boolean not null default false,
  add column if not exists tax_exception_note text;

alter table public.companies
  add constraint companies_tin_verification_status_check
  check (tin_verification_status in ('unverified','pending','verified','failed'));

create table public.tax_policy_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete cascade,
  tax_year integer not null check (tax_year between 2000 and 2200),
  form_type text not null,
  jurisdiction text not null default 'US',
  effective_from date not null,
  effective_to date,
  threshold_cents bigint not null check (threshold_cents >= 0),
  rules jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  source_url text not null,
  approved_by uuid references public.app_users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique nulls not distinct (org_id, tax_year, form_type, jurisdiction),
  check (effective_to is null or effective_to >= effective_from)
);

create table public.tax_identity_refs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  vault_provider text not null,
  vault_reference text not null,
  tin_last4 text check (tin_last4 is null or tin_last4 ~ '^[0-9]{4}$'),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','pending','verified','failed')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, company_id, vault_provider),
  unique (vault_provider, vault_reference)
);

insert into public.tax_policy_versions (
  org_id, tax_year, form_type, jurisdiction, effective_from, effective_to,
  threshold_cents, rules, source_url, approved_at
) values
  (null, 2025, '1099-NEC', 'US', '2025-01-01', '2025-12-31', 60000,
   '{"payment_basis":"cash","effective_dated":true}'::jsonb,
   'https://www.irs.gov/publications/p1099', now()),
  (null, 2026, '1099-NEC', 'US', '2026-01-01', '2026-12-31', 200000,
   '{"payment_basis":"cash","effective_dated":true,"inflation_adjustment_begins_after":2026}'::jsonb,
   'https://www.irs.gov/businesses/small-businesses-self-employed/am-i-required-to-file-a-form-1099-or-other-information-return', now())
on conflict (org_id, tax_year, form_type, jurisdiction) do update set
  threshold_cents = excluded.threshold_cents,
  rules = excluded.rules,
  source_url = excluded.source_url,
  effective_from = excluded.effective_from,
  effective_to = excluded.effective_to;

create table public.accountant_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  period_id uuid references public.accounting_periods(id) on delete restrict,
  tax_year integer,
  status text not null default 'queued' check (status in ('queued','generating','ready','failed','expired')),
  storage_path text,
  content_hash text,
  manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(manifest) = 'object'),
  requested_by uuid references public.app_users(id) on delete set null,
  requested_at timestamptz not null default now(),
  downloaded_by uuid references public.app_users(id) on delete set null,
  downloaded_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  error_message text,
  check (period_id is not null or tax_year is not null)
);

create index accountant_packages_org_requested_idx
  on public.accountant_packages (org_id, requested_at desc);

-- ---------------------------------------------------------------------------
-- B5.7: portable exports and ledger rebuild verification
-- ---------------------------------------------------------------------------

create table public.books_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  export_type text not null check (export_type in ('complete','accountant','cutover','period')),
  schema_version integer not null default 1 check (schema_version > 0),
  status text not null default 'queued' check (status in ('queued','generating','verifying','ready','failed','expired')),
  storage_path text,
  content_hash text,
  manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(manifest) = 'object'),
  verification jsonb not null default '{}'::jsonb check (jsonb_typeof(verification) = 'object'),
  requested_by uuid references public.app_users(id) on delete set null,
  requested_at timestamptz not null default now(),
  downloaded_by uuid references public.app_users(id) on delete set null,
  downloaded_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  error_message text
);

create index books_exports_org_requested_idx on public.books_exports (org_id, requested_at desc);

create table public.ledger_rebuild_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  export_id uuid references public.books_exports(id) on delete set null,
  status text not null default 'running' check (status in ('running','passed','failed')),
  source_fact_count bigint not null default 0,
  rebuilt_entry_count bigint not null default 0,
  expected_digest text,
  rebuilt_digest text,
  differences jsonb not null default '[]'::jsonb check (jsonb_typeof(differences) = 'array'),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index ledger_rebuild_runs_org_started_idx on public.ledger_rebuild_runs (org_id, started_at desc);

-- ---------------------------------------------------------------------------
-- B5.8: optional, organization-scoped ledger-authority cutover
-- ---------------------------------------------------------------------------

create table public.books_cutover_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid references public.accounting_connections(id) on delete restrict,
  cutover_date date not null,
  target_posture text not null check (target_posture in ('outbound_mirror','disconnected')),
  status text not null default 'draft'
    check (status in ('draft','validating','blocked','ready','completed','rolled_back','failed')),
  prerequisites jsonb not null default '{}'::jsonb check (jsonb_typeof(prerequisites) = 'object'),
  blockers jsonb not null default '[]'::jsonb check (jsonb_typeof(blockers) = 'array'),
  digest text,
  final_sync_marker text,
  rollback_deadline timestamptz,
  requested_by uuid references public.app_users(id) on delete set null,
  completed_by uuid references public.app_users(id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  rolled_back_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, cutover_date, digest)
);

create table public.books_cutover_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  cutover_run_id uuid not null references public.books_cutover_runs(id) on delete cascade,
  approval_role text not null check (approval_role in ('owner','accountant')),
  approved_by uuid not null references public.app_users(id) on delete restrict,
  approved_digest text not null,
  approved_at timestamptz not null default now(),
  unique (cutover_run_id, approval_role),
  unique (cutover_run_id, approved_by)
);

create index books_cutover_runs_org_status_idx on public.books_cutover_runs (org_id, status, cutover_date);

-- ---------------------------------------------------------------------------
-- Structural validation and immutability
-- ---------------------------------------------------------------------------

create or replace function public.books_reject_mutation()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

create trigger accounting_facts_immutable
  before update or delete on public.accounting_facts
  for each row execute function public.books_reject_mutation();
create trigger poc_snapshots_immutable
  before update or delete on public.poc_snapshots
  for each row execute function public.books_reject_mutation();
create trigger bank_feed_events_immutable
  before update or delete on public.bank_feed_events
  for each row when (old.processing_status in ('processed','ignored'))
  execute function public.books_reject_mutation();
create trigger bank_transaction_revisions_immutable
  before update or delete on public.bank_transaction_revisions
  for each row execute function public.books_reject_mutation();
create trigger financial_statement_snapshots_immutable
  before update or delete on public.financial_statement_snapshots
  for each row execute function public.books_reject_mutation();
create trigger books_cutover_approvals_immutable
  before update or delete on public.books_cutover_approvals
  for each row execute function public.books_reject_mutation();
create trigger opening_balance_approvals_immutable
  before update or delete on public.opening_balance_approvals
  for each row execute function public.books_reject_mutation();

create or replace function public.books_validate_period_range()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if exists (
    select 1
    from public.accounting_periods p
    where p.org_id = new.org_id
      and p.id <> new.id
      and daterange(p.period_start, p.period_end, '[]') && daterange(new.period_start, new.period_end, '[]')
  ) then
    raise exception 'Accounting periods cannot overlap';
  end if;
  return new;
end;
$$;

create trigger accounting_periods_validate_range
  before insert or update of org_id, period_start, period_end on public.accounting_periods
  for each row execute function public.books_validate_period_range();

create or replace function public.books_validate_journal_line_scope()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if not exists (
    select 1 from public.journal_entries e
    where e.id = new.entry_id and e.org_id = new.org_id
  ) then
    raise exception 'Journal entry must belong to the line organization';
  end if;
  if not exists (
    select 1 from public.gl_accounts a
    where a.id = new.account_id and a.org_id = new.org_id
  ) then
    raise exception 'GL account must belong to the line organization';
  end if;
  if new.project_id is not null and not exists (
    select 1 from public.projects p
    where p.id = new.project_id and p.org_id = new.org_id
  ) then
    raise exception 'Project must belong to the line organization';
  end if;
  if new.company_id is not null and not exists (
    select 1 from public.companies c
    where c.id = new.company_id and c.org_id = new.org_id
  ) then
    raise exception 'Company must belong to the line organization';
  end if;
  return new;
end;
$$;

create trigger journal_lines_validate_scope
  before insert or update on public.journal_lines
  for each row execute function public.books_validate_journal_line_scope();

create or replace function public.books_validate_account_mapping_scope()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if not exists (select 1 from public.accounting_connections c where c.id = new.connection_id and c.org_id = new.org_id) then
    raise exception 'Accounting connection must belong to the mapping organization';
  end if;
  if not exists (select 1 from public.gl_accounts a where a.id = new.gl_account_id and a.org_id = new.org_id) then
    raise exception 'GL account must belong to the mapping organization';
  end if;
  return new;
end;
$$;

create trigger accounting_account_mappings_validate_scope
  before insert or update on public.accounting_account_mappings
  for each row execute function public.books_validate_account_mapping_scope();

create or replace function public.books_guard_posted_journal()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  parent_status text;
begin
  if tg_table_name = 'journal_entries' then
    if old.status in ('posted','reversed') then
      raise exception 'Posted journal entries are immutable; create a reversal';
    end if;
  else
    select status into parent_status
    from public.journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
    if parent_status in ('posted','reversed') then
      raise exception 'Posted journal lines are immutable; create a reversal';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger journal_entries_guard_posted
  before update or delete on public.journal_entries
  for each row execute function public.books_guard_posted_journal();
create trigger journal_lines_guard_posted
  before update or delete on public.journal_lines
  for each row execute function public.books_guard_posted_journal();

create or replace function public.books_assert_journal_balanced()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  target_entry_id uuid;
  target_status text;
  debit_total bigint;
  credit_total bigint;
  line_count bigint;
begin
  target_entry_id := case
    when tg_table_name = 'journal_entries' then coalesce(new.id, old.id)
    else coalesce(new.entry_id, old.entry_id)
  end;

  select status into target_status from public.journal_entries where id = target_entry_id;
  if target_status is distinct from 'posted' then
    return null;
  end if;

  select coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0), count(*)
  into debit_total, credit_total, line_count
  from public.journal_lines
  where entry_id = target_entry_id;

  if line_count < 2 or debit_total <= 0 or debit_total <> credit_total then
    raise exception 'Posted journal entry % is not balanced', target_entry_id;
  end if;
  return null;
end;
$$;

create constraint trigger journal_entries_balanced
  after insert or update on public.journal_entries
  deferrable initially deferred
  for each row execute function public.books_assert_journal_balanced();
create constraint trigger journal_lines_balanced
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function public.books_assert_journal_balanced();

create or replace function public.books_guard_closed_period()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status = 'posted' and exists (
    select 1 from public.accounting_periods p
    where p.org_id = new.org_id
      and new.entry_date between p.period_start and p.period_end
      and p.status = 'closed'
  ) then
    raise exception 'Cannot post into a closed accounting period';
  end if;
  return new;
end;
$$;

create trigger journal_entries_closed_period_guard
  before insert or update of status, entry_date on public.journal_entries
  for each row execute function public.books_guard_closed_period();

create or replace function public.books_validate_child_org()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  parent_org uuid;
begin
  if tg_table_name = 'accounting_reconciliation_items' then
    select org_id into parent_org from public.accounting_reconciliation_runs where id = new.run_id;
  elsif tg_table_name = 'books_comparison_items' then
    select org_id into parent_org from public.books_comparison_runs where id = new.run_id;
  elsif tg_table_name = 'opening_balance_lines' then
    select org_id into parent_org from public.opening_balance_batches where id = new.batch_id;
  elsif tg_table_name = 'opening_balance_approvals' then
    select org_id into parent_org from public.opening_balance_batches where id = new.batch_id;
  elsif tg_table_name = 'bank_reconciliation_items' then
    select org_id into parent_org from public.bank_reconciliations where id = new.reconciliation_id;
  elsif tg_table_name = 'recurring_posting_lines' then
    select org_id into parent_org from public.recurring_posting_templates where id = new.template_id;
  elsif tg_table_name = 'books_close_items' then
    select org_id into parent_org from public.accounting_periods where id = new.period_id;
  elsif tg_table_name = 'books_cutover_approvals' then
    select org_id into parent_org from public.books_cutover_runs where id = new.cutover_run_id;
  end if;
  if parent_org is null or parent_org <> new.org_id then
    raise exception 'Child record organization must match its parent';
  end if;
  return new;
end;
$$;

create trigger accounting_reconciliation_items_validate_org before insert or update on public.accounting_reconciliation_items for each row execute function public.books_validate_child_org();
create trigger books_comparison_items_validate_org before insert or update on public.books_comparison_items for each row execute function public.books_validate_child_org();
create trigger opening_balance_lines_validate_org before insert or update on public.opening_balance_lines for each row execute function public.books_validate_child_org();
create trigger opening_balance_approvals_validate_org before insert on public.opening_balance_approvals for each row execute function public.books_validate_child_org();
create trigger bank_reconciliation_items_validate_org before insert or update on public.bank_reconciliation_items for each row execute function public.books_validate_child_org();
create trigger recurring_posting_lines_validate_org before insert or update on public.recurring_posting_lines for each row execute function public.books_validate_child_org();
create trigger books_close_items_validate_org before insert or update on public.books_close_items for each row execute function public.books_validate_child_org();
create trigger books_cutover_approvals_validate_org before insert on public.books_cutover_approvals for each row execute function public.books_validate_child_org();

-- Atomically post a journal entry. Only the service role may call this function;
-- application services still enforce the human actor's RBAC before invoking it.
create or replace function public.post_books_journal_entry(
  p_org_id uuid,
  p_entry jsonb,
  p_lines jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  entry_id uuid;
  line_row jsonb;
  resolved_period_id uuid;
begin
  if jsonb_typeof(p_entry) <> 'object' or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal entry requires an entry object and at least two lines';
  end if;

  select id into resolved_period_id
  from public.accounting_periods
  where org_id = p_org_id
    and (p_entry ->> 'entry_date')::date between period_start and period_end
  order by period_start desc
  limit 1;

  insert into public.journal_entries (
    org_id, fact_id, period_id, entry_date, entry_kind, status, memo,
    posting_key, projection_version, policy_version, source_type, source_id,
    reversal_of_entry_id, created_by
  ) values (
    p_org_id,
    nullif(p_entry ->> 'fact_id', '')::uuid,
    resolved_period_id,
    (p_entry ->> 'entry_date')::date,
    p_entry ->> 'entry_kind',
    'draft',
    p_entry ->> 'memo',
    p_entry ->> 'posting_key',
    coalesce((p_entry ->> 'projection_version')::integer, 1),
    (p_entry ->> 'policy_version')::integer,
    nullif(p_entry ->> 'source_type', ''),
    nullif(p_entry ->> 'source_id', '')::uuid,
    nullif(p_entry ->> 'reversal_of_entry_id', '')::uuid,
    nullif(p_entry ->> 'created_by', '')::uuid
  )
  returning id into entry_id;

  for line_row in select value from jsonb_array_elements(p_lines)
  loop
    insert into public.journal_lines (
      org_id, entry_id, line_no, account_id, project_id, company_id,
      description, debit_cents, credit_cents, dimensions
    ) values (
      p_org_id,
      entry_id,
      (line_row ->> 'line_no')::smallint,
      (line_row ->> 'account_id')::uuid,
      nullif(line_row ->> 'project_id', '')::uuid,
      nullif(line_row ->> 'company_id', '')::uuid,
      nullif(line_row ->> 'description', ''),
      coalesce((line_row ->> 'debit_cents')::bigint, 0),
      coalesce((line_row ->> 'credit_cents')::bigint, 0),
      coalesce(line_row -> 'dimensions', '{}'::jsonb)
    );
  end loop;

  update public.journal_entries
  set status = 'posted', posted_at = now(), posted_by = nullif(p_entry ->> 'created_by', '')::uuid
  where id = entry_id;

  return entry_id;
end;
$$;

revoke all on function public.post_books_journal_entry(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.post_books_journal_entry(uuid, jsonb, jsonb) to service_role;

create or replace function public.complete_books_cutover(
  p_org_id uuid,
  p_run_id uuid,
  p_actor_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  cutover public.books_cutover_runs%rowtype;
  approval_count integer;
  pending_sync_count integer;
  draft_journal_count integer;
begin
  select * into cutover
  from public.books_cutover_runs
  where id = p_run_id and org_id = p_org_id
  for update;

  if cutover.id is null or cutover.status <> 'ready' or cutover.digest is null or cutover.final_sync_marker is null then
    raise exception 'Cutover run is not ready';
  end if;

  select count(*) into approval_count
  from public.books_cutover_approvals
  where cutover_run_id = p_run_id
    and approved_digest = cutover.digest
    and approval_role in ('owner','accountant');

  if approval_count <> 2 then
    raise exception 'Cutover requires owner and accountant approval of the current digest';
  end if;

  select count(*) into pending_sync_count
  from public.accounting_sync_records
  where org_id = p_org_id and connection_id = cutover.connection_id
    and status in ('pending','processing','error');
  select count(*) into draft_journal_count
  from public.journal_entries
  where org_id = p_org_id and status = 'draft' and entry_date <= cutover.cutover_date;
  if pending_sync_count > 0 or draft_journal_count > 0 then
    raise exception 'Cutover queues or journals changed after approval; prepare and approve a new digest';
  end if;

  insert into public.books_settings (
    org_id, ledger_authority, arc_ledger_mode, external_sync_posture,
    external_provider, authoritative_at, authoritative_by, created_by, updated_by
  ) values (
    p_org_id, 'arc', 'official', cutover.target_posture,
    (select provider from public.accounting_connections where id = cutover.connection_id),
    now(), p_actor_id, p_actor_id, p_actor_id
  )
  on conflict (org_id) do update set
    ledger_authority = 'arc',
    arc_ledger_mode = 'official',
    external_sync_posture = excluded.external_sync_posture,
    external_provider = excluded.external_provider,
    authoritative_at = excluded.authoritative_at,
    authoritative_by = excluded.authoritative_by,
    updated_by = excluded.updated_by,
    updated_at = now();

  if cutover.connection_id is not null and cutover.target_posture = 'disconnected' then
    update public.accounting_connections
    set status = 'disconnected', disconnected_at = now(), updated_at = now()
    where id = cutover.connection_id and org_id = p_org_id;
  elsif cutover.connection_id is not null and cutover.target_posture = 'outbound_mirror' then
    update public.accounting_connections
    set settings = (coalesce(settings, '{}'::jsonb) - 'cutover_freeze_run_id') || jsonb_build_object('sync_direction', 'outbound_mirror', 'inbound_mutation', false),
        updated_at = now()
    where id = cutover.connection_id and org_id = p_org_id;
  end if;

  update public.books_cutover_runs
  set status = 'completed', completed_by = p_actor_id, completed_at = now(), updated_at = now()
  where id = p_run_id and org_id = p_org_id;
end;
$$;

revoke all on function public.complete_books_cutover(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_books_cutover(uuid, uuid, uuid) to service_role;

create or replace function public.rollback_books_cutover(
  p_org_id uuid,
  p_run_id uuid,
  p_actor_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  cutover public.books_cutover_runs%rowtype;
  authoritative_at timestamptz;
begin
  select * into cutover from public.books_cutover_runs
  where id = p_run_id and org_id = p_org_id for update;
  if cutover.id is null or cutover.status <> 'completed' then
    raise exception 'Only a completed cutover can be rolled back';
  end if;
  if cutover.rollback_deadline is null or now() > cutover.rollback_deadline then
    raise exception 'The approved rollback window has expired';
  end if;
  select bs.authoritative_at into authoritative_at from public.books_settings bs where bs.org_id = p_org_id;
  if exists (
    select 1 from public.accounting_periods p
    where p.org_id = p_org_id and p.status = 'closed'
      and p.closed_at >= authoritative_at
  ) then
    raise exception 'Rollback is unavailable after the first Arc-authoritative period close';
  end if;
  update public.books_settings
  set ledger_authority = 'external', arc_ledger_mode = 'parallel', external_sync_posture = 'normal',
      authoritative_at = null, authoritative_by = null, updated_by = p_actor_id, updated_at = now()
  where org_id = p_org_id;
  if cutover.connection_id is not null then
    update public.accounting_connections
    set status = 'active', disconnected_at = null,
        settings = (coalesce(settings, '{}'::jsonb) - 'cutover_freeze_run_id' - 'cutover_frozen_at' - 'inbound_mutation') || jsonb_build_object('sync_direction', 'bidirectional'),
        updated_at = now()
    where id = cutover.connection_id and org_id = p_org_id;
  end if;
  update public.books_cutover_runs
  set status = 'rolled_back', rolled_back_at = now(), error_message = p_reason, updated_at = now()
  where id = p_run_id and org_id = p_org_id;
end;
$$;

revoke all on function public.rollback_books_cutover(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rollback_books_cutover(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Updated-at triggers
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'books_settings','accounting_policies','coding_rules','gl_accounts','accounting_account_mappings',
    'accounting_periods','accounting_reconciliation_items','books_comparison_items',
    'opening_balance_batches','bank_feed_connections','bank_accounts',
    'bank_transactions','bank_transaction_matches','bank_reconciliations',
    'recurring_posting_templates','books_close_items','tax_identity_refs',
    'books_cutover_runs'
  ]
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.tg_set_updated_at()',
      table_name || '_set_updated_at',
      table_name
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

do $$
declare
  target record;
begin
  for target in
    select * from (values
      ('books_settings','books.read'),
      ('accounting_policies','books.read'),
      ('coding_rules','books.manage'),
      ('gl_accounts','books.read'),
      ('accounting_account_mappings','books.reconcile'),
      ('accounting_periods','books.read'),
      ('accounting_facts','books.read'),
      ('journal_entries','books.read'),
      ('journal_lines','books.read'),
      ('accounting_reconciliation_runs','books.reconcile'),
      ('accounting_reconciliation_items','books.reconcile'),
      ('poc_snapshots','books.read'),
      ('books_comparison_runs','books.reconcile'),
      ('books_comparison_items','books.reconcile'),
      ('opening_balance_batches','books.manage'),
      ('opening_balance_lines','books.manage'),
      ('opening_balance_approvals','books.manage'),
      ('bank_accounts','books.reconcile'),
      ('bank_transactions','books.reconcile'),
      ('bank_transaction_revisions','books.reconcile'),
      ('bank_transaction_matches','books.reconcile'),
      ('bank_reconciliations','books.reconcile'),
      ('bank_reconciliation_items','books.reconcile'),
      ('recurring_posting_templates','books.manage'),
      ('recurring_posting_lines','books.manage'),
      ('books_close_items','books.close'),
      ('financial_statement_snapshots','books.read'),
      ('tax_policy_versions','books.tax'),
      ('accountant_packages','books.export'),
      ('books_exports','books.export'),
      ('ledger_rebuild_runs','books.export'),
      ('books_cutover_runs','books.cutover'),
      ('books_cutover_approvals','books.cutover')
    ) as v(table_name, permission_key)
  loop
    execute format('alter table public.%I enable row level security', target.table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_org_permission(org_id, %L))',
      target.table_name || '_read',
      target.table_name,
      target.permission_key
    );
    execute format('grant select on public.%I to authenticated', target.table_name);
    execute format('grant all on public.%I to service_role', target.table_name);
  end loop;
end;
$$;

-- Provider payloads and vault references are service-only even for org members.
alter table public.bank_feed_connections enable row level security;
alter table public.bank_feed_events enable row level security;
alter table public.tax_identity_refs enable row level security;
grant all on public.bank_feed_connections to service_role;
grant all on public.bank_feed_events to service_role;
grant all on public.tax_identity_refs to service_role;

-- Function execution is not an application API unless explicitly granted above.
revoke all on function public.books_reject_mutation() from public, anon, authenticated;
revoke all on function public.books_validate_period_range() from public, anon, authenticated;
revoke all on function public.books_validate_journal_line_scope() from public, anon, authenticated;
revoke all on function public.books_guard_posted_journal() from public, anon, authenticated;
revoke all on function public.books_assert_journal_balanced() from public, anon, authenticated;
revoke all on function public.books_guard_closed_period() from public, anon, authenticated;
revoke all on function public.books_validate_child_org() from public, anon, authenticated;
revoke all on function public.books_validate_account_mapping_scope() from public, anon, authenticated;
revoke all on function public.rollback_books_cutover(uuid, uuid, uuid, text) from public, anon, authenticated;

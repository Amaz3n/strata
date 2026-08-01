-- Fintech payment foundation
--
-- This migration is intentionally provider-neutral. Stripe Connect Express is the
-- first adapter, not the data model. Money movement remains disabled until the
-- platform program review, legal review, and QA-only enablement gate are complete.
--
-- Security posture:
--   * Portal credentials, provider identifiers, bank metadata, provider events,
--     and platform pricing are service-role only.
--   * Authenticated org users may read the non-sensitive operational records only
--     when they have payment.release.
--   * All payment mutations go through permission-checking server services.
--   * Ledger/provider event rows are append-only; corrections are new reversals.

-- ---------------------------------------------------------------------------
-- Global vendor portal identity and explicit company claims
-- ---------------------------------------------------------------------------

create table public.vendor_portal_identities (
  id uuid primary key default gen_random_uuid(),
  email public.citext not null unique,
  full_name text,
  password_hash text not null,
  status text not null default 'active'
    check (status in ('pending_verification','active','locked','revoked')),
  email_verified_at timestamptz,
  password_attempts integer not null default 0 check (password_attempts >= 0),
  password_locked_until timestamptz,
  last_authenticated_at timestamptz,
  last_step_up_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vendor_entities (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null check (length(btrim(legal_name)) > 0),
  dba_name text,
  entity_type text,
  tax_id_last4 text check (tax_id_last4 is null or tax_id_last4 ~ '^[0-9]{4}$'),
  status text not null default 'active'
    check (status in ('pending','active','suspended','closed')),
  created_by_identity_id uuid references public.vendor_portal_identities(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vendor_entity_memberships (
  id uuid primary key default gen_random_uuid(),
  vendor_entity_id uuid not null references public.vendor_entities(id) on delete cascade,
  identity_id uuid not null references public.vendor_portal_identities(id) on delete cascade,
  role text not null default 'administrator'
    check (role in ('owner','administrator','member')),
  status text not null default 'active'
    check (status in ('invited','active','suspended','revoked')),
  invited_by_identity_id uuid references public.vendor_portal_identities(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_entity_id, identity_id)
);

create index vendor_entity_memberships_identity_status_idx
  on public.vendor_entity_memberships (identity_id, status);

-- Existing external_portal_accounts remain org-scoped compatibility profiles.
-- New claim/login services attach them to one global identity only after the user
-- proves control. Existing rows are deliberately NOT merged by email.
alter table public.external_portal_accounts
  add column if not exists vendor_identity_id uuid
    references public.vendor_portal_identities(id) on delete set null;

create unique index external_portal_accounts_identity_org_uidx
  on public.external_portal_accounts (vendor_identity_id, org_id)
  where vendor_identity_id is not null;

create table public.vendor_company_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  vendor_entity_id uuid not null references public.vendor_entities(id) on delete restrict,
  claimed_by_identity_id uuid not null references public.vendor_portal_identities(id) on delete restrict,
  external_portal_account_id uuid references public.external_portal_accounts(id) on delete set null,
  source_portal_token_id uuid references public.portal_access_tokens(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','verified','rejected','revoked')),
  verification_method text not null default 'portal_invitation'
    check (verification_method in ('portal_invitation','builder_review','platform_review')),
  verified_by uuid references public.app_users(id) on delete set null,
  verified_at timestamptz,
  rejected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, company_id)
);

create index vendor_company_claims_entity_idx
  on public.vendor_company_claims (vendor_entity_id, status);

-- ---------------------------------------------------------------------------
-- Recipient accounts and builder/vendor relationships
-- ---------------------------------------------------------------------------

create table public.payment_recipient_accounts (
  id uuid primary key default gen_random_uuid(),
  vendor_entity_id uuid not null references public.vendor_entities(id) on delete restrict,
  provider text not null,
  provider_account_id text not null,
  account_model text not null default 'express'
    check (account_model in ('express','custom','standard','other')),
  country text not null default 'US',
  default_currency text not null default 'usd',
  status text not null default 'onboarding'
    check (status in ('onboarding','pending_review','ready','restricted','disabled')),
  details_submitted boolean not null default false,
  payouts_enabled boolean not null default false,
  requirements_currently_due jsonb not null default '[]'::jsonb
    check (jsonb_typeof(requirements_currently_due) = 'array'),
  requirements_eventually_due jsonb not null default '[]'::jsonb
    check (jsonb_typeof(requirements_eventually_due) = 'array'),
  disabled_reason text,
  payout_bank_name text,
  payout_bank_last4 text check (payout_bank_last4 is null or payout_bank_last4 ~ '^[0-9]{4}$'),
  destination_version integer not null default 0 check (destination_version >= 0),
  destination_locked_until timestamptz,
  last_provider_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_account_id),
  unique (vendor_entity_id, provider)
);

create table public.vendor_payment_relationships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  vendor_company_claim_id uuid not null references public.vendor_company_claims(id) on delete restrict,
  vendor_entity_id uuid not null references public.vendor_entities(id) on delete restrict,
  recipient_account_id uuid references public.payment_recipient_accounts(id) on delete restrict,
  status text not null default 'invited'
    check (status in ('invited','claim_pending','onboarding','active','suspended','revoked')),
  invited_by uuid references public.app_users(id) on delete set null,
  accepted_by_identity_id uuid references public.vendor_portal_identities(id) on delete set null,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, company_id)
);

create index vendor_payment_relationships_recipient_idx
  on public.vendor_payment_relationships (recipient_account_id, status)
  where recipient_account_id is not null;
create index vendor_payment_relationships_org_entity_idx
  on public.vendor_payment_relationships (org_id, vendor_entity_id, status);

-- ---------------------------------------------------------------------------
-- Organization controls, funding sources, and sensitive change controls
-- ---------------------------------------------------------------------------

create table public.payment_rail_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.orgs(id) on delete cascade,
  enabled boolean not null default false,
  approval_mode text not null default 'dual'
    check (approval_mode in ('sole','dual')),
  requester_may_approve boolean not null default false
    check (requester_may_approve = false),
  require_dual_for_control_changes boolean not null default true
    check (require_dual_for_control_changes = true),
  control_change_cooling_hours integer not null default 72
    check (control_change_cooling_hours between 24 and 168),
  per_payment_limit_cents bigint check (per_payment_limit_cents is null or per_payment_limit_cents > 0),
  per_run_limit_cents bigint check (per_run_limit_cents is null or per_run_limit_cents > 0),
  daily_limit_cents bigint check (daily_limit_cents is null or daily_limit_cents > 0),
  waiver_jurisdiction text not null default 'FL',
  require_waiver_snapshot boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (per_run_limit_cents is null or per_payment_limit_cents is null or per_run_limit_cents >= per_payment_limit_cents)
);

create table public.org_payment_provider_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null,
  provider_customer_id text not null,
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider),
  unique (provider, provider_customer_id)
);

create table public.org_funding_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null,
  provider_customer_id text not null,
  provider_payment_method_id text not null,
  provider_mandate_id text,
  bank_name text,
  account_holder_type text check (account_holder_type is null or account_holder_type in ('individual','company')),
  account_type text check (account_type is null or account_type in ('checking','savings')),
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  fingerprint text,
  mandate_status text not null default 'pending'
    check (mandate_status in ('pending','accepted','revoked','invalid')),
  verification_status text not null default 'pending'
    check (verification_status in ('pending','verified','failed')),
  status text not null default 'pending_approval'
    check (status in ('pending_approval','cooling_off','active','disabled','revoked')),
  is_default boolean not null default false,
  usable_after timestamptz,
  created_by uuid not null references public.app_users(id) on delete restrict,
  activated_by uuid references public.app_users(id) on delete set null,
  activated_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_payment_method_id)
);

create unique index org_funding_sources_default_uidx
  on public.org_funding_sources (org_id)
  where is_default and status = 'active';
create index org_funding_sources_org_status_idx
  on public.org_funding_sources (org_id, status);

create table public.payment_control_change_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('recipient_destination','org_funding_source')),
  org_id uuid references public.orgs(id) on delete cascade,
  recipient_account_id uuid references public.payment_recipient_accounts(id) on delete cascade,
  funding_source_id uuid references public.org_funding_sources(id) on delete cascade,
  requested_by_user_id uuid references public.app_users(id) on delete restrict,
  requested_by_identity_id uuid references public.vendor_portal_identities(id) on delete restrict,
  provider_reference text,
  previous_masked_details jsonb not null default '{}'::jsonb check (jsonb_typeof(previous_masked_details) = 'object'),
  proposed_masked_details jsonb not null default '{}'::jsonb check (jsonb_typeof(proposed_masked_details) = 'object'),
  status text not null default 'pending_approval'
    check (status in ('pending_approval','cooling_off','approved','applied','rejected','expired','canceled')),
  required_approvals smallint not null default 2 check (required_approvals = 2),
  apply_after timestamptz not null default (now() + interval '72 hours'),
  applied_at timestamptz,
  rejected_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_control_change_target_check check (
    (kind = 'recipient_destination' and org_id is null and recipient_account_id is not null and funding_source_id is null)
    or
    (kind = 'org_funding_source' and org_id is not null and funding_source_id is not null and recipient_account_id is null)
  ),
  constraint payment_control_change_requester_check check (
    num_nonnulls(requested_by_user_id, requested_by_identity_id) = 1
  )
);

create table public.payment_control_change_approvals (
  id uuid primary key default gen_random_uuid(),
  change_request_id uuid not null references public.payment_control_change_requests(id) on delete restrict,
  actor_user_id uuid references public.app_users(id) on delete restrict,
  actor_identity_id uuid references public.vendor_portal_identities(id) on delete restrict,
  actor_role text not null check (actor_role in ('org_approver','vendor_administrator','platform_operator')),
  decision text not null check (decision in ('approved','rejected')),
  reason text,
  step_up_verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(actor_user_id, actor_identity_id) = 1),
  check (step_up_verified_at <= created_at),
  check (decision = 'approved' or length(btrim(coalesce(reason, ''))) >= 8)
);

create unique index payment_control_approvals_user_uidx
  on public.payment_control_change_approvals (change_request_id, actor_user_id)
  where actor_user_id is not null;
create unique index payment_control_approvals_identity_uidx
  on public.payment_control_change_approvals (change_request_id, actor_identity_id)
  where actor_identity_id is not null;
create index payment_control_changes_org_status_idx
  on public.payment_control_change_requests (org_id, status, apply_after);

-- ---------------------------------------------------------------------------
-- Payment runs, payees, approvals, and movement attempts
-- ---------------------------------------------------------------------------

create table public.payment_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  funding_source_id uuid not null references public.org_funding_sources(id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft','pending_approval','approved','processing','partially_paid','paid','partially_failed','failed','canceled')),
  currency text not null default 'usd',
  payment_count integer not null default 0 check (payment_count >= 0),
  vendor_amount_cents bigint not null default 0 check (vendor_amount_cents >= 0),
  processor_fee_cents bigint not null default 0 check (processor_fee_cents >= 0),
  platform_fee_cents bigint not null default 0 check (platform_fee_cents >= 0),
  total_debit_cents bigint not null default 0 check (total_debit_cents >= 0),
  approval_mode_snapshot text not null check (approval_mode_snapshot in ('sole','dual')),
  required_approvals smallint not null check (required_approvals in (1,2)),
  revision integer not null default 1 check (revision > 0),
  content_hash text check (content_hash is null or content_hash ~ '^[a-f0-9]{64}$'),
  control_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(control_snapshot) = 'object'),
  idempotency_key text not null,
  requested_by uuid not null references public.app_users(id) on delete restrict,
  requested_at timestamptz,
  approved_at timestamptz,
  processing_started_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  check (
    (approval_mode_snapshot = 'sole' and required_approvals = 1)
    or (approval_mode_snapshot = 'dual' and required_approvals = 2)
  ),
  check (total_debit_cents = vendor_amount_cents + processor_fee_cents + platform_fee_cents)
);

create index payment_runs_org_status_idx
  on public.payment_runs (org_id, status, created_at desc);
create index payment_runs_funding_source_idx
  on public.payment_runs (org_id, funding_source_id, created_at desc);

create table public.payment_run_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid not null references public.payment_runs(id) on delete restrict,
  project_id uuid references public.projects(id) on delete set null,
  bill_id uuid not null references public.vendor_bills(id) on delete restrict,
  relationship_id uuid not null references public.vendor_payment_relationships(id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft','pending_approval','approved','processing','partially_paid','paid','failed','returned','canceled')),
  bill_balance_snapshot_cents bigint not null check (bill_balance_snapshot_cents >= 0),
  gross_payment_cents bigint not null check (gross_payment_cents > 0),
  retainage_held_cents bigint not null default 0 check (retainage_held_cents >= 0),
  vendor_amount_cents bigint not null check (vendor_amount_cents > 0),
  processor_fee_cents bigint not null default 0 check (processor_fee_cents >= 0),
  platform_fee_cents bigint not null default 0 check (platform_fee_cents >= 0),
  total_debit_cents bigint not null check (total_debit_cents > 0),
  allocation_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(allocation_snapshot) = 'array'),
  hold_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(hold_snapshot) = 'object'),
  waiver_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(waiver_snapshot) = 'object'),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, bill_id),
  check (gross_payment_cents = vendor_amount_cents + retainage_held_cents),
  check (total_debit_cents = vendor_amount_cents + processor_fee_cents + platform_fee_cents)
);

create unique index payment_run_items_bill_inflight_uidx
  on public.payment_run_items (bill_id)
  where status in ('draft','pending_approval','approved','processing','partially_paid');
create index payment_run_items_org_run_idx
  on public.payment_run_items (org_id, run_id);
create index payment_run_items_org_project_idx
  on public.payment_run_items (org_id, project_id, created_at desc);

-- Multiple payees make joint checks/split settlements possible. ACH payees point at
-- a recipient account; an external-check payee can be named without one.
create table public.payment_run_item_payees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_item_id uuid not null references public.payment_run_items(id) on delete restrict,
  payee_kind text not null check (payee_kind in ('primary_vendor','joint_payee')),
  method text not null check (method in ('ach','external_check')),
  recipient_account_id uuid references public.payment_recipient_accounts(id) on delete restrict,
  payee_name text not null check (length(btrim(payee_name)) > 0),
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'pending'
    check (status in ('pending','processing','paid','failed','returned','canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (method = 'ach' and recipient_account_id is not null)
    or (method = 'external_check')
  )
);

create index payment_run_item_payees_item_idx
  on public.payment_run_item_payees (run_item_id, status);
create index payment_run_item_payees_recipient_idx
  on public.payment_run_item_payees (org_id, recipient_account_id, status)
  where recipient_account_id is not null;

create table public.payment_run_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid not null references public.payment_runs(id) on delete restrict,
  approver_id uuid not null references public.app_users(id) on delete restrict,
  decision text not null check (decision in ('approved','rejected')),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  reason text,
  step_up_verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (run_id, approver_id),
  check (step_up_verified_at <= created_at),
  check (decision = 'approved' or length(btrim(coalesce(reason, ''))) >= 8)
);

create index payment_run_approvals_org_run_idx
  on public.payment_run_approvals (org_id, run_id);
create index payment_run_approvals_org_approver_idx
  on public.payment_run_approvals (org_id, approver_id, created_at desc);

create table public.disbursements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  run_id uuid not null references public.payment_runs(id) on delete restrict,
  run_item_id uuid not null references public.payment_run_items(id) on delete restrict,
  run_item_payee_id uuid not null references public.payment_run_item_payees(id) on delete restrict,
  bill_id uuid not null references public.vendor_bills(id) on delete restrict,
  funding_source_id uuid not null references public.org_funding_sources(id) on delete restrict,
  recipient_account_id uuid references public.payment_recipient_accounts(id) on delete restrict,
  provider text not null,
  status text not null default 'created'
    check (status in ('created','submitted','debit_pending','funds_available','transfer_pending','payout_pending','paid','failed','returned','reversed','canceled')),
  amount_cents bigint not null check (amount_cents > 0),
  processor_fee_cents bigint not null default 0 check (processor_fee_cents >= 0),
  platform_fee_cents bigint not null default 0 check (platform_fee_cents >= 0),
  currency text not null default 'usd',
  provider_payment_id text,
  provider_charge_id text,
  provider_transfer_id text,
  provider_payout_id text,
  provider_balance_transaction_id text,
  transfer_group text,
  idempotency_key text not null,
  failure_code text,
  failure_reason text,
  submitted_at timestamptz,
  funds_available_at timestamptz,
  paid_at timestamptz,
  returned_at timestamptz,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  unique (provider, provider_payment_id)
);

create index disbursements_org_status_idx
  on public.disbursements (org_id, status, created_at desc);
create index disbursements_bill_idx
  on public.disbursements (org_id, bill_id, created_at desc);
create index disbursements_funding_source_idx
  on public.disbursements (org_id, funding_source_id, created_at desc);
create index disbursements_recipient_idx
  on public.disbursements (org_id, recipient_account_id, created_at desc)
  where recipient_account_id is not null;
create index disbursements_provider_transfer_idx
  on public.disbursements (provider, provider_transfer_id)
  where provider_transfer_id is not null;
create index disbursements_provider_payout_idx
  on public.disbursements (provider, provider_payout_id)
  where provider_payout_id is not null;

-- ---------------------------------------------------------------------------
-- Provider events, double-entry ledger, fees, risk, and reconciliation
-- ---------------------------------------------------------------------------

create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  provider_account_id text,
  org_id uuid references public.orgs(id) on delete set null,
  disbursement_id uuid references public.disbursements(id) on delete set null,
  event_type text not null,
  event_created_at timestamptz,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index payment_provider_events_received_idx
  on public.payment_provider_events (received_at);
create index payment_provider_events_org_received_idx
  on public.payment_provider_events (org_id, received_at desc)
  where org_id is not null;
create index payment_provider_events_disbursement_idx
  on public.payment_provider_events (disbursement_id, received_at desc)
  where disbursement_id is not null;

-- Processing history is also append-only. A retry inserts another attempt instead
-- of rewriting the received provider event.
create table public.payment_provider_event_attempts (
  id uuid primary key default gen_random_uuid(),
  provider_event_id uuid not null references public.payment_provider_events(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  outcome text not null check (outcome in ('processed','ignored','failed')),
  processing_error text,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (provider_event_id, attempt_number),
  check (completed_at >= started_at)
);

create table public.payment_ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  disbursement_id uuid references public.disbursements(id) on delete restrict,
  provider_event_id uuid references public.payment_provider_events(id) on delete restrict,
  source_type text not null check (source_type in ('payment_run','disbursement','provider_event','reconciliation','manual_adjustment')),
  source_id uuid,
  transaction_type text not null check (transaction_type in ('payment_submitted','funds_available','transfer_created','payout_paid','processor_fee','platform_fee','return','reversal','adjustment')),
  currency text not null default 'usd',
  status text not null default 'posted' check (status = 'posted'),
  idempotency_key text not null,
  reverses_transaction_id uuid references public.payment_ledger_transactions(id) on delete restrict,
  description text,
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);

create table public.payment_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  transaction_id uuid not null references public.payment_ledger_transactions(id) on delete restrict,
  account_code text not null check (account_code in (
    'org_cash','vendor_payable','ach_clearing','payout_clearing','processor_fee_expense',
    'platform_fee_expense','platform_fee_receivable','return_receivable','suspense'
  )),
  direction text not null check (direction in ('debit','credit')),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'usd',
  created_at timestamptz not null default now()
);

create index payment_ledger_transactions_org_effective_idx
  on public.payment_ledger_transactions (org_id, effective_at desc);
create index payment_ledger_entries_transaction_idx
  on public.payment_ledger_entries (transaction_id);
create index payment_ledger_entries_org_account_idx
  on public.payment_ledger_entries (org_id, account_code, created_at desc);

-- Pricing is platform-owned. The initial commercial model is subscription plus
-- provider costs passed through at cost; no speculative per-payment markup is set.
create table public.payment_fee_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete cascade,
  pricing_model text not null default 'subscription_plus_pass_through'
    check (pricing_model in ('subscription_plus_pass_through','custom')),
  pass_through_processor_fees boolean not null default true,
  processor_fee_bps integer check (processor_fee_bps is null or processor_fee_bps between 0 and 10000),
  processor_fee_fixed_cents bigint check (processor_fee_fixed_cents is null or processor_fee_fixed_cents >= 0),
  processor_fee_cap_cents bigint check (processor_fee_cap_cents is null or processor_fee_cap_cents >= 0),
  ap_platform_fee_flat_cents bigint not null default 0 check (ap_platform_fee_flat_cents >= 0),
  ap_platform_fee_bps integer not null default 0 check (ap_platform_fee_bps between 0 and 10000),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);

create unique index payment_fee_policies_org_active_uidx
  on public.payment_fee_policies (org_id)
  where effective_to is null and org_id is not null;
create unique index payment_fee_policies_platform_active_uidx
  on public.payment_fee_policies ((true))
  where effective_to is null and org_id is null;

create table public.platform_fee_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  disbursement_id uuid references public.disbursements(id) on delete restrict,
  provider_event_id uuid references public.payment_provider_events(id) on delete restrict,
  kind text not null check (kind in ('ar_ach','ar_card','ap_disbursement','card_interchange','early_pay_spread')),
  fee_cents bigint not null check (fee_cents >= 0),
  currency text not null default 'usd',
  provider_reference text,
  idempotency_key text not null,
  recognized_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);

create table public.payment_risk_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid references public.payment_runs(id) on delete cascade,
  disbursement_id uuid references public.disbursements(id) on delete cascade,
  review_type text not null check (review_type in ('automated','manual')),
  decision text not null check (decision in ('allow','review','block')),
  risk_score numeric check (risk_score is null or (risk_score >= 0 and risk_score <= 100)),
  signals jsonb not null default '[]'::jsonb check (jsonb_typeof(signals) = 'array'),
  reviewed_by uuid references public.app_users(id) on delete set null,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (num_nonnulls(run_id, disbursement_id) >= 1)
);

create index payment_risk_reviews_org_run_idx
  on public.payment_risk_reviews (org_id, run_id, created_at desc)
  where run_id is not null;

create table public.payment_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete cascade,
  provider text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending','running','balanced','exceptions','failed')),
  expected_cents bigint not null default 0,
  provider_cents bigint not null default 0,
  difference_cents bigint not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  check (period_end > period_start),
  check (difference_cents = provider_cents - expected_cents)
);

create table public.payment_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  reconciliation_run_id uuid not null references public.payment_reconciliation_runs(id) on delete cascade,
  org_id uuid references public.orgs(id) on delete cascade,
  disbursement_id uuid references public.disbursements(id) on delete set null,
  ledger_transaction_id uuid references public.payment_ledger_transactions(id) on delete set null,
  provider_reference text,
  expected_cents bigint not null default 0,
  provider_cents bigint not null default 0,
  difference_cents bigint not null default 0,
  status text not null check (status in ('matched','missing_internal','missing_provider','amount_mismatch','timing_difference','resolved')),
  resolution_note text,
  resolved_by uuid references public.app_users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check (difference_cents = provider_cents - expected_cents)
);

create index payment_reconciliation_runs_org_period_idx
  on public.payment_reconciliation_runs (org_id, period_end desc);
create index payment_reconciliation_items_run_status_idx
  on public.payment_reconciliation_items (reconciliation_run_id, status);
create index payment_reconciliation_items_org_status_idx
  on public.payment_reconciliation_items (org_id, status, created_at desc)
  where org_id is not null;

-- Existing reversals were originally AR-only. Preserve that path while allowing
-- exactly one invoice or vendor bill target.
alter table public.payment_reversals
  add column if not exists bill_id uuid references public.vendor_bills(id) on delete cascade;
alter table public.payment_reversals
  alter column invoice_id drop not null;
alter table public.payment_reversals
  drop constraint if exists payment_reversals_one_target_check;
alter table public.payment_reversals
  add constraint payment_reversals_one_target_check
  check (num_nonnulls(invoice_id, bill_id) = 1);
create index if not exists payment_reversals_bill_idx
  on public.payment_reversals (org_id, bill_id, occurred_at desc)
  where bill_id is not null;

-- ---------------------------------------------------------------------------
-- Database-enforced payment invariants
-- ---------------------------------------------------------------------------

create or replace function public.enforce_vendor_claim_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  company_org uuid;
  account_org uuid;
  account_identity uuid;
begin
  select org_id into company_org from public.companies where id = new.company_id;
  if company_org is distinct from new.org_id then
    raise exception 'Vendor claim company must belong to the claim organization';
  end if;

  if new.external_portal_account_id is not null then
    select org_id, vendor_identity_id into account_org, account_identity
    from public.external_portal_accounts where id = new.external_portal_account_id;
    if account_org is distinct from new.org_id then
      raise exception 'Vendor claim portal account must belong to the claim organization';
    end if;
    if account_identity is distinct from new.claimed_by_identity_id then
      raise exception 'Vendor claim portal account must be linked to the claiming identity';
    end if;
  end if;
  return new;
end;
$$;

create trigger vendor_company_claims_integrity
  before insert or update on public.vendor_company_claims
  for each row execute function public.enforce_vendor_claim_integrity();

create or replace function public.enforce_vendor_payment_relationship_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  claim_org uuid;
  claim_company uuid;
  claim_entity uuid;
  recipient_entity uuid;
begin
  select org_id, company_id, vendor_entity_id
    into claim_org, claim_company, claim_entity
  from public.vendor_company_claims where id = new.vendor_company_claim_id;

  if claim_org is distinct from new.org_id
     or claim_company is distinct from new.company_id
     or claim_entity is distinct from new.vendor_entity_id then
    raise exception 'Payment relationship must match its verified vendor claim';
  end if;

  if new.recipient_account_id is not null then
    select vendor_entity_id into recipient_entity
    from public.payment_recipient_accounts where id = new.recipient_account_id;
    if recipient_entity is distinct from new.vendor_entity_id then
      raise exception 'Recipient account must belong to the relationship vendor entity';
    end if;
  end if;
  return new;
end;
$$;

create trigger vendor_payment_relationships_integrity
  before insert or update on public.vendor_payment_relationships
  for each row execute function public.enforce_vendor_payment_relationship_integrity();

create or replace function public.enforce_payment_run_item_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  run_org uuid;
  bill_org uuid;
  bill_project uuid;
  bill_company uuid;
  relationship_org uuid;
  relationship_company uuid;
begin
  select org_id into run_org from public.payment_runs where id = new.run_id;
  select org_id, project_id, company_id into bill_org, bill_project, bill_company
    from public.vendor_bills where id = new.bill_id;
  select org_id, company_id into relationship_org, relationship_company
    from public.vendor_payment_relationships where id = new.relationship_id;

  if run_org is distinct from new.org_id
     or bill_org is distinct from new.org_id
     or relationship_org is distinct from new.org_id then
    raise exception 'Payment run item references must belong to one organization';
  end if;
  if new.project_id is distinct from bill_project then
    raise exception 'Payment run item project must match the vendor bill project';
  end if;
  if bill_company is null or bill_company is distinct from relationship_company then
    raise exception 'Payment run item bill must identify the relationship vendor';
  end if;
  return new;
end;
$$;

create trigger payment_run_items_integrity
  before insert or update on public.payment_run_items
  for each row execute function public.enforce_payment_run_item_integrity();

create or replace function public.enforce_payment_payee_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  item_org uuid;
begin
  select org_id into item_org from public.payment_run_items where id = new.run_item_id;
  if item_org is distinct from new.org_id then
    raise exception 'Payment payee must belong to the run item organization';
  end if;
  return new;
end;
$$;

create trigger payment_run_item_payees_integrity
  before insert or update on public.payment_run_item_payees
  for each row execute function public.enforce_payment_payee_integrity();

create or replace function public.enforce_disbursement_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  run_org uuid;
  item_org uuid;
  item_run uuid;
  item_bill uuid;
  item_project uuid;
  payee_org uuid;
  payee_item uuid;
  payee_recipient uuid;
  funding_org uuid;
begin
  select org_id into run_org from public.payment_runs where id = new.run_id;
  select org_id, run_id, bill_id, project_id into item_org, item_run, item_bill, item_project
    from public.payment_run_items where id = new.run_item_id;
  select org_id, run_item_id, recipient_account_id into payee_org, payee_item, payee_recipient
    from public.payment_run_item_payees where id = new.run_item_payee_id;
  select org_id into funding_org from public.org_funding_sources where id = new.funding_source_id;

  if run_org is distinct from new.org_id
     or item_org is distinct from new.org_id
     or payee_org is distinct from new.org_id
     or funding_org is distinct from new.org_id then
    raise exception 'Disbursement references must belong to one organization';
  end if;
  if item_run is distinct from new.run_id
     or payee_item is distinct from new.run_item_id
     or item_bill is distinct from new.bill_id
     or item_project is distinct from new.project_id
     or payee_recipient is distinct from new.recipient_account_id then
    raise exception 'Disbursement references must describe the same run item and payee';
  end if;
  return new;
end;
$$;

create trigger disbursements_integrity
  before insert or update on public.disbursements
  for each row execute function public.enforce_disbursement_integrity();

create or replace function public.enforce_payment_ledger_entry_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  transaction_org uuid;
  transaction_currency text;
begin
  select org_id, currency into transaction_org, transaction_currency
  from public.payment_ledger_transactions where id = new.transaction_id;
  if transaction_org is distinct from new.org_id
     or transaction_currency is distinct from new.currency then
    raise exception 'Ledger entry organization and currency must match its transaction';
  end if;
  return new;
end;
$$;

create trigger payment_ledger_entries_integrity
  before insert or update on public.payment_ledger_entries
  for each row execute function public.enforce_payment_ledger_entry_integrity();

create or replace function public.create_payment_run_atomic(
  p_org_id uuid,
  p_requested_by uuid,
  p_funding_source_id uuid,
  p_currency text,
  p_approval_mode text,
  p_required_approvals smallint,
  p_vendor_amount_cents bigint,
  p_processor_fee_cents bigint,
  p_platform_fee_cents bigint,
  p_total_debit_cents bigint,
  p_control_snapshot jsonb,
  p_idempotency_key text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
  v_item jsonb;
  v_payee jsonb;
  v_run_item_id uuid;
  v_item_count integer;
  v_item_vendor_total bigint;
  v_item_processor_total bigint;
  v_item_platform_total bigint;
  v_item_debit_total bigint;
  v_payee_total bigint;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Payment run items must be a non-empty array';
  end if;
  if p_approval_mode not in ('sole','dual')
     or (p_approval_mode = 'sole' and p_required_approvals <> 1)
     or (p_approval_mode = 'dual' and p_required_approvals <> 2) then
    raise exception 'Payment run approval policy is invalid';
  end if;

  select count(*)::integer,
    coalesce(sum((value->>'vendor_amount_cents')::bigint), 0),
    coalesce(sum((value->>'processor_fee_cents')::bigint), 0),
    coalesce(sum((value->>'platform_fee_cents')::bigint), 0),
    coalesce(sum((value->>'total_debit_cents')::bigint), 0)
  into v_item_count, v_item_vendor_total, v_item_processor_total,
    v_item_platform_total, v_item_debit_total
  from jsonb_array_elements(p_items);
  if v_item_count > 200
     or v_item_vendor_total <> p_vendor_amount_cents
     or v_item_processor_total <> p_processor_fee_cents
     or v_item_platform_total <> p_platform_fee_cents
     or v_item_debit_total <> p_total_debit_cents
     or p_total_debit_cents <> p_vendor_amount_cents + p_processor_fee_cents + p_platform_fee_cents then
    raise exception 'Payment run item totals do not match the run totals';
  end if;

  insert into public.payment_runs (
    org_id, funding_source_id, status, currency, payment_count,
    vendor_amount_cents, processor_fee_cents, platform_fee_cents,
    total_debit_cents, approval_mode_snapshot, required_approvals,
    control_snapshot, idempotency_key, requested_by
  ) values (
    p_org_id, p_funding_source_id, 'draft', lower(p_currency), v_item_count,
    p_vendor_amount_cents, p_processor_fee_cents, p_platform_fee_cents,
    p_total_debit_cents, p_approval_mode, p_required_approvals,
    p_control_snapshot, p_idempotency_key, p_requested_by
  ) on conflict (org_id, idempotency_key) do nothing
  returning * into v_run;

  if v_run.id is null then
    select * into v_run from public.payment_runs
    where org_id = p_org_id and idempotency_key = p_idempotency_key;
    return jsonb_build_object(
      'id', v_run.id,
      'status', v_run.status,
      'total_debit_cents', v_run.total_debit_cents,
      'required_approvals', v_run.required_approvals,
      'duplicate', true
    );
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item->'payees') <> 'array' or jsonb_array_length(v_item->'payees') = 0 then
      raise exception 'Each payment run item requires at least one payee';
    end if;
    select coalesce(sum((value->>'amount_cents')::bigint), 0)
      into v_payee_total from jsonb_array_elements(v_item->'payees');
    if v_payee_total <> (v_item->>'vendor_amount_cents')::bigint then
      raise exception 'Payment run payee amounts do not match the vendor amount';
    end if;

    insert into public.payment_run_items (
      org_id, run_id, project_id, bill_id, relationship_id, status,
      bill_balance_snapshot_cents, gross_payment_cents, retainage_held_cents,
      vendor_amount_cents, processor_fee_cents, platform_fee_cents,
      total_debit_cents, allocation_snapshot, hold_snapshot, waiver_snapshot
    ) values (
      p_org_id, v_run.id, nullif(v_item->>'project_id', '')::uuid,
      (v_item->>'bill_id')::uuid, (v_item->>'relationship_id')::uuid, 'draft',
      (v_item->>'bill_balance_snapshot_cents')::bigint,
      (v_item->>'gross_payment_cents')::bigint,
      (v_item->>'retainage_held_cents')::bigint,
      (v_item->>'vendor_amount_cents')::bigint,
      (v_item->>'processor_fee_cents')::bigint,
      (v_item->>'platform_fee_cents')::bigint,
      (v_item->>'total_debit_cents')::bigint,
      coalesce(v_item->'allocation_snapshot', '[]'::jsonb),
      coalesce(v_item->'hold_snapshot', '{}'::jsonb),
      coalesce(v_item->'waiver_snapshot', '{}'::jsonb)
    ) returning id into v_run_item_id;

    for v_payee in select value from jsonb_array_elements(v_item->'payees')
    loop
      if v_payee->>'method' <> 'ach' then
        raise exception 'Electronic payment runs support ACH payees only';
      end if;
      insert into public.payment_run_item_payees (
        org_id, run_item_id, payee_kind, method, recipient_account_id,
        payee_name, amount_cents
      ) values (
        p_org_id, v_run_item_id, v_payee->>'payee_kind', v_payee->>'method',
        nullif(v_payee->>'recipient_account_id', '')::uuid,
        v_payee->>'payee_name', (v_payee->>'amount_cents')::bigint
      );
    end loop;
  end loop;

  return jsonb_build_object(
    'id', v_run.id,
    'status', v_run.status,
    'total_debit_cents', v_run.total_debit_cents,
    'required_approvals', v_run.required_approvals,
    'duplicate', false
  );
end;
$$;

create or replace function public.submit_payment_run_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_requester_id uuid,
  p_content_hash text,
  p_requested_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
begin
  select * into v_run from public.payment_runs
  where id = p_run_id and org_id = p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  if v_run.requested_by <> p_requester_id then raise exception 'Only the payment-run preparer can submit it'; end if;
  if v_run.status <> 'draft' then raise exception 'Only a draft payment run can be submitted'; end if;
  if p_content_hash !~ '^[a-f0-9]{64}$' then raise exception 'Payment run content hash is invalid'; end if;

  update public.payment_runs set
    status = 'pending_approval', content_hash = p_content_hash,
    requested_at = p_requested_at
  where id = p_run_id and org_id = p_org_id;
  update public.payment_run_items set status = 'pending_approval'
  where run_id = p_run_id and org_id = p_org_id and status = 'draft';
  return jsonb_build_object('id', p_run_id, 'status', 'pending_approval', 'content_hash', p_content_hash);
end;
$$;

create or replace function public.cancel_payment_run_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_requester_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
begin
  select * into v_run from public.payment_runs
  where id = p_run_id and org_id = p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  if v_run.requested_by <> p_requester_id then raise exception 'Only the payment-run preparer can cancel it'; end if;
  if v_run.status not in ('draft','pending_approval','approved') then
    raise exception 'Payment run can no longer be canceled';
  end if;
  if exists (
    select 1 from public.disbursements
    where org_id = p_org_id and run_id = p_run_id
  ) then raise exception 'Payment run already has movement attempts'; end if;

  update public.payment_runs set status = 'canceled', canceled_at = now()
  where id = p_run_id and org_id = p_org_id;
  update public.payment_run_items set status = 'canceled'
  where run_id = p_run_id and org_id = p_org_id
    and status in ('draft','pending_approval','approved');
  return jsonb_build_object('id', p_run_id, 'status', 'canceled');
end;
$$;

create or replace function public.decide_payment_control_change_atomic(
  p_org_id uuid,
  p_change_request_id uuid,
  p_actor_user_id uuid,
  p_decision text,
  p_reason text,
  p_step_up_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change public.payment_control_change_requests%rowtype;
  v_approval_id uuid;
  v_approval_count integer;
  v_next_status text;
begin
  if p_decision not in ('approved','rejected') then raise exception 'Unsupported control-change decision'; end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_reason, ''))) < 8 then
    raise exception 'A rejection reason of at least 8 characters is required';
  end if;
  select * into v_change from public.payment_control_change_requests
  where id = p_change_request_id and org_id = p_org_id for update;
  if v_change.id is null then raise exception 'Payment control change not found'; end if;
  if v_change.status <> 'pending_approval' then raise exception 'Payment control change is not awaiting approval'; end if;
  if v_change.requested_by_user_id = p_actor_user_id then raise exception 'Requester cannot approve their own payment control change'; end if;

  insert into public.payment_control_change_approvals (
    change_request_id, actor_user_id, actor_role, decision, reason, step_up_verified_at
  ) values (
    v_change.id, p_actor_user_id, 'org_approver', p_decision, p_reason, p_step_up_verified_at
  ) returning id into v_approval_id;

  if p_decision = 'rejected' then
    update public.payment_control_change_requests
      set status = 'rejected', rejected_at = now()
      where id = v_change.id and org_id = p_org_id;
    update public.org_funding_sources
      set status = 'disabled', disabled_at = now()
      where id = v_change.funding_source_id and org_id = p_org_id;
    v_next_status := 'rejected';
    v_approval_count := 0;
  else
    select count(distinct actor_user_id)::integer into v_approval_count
    from public.payment_control_change_approvals
    where change_request_id = v_change.id and decision = 'approved';
    if v_approval_count >= v_change.required_approvals then
      update public.payment_control_change_requests set status = 'cooling_off'
      where id = v_change.id and org_id = p_org_id;
      update public.org_funding_sources set status = 'cooling_off'
      where id = v_change.funding_source_id and org_id = p_org_id;
      v_next_status := 'cooling_off';
    else
      v_next_status := 'pending_approval';
    end if;
  end if;
  return jsonb_build_object(
    'approval_id', v_approval_id,
    'status', v_next_status,
    'approval_count', v_approval_count,
    'required_approvals', v_change.required_approvals,
    'apply_after', v_change.apply_after,
    'funding_source_id', v_change.funding_source_id
  );
end;
$$;

create or replace function public.create_funding_source_change_atomic(
  p_org_id uuid,
  p_requested_by uuid,
  p_provider text,
  p_provider_customer_id text,
  p_provider_payment_method_id text,
  p_provider_mandate_id text,
  p_bank_name text,
  p_account_holder_type text,
  p_account_type text,
  p_last4 text,
  p_fingerprint text,
  p_mandate_status text,
  p_verification_status text,
  p_provider_reference text,
  p_apply_after timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_funding public.org_funding_sources%rowtype;
  v_change public.payment_control_change_requests%rowtype;
begin
  insert into public.org_funding_sources (
    org_id, provider, provider_customer_id, provider_payment_method_id,
    provider_mandate_id, bank_name, account_holder_type, account_type,
    last4, fingerprint, mandate_status, verification_status, status,
    usable_after, created_by
  ) values (
    p_org_id, p_provider, p_provider_customer_id, p_provider_payment_method_id,
    p_provider_mandate_id, p_bank_name, p_account_holder_type, p_account_type,
    p_last4, p_fingerprint, p_mandate_status, p_verification_status,
    'pending_approval', p_apply_after, p_requested_by
  ) on conflict (provider, provider_payment_method_id) do nothing
  returning * into v_funding;

  if v_funding.id is null then
    select * into v_funding from public.org_funding_sources
    where provider = p_provider and provider_payment_method_id = p_provider_payment_method_id;
    if v_funding.id is null or v_funding.org_id <> p_org_id then
      raise exception 'Funding source belongs to a different organization';
    end if;
    select * into v_change from public.payment_control_change_requests
    where org_id = p_org_id and funding_source_id = v_funding.id
      and kind = 'org_funding_source'
    order by created_at desc limit 1;
    if v_change.id is null then raise exception 'Funding source exists without its required control review'; end if;
    return jsonb_build_object(
      'funding_source_id', v_funding.id,
      'change_request_id', v_change.id,
      'apply_after', v_change.apply_after,
      'duplicate', true
    );
  end if;

  insert into public.payment_control_change_requests (
    kind, org_id, funding_source_id, requested_by_user_id,
    provider_reference, proposed_masked_details, required_approvals, apply_after
  ) values (
    'org_funding_source', p_org_id, v_funding.id, p_requested_by,
    p_provider_reference,
    jsonb_build_object('bank_name', p_bank_name, 'last4', p_last4),
    2, p_apply_after
  ) returning * into v_change;
  return jsonb_build_object(
    'funding_source_id', v_funding.id,
    'change_request_id', v_change.id,
    'apply_after', v_change.apply_after,
    'duplicate', false
  );
end;
$$;

create or replace function public.activate_matured_funding_change_atomic(
  p_org_id uuid,
  p_change_request_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change public.payment_control_change_requests%rowtype;
  v_approval_count integer;
begin
  select * into v_change from public.payment_control_change_requests
  where id = p_change_request_id and org_id = p_org_id for update;
  if v_change.id is null then raise exception 'Payment control change not found'; end if;
  if v_change.kind <> 'org_funding_source' or v_change.status <> 'cooling_off' then
    raise exception 'Funding change is not cooling off';
  end if;
  if v_change.apply_after > p_now then raise exception 'Funding change cooling period has not ended'; end if;
  select count(distinct actor_user_id)::integer into v_approval_count
  from public.payment_control_change_approvals
  where change_request_id = v_change.id and decision = 'approved';
  if v_approval_count < v_change.required_approvals then raise exception 'Funding change lacks approval quorum'; end if;

  update public.org_funding_sources set is_default = false
  where org_id = p_org_id and is_default = true;
  update public.org_funding_sources set
    status = 'active', is_default = true, activated_at = p_now,
    activated_by = null
  where id = v_change.funding_source_id and org_id = p_org_id;
  update public.payment_control_change_requests set status = 'applied', applied_at = p_now
  where id = v_change.id and org_id = p_org_id;
  return jsonb_build_object(
    'id', v_change.id,
    'status', 'applied',
    'funding_source_id', v_change.funding_source_id
  );
end;
$$;

create or replace function public.decide_payment_run_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_approver_id uuid,
  p_decision text,
  p_reason text,
  p_content_hash text,
  p_step_up_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
  v_approval public.payment_run_approvals%rowtype;
  v_approval_count integer;
  v_next_status text;
begin
  if p_decision not in ('approved','rejected') then
    raise exception 'Unsupported payment run decision';
  end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_reason, ''))) < 8 then
    raise exception 'A rejection reason of at least 8 characters is required';
  end if;

  select * into v_run from public.payment_runs
  where id = p_run_id and org_id = p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  if v_run.status <> 'pending_approval' then raise exception 'Payment run is not awaiting approval'; end if;
  if v_run.requested_by = p_approver_id then raise exception 'Payment run requester cannot approve their own run'; end if;
  if v_run.content_hash is null or v_run.content_hash <> p_content_hash then
    raise exception 'Payment run changed after it was submitted for approval';
  end if;

  insert into public.payment_run_approvals (
    org_id, run_id, approver_id, decision, content_hash, reason, step_up_verified_at
  ) values (
    p_org_id, p_run_id, p_approver_id, p_decision, p_content_hash, p_reason, p_step_up_verified_at
  ) returning * into v_approval;

  if p_decision = 'rejected' then
    update public.payment_runs
      set status = 'canceled', canceled_at = now()
      where id = p_run_id and org_id = p_org_id;
    update public.payment_run_items
      set status = 'canceled'
      where run_id = p_run_id and org_id = p_org_id;
    v_next_status := 'canceled';
  else
    select count(distinct approver_id)::integer into v_approval_count
    from public.payment_run_approvals
    where run_id = p_run_id and org_id = p_org_id and decision = 'approved';
    if v_approval_count >= v_run.required_approvals then
      update public.payment_runs set status = 'approved', approved_at = now()
        where id = p_run_id and org_id = p_org_id;
      update public.payment_run_items set status = 'approved'
        where run_id = p_run_id and org_id = p_org_id;
      v_next_status := 'approved';
    else
      v_next_status := 'pending_approval';
    end if;
  end if;

  return jsonb_build_object(
    'approval_id', v_approval.id,
    'status', v_next_status,
    'approval_count', coalesce(v_approval_count, 0),
    'required_approvals', v_run.required_approvals
  );
end;
$$;

create or replace function public.record_ap_payment_atomic(
  p_org_id uuid,
  p_disbursement_id uuid,
  p_provider_payment_id text,
  p_provider_charge_id text,
  p_provider_transfer_id text,
  p_provider_payout_id text,
  p_provider_balance_transaction_id text,
  p_paid_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_disbursement public.disbursements%rowtype;
  v_bill public.vendor_bills%rowtype;
  v_payment public.payments%rowtype;
  v_existing_payment public.payments%rowtype;
  v_next_paid bigint;
  v_payable_due bigint;
  v_bill_status text;
  v_item_status text;
  v_run_status text;
begin
  select * into v_disbursement from public.disbursements
  where id = p_disbursement_id and org_id = p_org_id for update;
  if v_disbursement.id is null then raise exception 'Disbursement not found'; end if;
  if v_disbursement.status not in ('payout_pending','paid') then
    raise exception 'Disbursement has not reached vendor payout';
  end if;

  select * into v_existing_payment from public.payments
  where org_id = p_org_id and provider = v_disbursement.provider
    and provider_payment_id = p_provider_payment_id limit 1;
  if v_existing_payment.id is not null then
    return jsonb_build_object('payment_id', v_existing_payment.id, 'duplicate', true);
  end if;

  select * into v_bill from public.vendor_bills
  where id = v_disbursement.bill_id and org_id = p_org_id for update;
  if v_bill.id is null then raise exception 'Vendor bill not found'; end if;
  if v_bill.status not in ('approved','partial','paid') then
    raise exception 'Vendor bill is not approved for payment';
  end if;

  v_payable_due := greatest(coalesce(v_bill.total_cents, 0) - greatest(coalesce(v_bill.retainage_cents, 0), 0), 0);
  v_next_paid := coalesce(v_bill.paid_cents, 0) + v_disbursement.amount_cents;
  if v_next_paid > v_payable_due then raise exception 'Electronic payment exceeds vendor bill balance'; end if;
  v_bill_status := case when v_next_paid >= v_payable_due then 'paid' else 'partial' end;

  insert into public.payments (
    org_id, project_id, bill_id, amount_cents, currency, method, reference,
    received_at, status, provider, provider_payment_id, provider_charge_id,
    provider_transfer_id, provider_balance_transaction_id, idempotency_key,
    gross_cents, processor_fee_cents, platform_fee_cents, fee_cents, net_cents,
    metadata
  ) values (
    p_org_id, v_disbursement.project_id, v_disbursement.bill_id,
    v_disbursement.amount_cents, v_disbursement.currency, 'ach', p_provider_payout_id,
    coalesce(p_paid_at, now()), 'succeeded', v_disbursement.provider, p_provider_payment_id,
    p_provider_charge_id, p_provider_transfer_id, p_provider_balance_transaction_id,
    'disbursement:' || v_disbursement.id::text,
    v_disbursement.amount_cents + v_disbursement.processor_fee_cents + v_disbursement.platform_fee_cents,
    v_disbursement.processor_fee_cents, v_disbursement.platform_fee_cents,
    v_disbursement.processor_fee_cents + v_disbursement.platform_fee_cents,
    v_disbursement.amount_cents,
    jsonb_build_object('disbursement_id', v_disbursement.id, 'provider_payout_id', p_provider_payout_id)
  ) returning * into v_payment;

  update public.vendor_bills set
    paid_cents = v_next_paid,
    status = v_bill_status,
    paid_at = case when v_bill_status = 'paid' then coalesce(v_bill.paid_at, p_paid_at, now()) else v_bill.paid_at end,
    payment_method = 'ach',
    payment_reference = coalesce(p_provider_payout_id, p_provider_payment_id)
  where id = v_bill.id and org_id = p_org_id;

  update public.disbursements set
    status = 'paid', provider_payment_id = p_provider_payment_id,
    provider_charge_id = p_provider_charge_id,
    provider_transfer_id = p_provider_transfer_id,
    provider_payout_id = p_provider_payout_id,
    provider_balance_transaction_id = p_provider_balance_transaction_id,
    paid_at = coalesce(p_paid_at, now())
  where id = v_disbursement.id and org_id = p_org_id;

  update public.payment_run_item_payees set status = 'paid'
  where id = v_disbursement.run_item_payee_id and org_id = p_org_id;
  select case
    when bool_and(status = 'paid') then 'paid'
    when bool_or(status = 'paid') then 'partially_paid'
    else 'processing'
  end into v_item_status
  from public.payment_run_item_payees
  where run_item_id = v_disbursement.run_item_id and org_id = p_org_id;
  update public.payment_run_items set status = v_item_status
  where id = v_disbursement.run_item_id and org_id = p_org_id;

  select case
    when bool_and(status = 'paid') then 'paid'
    when bool_or(status in ('failed','returned')) and bool_or(status in ('paid','partially_paid')) then 'partially_failed'
    when bool_and(status in ('failed','returned')) then 'failed'
    when bool_or(status in ('paid','partially_paid')) then 'partially_paid'
    else 'processing'
  end into v_run_status
  from public.payment_run_items where run_id = v_disbursement.run_id and org_id = p_org_id;
  update public.payment_runs set status = v_run_status,
    completed_at = case when v_run_status in ('paid','partially_failed','failed') then now() else completed_at end
  where id = v_disbursement.run_id and org_id = p_org_id;

  return jsonb_build_object(
    'payment_id', v_payment.id,
    'bill_id', v_bill.id,
    'bill_status', v_bill_status,
    'run_status', v_run_status,
    'duplicate', false
  );
end;
$$;

create or replace function public.record_ap_payment_reversal_atomic(
  p_org_id uuid,
  p_disbursement_id uuid,
  p_amount_cents bigint,
  p_reversal_type text,
  p_provider_reversal_id text,
  p_reason text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_disbursement public.disbursements%rowtype;
  v_payment public.payments%rowtype;
  v_reversal public.payment_reversals%rowtype;
  v_existing public.payment_reversals%rowtype;
  v_reversed bigint;
  v_bill public.vendor_bills%rowtype;
  v_next_paid bigint;
  v_bill_status text;
begin
  if p_amount_cents <= 0 then raise exception 'Reversal amount must be positive'; end if;
  if p_reversal_type not in ('ach_return','correction') then raise exception 'Unsupported AP reversal type'; end if;
  if p_provider_reversal_id is not null then
    select * into v_existing from public.payment_reversals
    where org_id = p_org_id and provider_reversal_id = p_provider_reversal_id limit 1;
    if v_existing.id is not null then return to_jsonb(v_existing) || jsonb_build_object('duplicate', true); end if;
  end if;

  select * into v_disbursement from public.disbursements
  where id = p_disbursement_id and org_id = p_org_id for update;
  if v_disbursement.id is null then raise exception 'Disbursement not found'; end if;
  select * into v_payment from public.payments
  where org_id = p_org_id and bill_id = v_disbursement.bill_id
    and metadata->>'disbursement_id' = v_disbursement.id::text for update;
  if v_payment.id is null then raise exception 'AP payment not found'; end if;
  select coalesce(sum(amount_cents), 0) into v_reversed from public.payment_reversals
  where org_id = p_org_id and payment_id = v_payment.id and status in ('pending','succeeded');
  if v_reversed + p_amount_cents > v_payment.amount_cents then raise exception 'Reversal exceeds original AP payment'; end if;

  insert into public.payment_reversals (
    org_id, project_id, bill_id, payment_id, amount_cents, reversal_type,
    status, provider_reversal_id, reason, metadata
  ) values (
    p_org_id, v_payment.project_id, v_payment.bill_id, v_payment.id, p_amount_cents,
    p_reversal_type, 'succeeded', p_provider_reversal_id, p_reason, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_reversal;

  if v_reversed + p_amount_cents = v_payment.amount_cents then
    update public.payments set status = 'refunded' where id = v_payment.id and org_id = p_org_id;
  end if;
  select * into v_bill from public.vendor_bills
  where id = v_payment.bill_id and org_id = p_org_id for update;
  v_next_paid := greatest(coalesce(v_bill.paid_cents, 0) - p_amount_cents, 0);
  v_bill_status := case when v_next_paid > 0 then 'partial' else 'approved' end;
  update public.vendor_bills set paid_cents = v_next_paid, status = v_bill_status,
    paid_at = case when v_bill_status = 'paid' then paid_at else null end
  where id = v_bill.id and org_id = p_org_id;
  update public.disbursements set status = 'returned', returned_at = now()
  where id = v_disbursement.id and org_id = p_org_id;
  update public.payment_run_item_payees set status = 'returned'
  where id = v_disbursement.run_item_payee_id and org_id = p_org_id;
  update public.payment_run_items set status = 'returned'
  where id = v_disbursement.run_item_id and org_id = p_org_id;
  update public.payment_runs set status = 'partially_failed'
  where id = v_disbursement.run_id and org_id = p_org_id;

  return to_jsonb(v_reversal) || jsonb_build_object('bill_status', v_bill_status, 'duplicate', false);
end;
$$;

create or replace function public.post_payment_ledger_transaction_atomic(
  p_org_id uuid,
  p_disbursement_id uuid,
  p_provider_event_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_transaction_type text,
  p_currency text,
  p_idempotency_key text,
  p_reverses_transaction_id uuid,
  p_description text,
  p_effective_at timestamptz,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction public.payment_ledger_transactions%rowtype;
  v_debits bigint;
  v_credits bigint;
  v_entry_count integer;
begin
  if jsonb_typeof(p_entries) <> 'array' then raise exception 'Ledger entries must be an array'; end if;
  select count(*)::integer,
    coalesce(sum(case when direction = 'debit' then amount_cents else 0 end), 0),
    coalesce(sum(case when direction = 'credit' then amount_cents else 0 end), 0)
  into v_entry_count, v_debits, v_credits
  from jsonb_to_recordset(p_entries) as entry(account_code text, direction text, amount_cents bigint, currency text)
  where direction in ('debit','credit') and amount_cents > 0 and lower(currency) = lower(p_currency);
  if v_entry_count < 2 or v_debits <> v_credits then raise exception 'Ledger transaction is not balanced'; end if;

  select * into v_transaction from public.payment_ledger_transactions
  where org_id = p_org_id and idempotency_key = p_idempotency_key;
  if v_transaction.id is not null then
    return to_jsonb(v_transaction) || jsonb_build_object('duplicate', true);
  end if;

  insert into public.payment_ledger_transactions (
    org_id, disbursement_id, provider_event_id, source_type, source_id,
    transaction_type, currency, idempotency_key, reverses_transaction_id,
    description, effective_at
  ) values (
    p_org_id, p_disbursement_id, p_provider_event_id, p_source_type, p_source_id,
    p_transaction_type, lower(p_currency), p_idempotency_key, p_reverses_transaction_id,
    p_description, p_effective_at
  ) returning * into v_transaction;

  insert into public.payment_ledger_entries (org_id, transaction_id, account_code, direction, amount_cents, currency)
  select p_org_id, v_transaction.id, account_code, direction, amount_cents, lower(currency)
  from jsonb_to_recordset(p_entries) as entry(account_code text, direction text, amount_cents bigint, currency text);
  return to_jsonb(v_transaction) || jsonb_build_object('duplicate', false);
end;
$$;

revoke all on function public.create_payment_run_atomic(uuid,uuid,uuid,text,text,smallint,bigint,bigint,bigint,bigint,jsonb,text,jsonb) from public, anon, authenticated;
revoke all on function public.submit_payment_run_atomic(uuid,uuid,uuid,text,timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_payment_run_atomic(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.decide_payment_control_change_atomic(uuid,uuid,uuid,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.create_funding_source_change_atomic(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.activate_matured_funding_change_atomic(uuid,uuid,timestamptz) from public, anon, authenticated;
revoke all on function public.decide_payment_run_atomic(uuid,uuid,uuid,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.record_ap_payment_atomic(uuid,uuid,text,text,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.record_ap_payment_reversal_atomic(uuid,uuid,bigint,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.post_payment_ledger_transaction_atomic(uuid,uuid,uuid,text,uuid,text,text,text,uuid,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.create_payment_run_atomic(uuid,uuid,uuid,text,text,smallint,bigint,bigint,bigint,bigint,jsonb,text,jsonb) to service_role;
grant execute on function public.submit_payment_run_atomic(uuid,uuid,uuid,text,timestamptz) to service_role;
grant execute on function public.cancel_payment_run_atomic(uuid,uuid,uuid) to service_role;
grant execute on function public.decide_payment_control_change_atomic(uuid,uuid,uuid,text,text,timestamptz) to service_role;
grant execute on function public.create_funding_source_change_atomic(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz) to service_role;
grant execute on function public.activate_matured_funding_change_atomic(uuid,uuid,timestamptz) to service_role;
grant execute on function public.decide_payment_run_atomic(uuid,uuid,uuid,text,text,text,timestamptz) to service_role;
grant execute on function public.record_ap_payment_atomic(uuid,uuid,text,text,text,text,text,timestamptz) to service_role;
grant execute on function public.record_ap_payment_reversal_atomic(uuid,uuid,bigint,text,text,text,jsonb) to service_role;
grant execute on function public.post_payment_ledger_transaction_atomic(uuid,uuid,uuid,text,uuid,text,text,text,uuid,text,timestamptz,jsonb) to service_role;

create or replace function public.enforce_payment_run_approval_separation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  run_requester uuid;
  run_org uuid;
begin
  select requested_by, org_id into run_requester, run_org
  from public.payment_runs
  where id = new.run_id;

  if run_requester is null then
    raise exception 'Payment run does not exist';
  end if;
  if new.org_id <> run_org then
    raise exception 'Approval organization must match payment run organization';
  end if;
  if new.approver_id = run_requester then
    raise exception 'Payment run requester cannot approve their own run';
  end if;
  return new;
end;
$$;

create trigger payment_run_approvals_separation
  before insert or update on public.payment_run_approvals
  for each row execute function public.enforce_payment_run_approval_separation();

create or replace function public.enforce_payment_control_approval_separation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  requester_user uuid;
  requester_identity uuid;
begin
  select requested_by_user_id, requested_by_identity_id
    into requester_user, requester_identity
  from public.payment_control_change_requests
  where id = new.change_request_id;
  if not found then raise exception 'Payment control change does not exist'; end if;
  if new.actor_user_id is not null and new.actor_user_id = requester_user then
    raise exception 'Payment control change requester cannot approve their own change';
  end if;
  if new.actor_identity_id is not null and new.actor_identity_id = requester_identity then
    raise exception 'Payment control change requester cannot approve their own change';
  end if;
  return new;
end;
$$;

create trigger payment_control_approvals_separation
  before insert or update on public.payment_control_change_approvals
  for each row execute function public.enforce_payment_control_approval_separation();

create or replace function public.prevent_payment_append_only_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception '% is append-only; create a reversal or correction entry', tg_table_name;
end;
$$;

create trigger payment_provider_events_append_only
  before update or delete on public.payment_provider_events
  for each row execute function public.prevent_payment_append_only_mutation();
create trigger payment_provider_event_attempts_append_only
  before update or delete on public.payment_provider_event_attempts
  for each row execute function public.prevent_payment_append_only_mutation();
create trigger payment_ledger_transactions_append_only
  before update or delete on public.payment_ledger_transactions
  for each row execute function public.prevent_payment_append_only_mutation();
create trigger payment_ledger_entries_append_only
  before update or delete on public.payment_ledger_entries
  for each row execute function public.prevent_payment_append_only_mutation();
create trigger platform_fee_events_append_only
  before update or delete on public.platform_fee_events
  for each row execute function public.prevent_payment_append_only_mutation();
create trigger payment_run_approvals_append_only
  before update or delete on public.payment_run_approvals
  for each row execute function public.prevent_payment_append_only_mutation();
create trigger payment_control_change_approvals_append_only
  before update or delete on public.payment_control_change_approvals
  for each row execute function public.prevent_payment_append_only_mutation();

create trigger vendor_portal_identities_set_updated_at before update on public.vendor_portal_identities
  for each row execute function public.tg_set_updated_at();
create trigger vendor_entities_set_updated_at before update on public.vendor_entities
  for each row execute function public.tg_set_updated_at();
create trigger vendor_entity_memberships_set_updated_at before update on public.vendor_entity_memberships
  for each row execute function public.tg_set_updated_at();
create trigger vendor_company_claims_set_updated_at before update on public.vendor_company_claims
  for each row execute function public.tg_set_updated_at();
create trigger payment_recipient_accounts_set_updated_at before update on public.payment_recipient_accounts
  for each row execute function public.tg_set_updated_at();
create trigger vendor_payment_relationships_set_updated_at before update on public.vendor_payment_relationships
  for each row execute function public.tg_set_updated_at();
create trigger payment_rail_policies_set_updated_at before update on public.payment_rail_policies
  for each row execute function public.tg_set_updated_at();
create trigger org_payment_provider_accounts_set_updated_at before update on public.org_payment_provider_accounts
  for each row execute function public.tg_set_updated_at();
create trigger org_funding_sources_set_updated_at before update on public.org_funding_sources
  for each row execute function public.tg_set_updated_at();
create trigger payment_control_change_requests_set_updated_at before update on public.payment_control_change_requests
  for each row execute function public.tg_set_updated_at();
create trigger payment_runs_set_updated_at before update on public.payment_runs
  for each row execute function public.tg_set_updated_at();
create trigger payment_run_items_set_updated_at before update on public.payment_run_items
  for each row execute function public.tg_set_updated_at();
create trigger payment_run_item_payees_set_updated_at before update on public.payment_run_item_payees
  for each row execute function public.tg_set_updated_at();
create trigger disbursements_set_updated_at before update on public.disbursements
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS and explicit Data API grants
-- ---------------------------------------------------------------------------

alter table public.vendor_portal_identities enable row level security;
alter table public.vendor_entities enable row level security;
alter table public.vendor_entity_memberships enable row level security;
alter table public.vendor_company_claims enable row level security;
alter table public.payment_recipient_accounts enable row level security;
alter table public.vendor_payment_relationships enable row level security;
alter table public.payment_rail_policies enable row level security;
alter table public.org_payment_provider_accounts enable row level security;
alter table public.org_funding_sources enable row level security;
alter table public.payment_control_change_requests enable row level security;
alter table public.payment_control_change_approvals enable row level security;
alter table public.payment_runs enable row level security;
alter table public.payment_run_items enable row level security;
alter table public.payment_run_item_payees enable row level security;
alter table public.payment_run_approvals enable row level security;
alter table public.disbursements enable row level security;
alter table public.payment_provider_events enable row level security;
alter table public.payment_provider_event_attempts enable row level security;
alter table public.payment_ledger_transactions enable row level security;
alter table public.payment_ledger_entries enable row level security;
alter table public.payment_fee_policies enable row level security;
alter table public.platform_fee_events enable row level security;
alter table public.payment_risk_reviews enable row level security;
alter table public.payment_reconciliation_runs enable row level security;
alter table public.payment_reconciliation_items enable row level security;

-- Sensitive/global records have no anon/authenticated grants. Portal and platform
-- services access them only with the server-side service role.
revoke all on table
  public.vendor_portal_identities,
  public.vendor_entities,
  public.vendor_entity_memberships,
  public.payment_recipient_accounts,
  public.org_payment_provider_accounts,
  public.org_funding_sources,
  public.payment_control_change_requests,
  public.payment_control_change_approvals,
  public.payment_provider_events,
  public.payment_provider_event_attempts,
  public.payment_fee_policies,
  public.platform_fee_events
from anon, authenticated;

grant all on table
  public.vendor_portal_identities,
  public.vendor_entities,
  public.vendor_entity_memberships,
  public.vendor_company_claims,
  public.payment_recipient_accounts,
  public.vendor_payment_relationships,
  public.payment_rail_policies,
  public.org_payment_provider_accounts,
  public.org_funding_sources,
  public.payment_control_change_requests,
  public.payment_control_change_approvals,
  public.payment_runs,
  public.payment_run_items,
  public.payment_run_item_payees,
  public.payment_run_approvals,
  public.disbursements,
  public.payment_provider_events,
  public.payment_provider_event_attempts,
  public.payment_ledger_transactions,
  public.payment_ledger_entries,
  public.payment_fee_policies,
  public.platform_fee_events,
  public.payment_risk_reviews,
  public.payment_reconciliation_runs,
  public.payment_reconciliation_items
to service_role;

create policy vendor_company_claims_read on public.vendor_company_claims
  for select to authenticated
  using (public.has_org_permission(org_id, 'payments.manage_rail'));
create policy vendor_payment_relationships_read on public.vendor_payment_relationships
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_rail_policies_read on public.payment_rail_policies
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_runs_read on public.payment_runs
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_run_items_read on public.payment_run_items
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_run_item_payees_read on public.payment_run_item_payees
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_run_approvals_read on public.payment_run_approvals
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy disbursements_read on public.disbursements
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_ledger_transactions_read on public.payment_ledger_transactions
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_ledger_entries_read on public.payment_ledger_entries
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_risk_reviews_read on public.payment_risk_reviews
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_reconciliation_runs_read on public.payment_reconciliation_runs
  for select to authenticated
  using (org_id is not null and public.has_org_permission(org_id, 'payment.reconcile'));
create policy payment_reconciliation_items_read on public.payment_reconciliation_items
  for select to authenticated
  using (org_id is not null and public.has_org_permission(org_id, 'payment.reconcile'));

grant select on table
  public.vendor_company_claims,
  public.vendor_payment_relationships,
  public.payment_rail_policies,
  public.payment_runs,
  public.payment_run_items,
  public.payment_run_item_payees,
  public.payment_run_approvals,
  public.disbursements,
  public.payment_ledger_transactions,
  public.payment_ledger_entries,
  public.payment_risk_reviews,
  public.payment_reconciliation_runs,
  public.payment_reconciliation_items
to authenticated;

-- ---------------------------------------------------------------------------
-- RBAC catalog
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('payments.manage_rail', 'Manage payment rail settings, vendor relationships, and funding sources'),
  ('payments.approve_run', 'Approve or reject electronic payment runs'),
  ('payment.reconcile', 'Review payment ledger reconciliation and resolve exceptions')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['payments.manage_rail','payments.approve_run']) p(permission_key)
where r.key in ('org_owner','org_admin','org_office_admin')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'payment.reconcile'
from public.roles r
where r.key in ('org_owner','org_admin','org_office_admin','org_bookkeeper')
on conflict (role_id, permission_key) do nothing;

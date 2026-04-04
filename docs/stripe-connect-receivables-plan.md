# Stripe Connect Plan For Receivables

## Why this change is required

Today, invoice payments in Arc are created with the platform Stripe keys:

- `lib/integrations/payments/stripe.ts`
- `app/i/[token]/page.tsx`
- `app/p/[token]/invoices/[id]/page.tsx`

That means:

- Arc creates the `PaymentIntent` on Arc's Stripe account.
- Arc renders checkout with Arc's publishable key.
- Stripe settles the funds into Arc's Stripe balance.
- The app records the invoice as paid, but there is no org-specific payout destination.

For a multi-tenant product where each builder/construction company is collecting its own receivables, we need Stripe Connect.

This is separate from Arc's existing Stripe billing setup for charging organizations for Arc subscriptions.

## Current state summary

### Billing Stripe usage already exists

The existing subscription flow stores:

- `subscriptions.external_customer_id`
- `subscriptions.external_subscription_id`

These are for Arc billing only. They represent the organization as Arc's customer, not the builder as a merchant collecting homeowner/client payments.

Files:

- `app/(app)/settings/actions.ts`
- `lib/services/subscriptions.ts`

### Receivables Stripe usage is platform-only

Current receivables flow:

1. Public invoice page or portal page calls `createPaymentIntent`.
2. `createPaymentIntent` calls `createStripePaymentIntent`.
3. `createStripePaymentIntent` creates a Stripe `PaymentIntent` using the platform secret key only.
4. Stripe webhook marks the invoice as paid.

Missing pieces:

- no connected account per org
- no onboarding flow for payout details
- no `transfer_data.destination`
- no `on_behalf_of`
- no application fee strategy
- no connected account status gating before pay links go live
- no real Stripe fee ingestion for accounting

## Recommended Stripe model

Use Stripe Connect for receivables.

Recommended first implementation:

- Connected accounts per org
- Destination charges for invoice payments
- `application_fee_amount` if Arc takes a platform fee
- `on_behalf_of` when needed so the builder is the settlement merchant

Why destination charges first:

- Best fit when the customer pays through Arc's invoice experience for services provided by the builder
- Platform has good visibility across payments
- Works well with platform-level AR reporting
- Lets Arc collect an application fee while moving funds to the builder

Important Stripe note:

- Stripe's current docs recommend Accounts v2 for new Connect platforms and recommend destination charges for many platform use cases.
- Stripe also notes that payout settings and external account management still use Accounts v1 surfaces in some cases.

## Core product boundary

We need to keep two Stripe domains separate:

### 1. Arc billing

Purpose:

- Arc charges builders for using Arc

Existing data:

- `subscriptions.external_customer_id`
- `subscriptions.external_subscription_id`

### 2. Receivables / merchant payouts

Purpose:

- Builders charge their clients through Arc-hosted invoice links

New data needed:

- connected Stripe account for each org
- onboarding status
- payout readiness
- payment routing metadata

Do not reuse subscription customer/account fields for receivables.

## Database changes

## 1. Add a dedicated table for connected accounts

Recommended new table: `stripe_connected_accounts`

Suggested columns:

- `id uuid primary key default gen_random_uuid()`
- `org_id uuid not null references orgs(id) on delete cascade`
- `stripe_account_id text not null`
- `status text not null default 'pending'`
- `charges_enabled boolean not null default false`
- `payouts_enabled boolean not null default false`
- `details_submitted boolean not null default false`
- `country text null`
- `default_currency text null`
- `dashboard_type text null`
- `requirement_collection text null`
- `onboarding_started_at timestamptz null`
- `onboarding_completed_at timestamptz null`
- `disabled_reason text null`
- `requirements_currently_due jsonb not null default '[]'::jsonb`
- `requirements_eventually_due jsonb not null default '[]'::jsonb`
- `metadata jsonb not null default '{}'::jsonb`
- `created_by uuid null references app_users(id)`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Suggested indexes/constraints:

- unique index on `org_id` where status in active lifecycle states
- unique index on `stripe_account_id`
- index on `(org_id, status)`

Why a table instead of `org_settings.settings`:

- this is operational money-routing data, not UI settings
- we need lifecycle and audit fields
- we will likely sync webhook/account capability state into it
- it follows the same pattern already used by `qbo_connections`

## 2. Extend `payment_intents`

Suggested new columns on `payment_intents`:

- `connected_account_id text null`
- `charge_type text null`
- `provider_charge_id text null`
- `provider_transfer_id text null`
- `application_fee_amount integer null`
- `processor_fee_cents integer null`
- `platform_fee_cents integer null`
- `on_behalf_of_account_id text null`

Why:

- we need to know where a payment was meant to go
- we need to reconcile intent -> charge -> transfer
- we need to support dispute/refund workflows later

## 3. Extend `payments`

Suggested new columns on `payments`:

- `connected_account_id text null`
- `provider_charge_id text null`
- `provider_balance_transaction_id text null`
- `provider_transfer_id text null`
- `application_fee_cents integer not null default 0`
- `processor_fee_cents integer not null default 0`
- `platform_fee_cents integer not null default 0`
- `gross_cents integer null`

Notes:

- `amount_cents` can remain the gross payment amount if that matches current semantics
- `net_cents` should become Stripe-confirmed net, not a derived placeholder

## 4. Add webhook idempotency storage

Recommended new table: `webhook_events`

Suggested columns:

- `id uuid primary key default gen_random_uuid()`
- `provider text not null`
- `provider_event_id text not null`
- `event_type text not null`
- `org_id uuid null`
- `status text not null default 'received'`
- `payload jsonb not null default '{}'::jsonb`
- `processed_at timestamptz null`
- `created_at timestamptz not null default now()`

Constraint:

- unique index on `(provider, provider_event_id)`

Why:

- Stripe webhooks are at-least-once
- Connect adds more event types and more complicated side effects
- we should stop relying only on payment idempotency for webhook safety

## 5. Optional naming cleanup for Arc billing

Not required for launch, but recommended:

- rename `subscriptions.external_customer_id` -> `billing_customer_id`
- rename `subscriptions.external_subscription_id` -> `billing_subscription_id`

If renaming is too disruptive, keep current columns and document clearly that they are for Arc billing only.

## Application changes

## 1. Add Stripe Connect onboarding in Settings

Add a new integration card next to QuickBooks:

- Connect Stripe payouts
- Start onboarding
- Resume onboarding
- Show readiness state:
  - `pending`
  - `restricted`
  - `active`
  - `error`

The org should be able to:

- create or resume its connected account
- provide payout bank account details
- satisfy verification requirements
- see whether charges and payouts are enabled

## 2. Gate receivables payment collection

Before showing a live payment form for an invoice:

- org must have an active connected account
- account must be eligible to accept charges
- if ACH/card are required, required capabilities must be present

If not ready:

- show invoice read-only
- show "online payments unavailable" or similar
- keep manual payment instructions as fallback

## 3. Route invoice payments to the connected account

When creating the invoice payment:

- load the org's connected account
- create the payment with Connect routing
- record the connected account id on the intent

For destination charges:

- create on Arc's platform account
- set destination to the org's connected account
- set `application_fee_amount` if Arc charges a fee
- set `on_behalf_of` when appropriate

## 4. Update webhook processing

Webhook handler should:

- verify and store the Stripe event
- process payment lifecycle events idempotently
- update `payment_intents` with charge/transfer/account details
- record actual Stripe fees and net
- keep invoice balance updates as a downstream effect, not the only source of truth

At minimum handle:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.succeeded`
- `charge.updated`
- `charge.failed`
- `charge.dispute.created`
- `charge.refunded`
- relevant account/requirement updates for connected accounts

## 5. Keep builder branding honest in checkout

The public invoice payment UI currently uses:

- Arc business name in the payment element

That should be updated to reflect the builder when possible, or at minimum avoid implying Arc is the merchant when the builder is.

## Fee and reporting changes

Current issue:

- the app writes `fee_cents = 0` from webhook mapping
- `net_cents` is derived from the provided fee instead of real Stripe settlement data

We need:

- Stripe fee breakdown from balance transaction data
- application fee amount stored separately from processor fee
- clear distinction between:
  - gross paid by homeowner/client
  - Stripe processor fee
  - Arc platform fee
  - net to builder

This matters for:

- AR ledger accuracy
- payout reconciliation
- disputes and refunds
- future exports to QuickBooks

## Suggested rollout plan

## Phase 1: Data model and safety rails

- add `stripe_connected_accounts`
- extend `payment_intents`
- extend `payments`
- add `webhook_events`
- add service methods for loading org payment readiness
- block online pay links for orgs without a ready connected account

This phase stops new orgs from accidentally sending money to Arc.

## Phase 2: Onboarding flow

- create connected account for org
- build settings UI to onboard or resume onboarding
- sync connected account status into DB
- show readiness in settings and invoice composer surfaces

## Phase 3: Payment routing

- update `createStripePaymentIntent` to support Connect routing
- update payment creation service to require a ready connected account
- write payment routing metadata into DB

## Phase 4: Webhook hardening and accounting accuracy

- store webhook events
- ingest real charge/balance transaction details
- record actual processor/application/net values
- add dispute/refund handling

## Phase 5: Reporting and downstream sync

- update receivables reporting to show settlement and fee breakdown
- update QBO payment sync mapping if fee/net detail needs to be exported
- add admin diagnostics for failed onboarding or skipped transfers

## Minimal shipping rule

Do not enable online payments for an org unless:

- a connected account exists
- onboarding is complete enough for charges
- payouts are enabled

If those conditions are not met, invoice links can still be public, but payment should be disabled.

## Open implementation questions

1. Does Arc charge a platform fee on receivables?

If yes:

- define fee model now
- decide whether it varies by ACH vs card
- store fee policy in config, not only in code

1. Who should appear as merchant of record?

Likely the builder/org, not Arc.

That affects:

- `on_behalf_of`
- statement descriptors
- support details collected during onboarding

1. Do we need embedded onboarding or Stripe-hosted onboarding first?

Recommended:

- Stripe-hosted or embedded onboarding
- avoid building custom verification forms

1. Do we need to support organizations without online payouts?

If yes:

- keep manual payment instructions in invoice defaults
- treat online payments as optional per org

## Immediate code targets

Primary files to change first:

- `lib/integrations/payments/stripe.ts`
- `lib/services/payments.ts`
- `app/api/webhooks/stripe/route.ts`
- `app/(app)/settings/actions.ts`
- `components/settings/settings-window.tsx`

Primary schema work:

- add `stripe_connected_accounts`
- extend `payment_intents`
- extend `payments`
- add `webhook_events`

## Conclusion

This is a real architecture gap, but it is fixable without rewriting the entire receivables module.

The correct direction is:

- keep Arc subscription billing as-is
- add Stripe Connect for org receivables
- store connected-account lifecycle in first-class tables
- route invoice payments to the org's connected account
- block payment collection until the org is payout-ready

That will make the receivables flow safe for a true multi-tenant launch.
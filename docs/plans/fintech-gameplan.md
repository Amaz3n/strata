# Fintech Gameplan — Arc's Money Layer

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** Foundation schema, services, provider adapter, controls, portal, operations
UI, event handling, ledger, and reconciliation are implemented in code. The foundation
migration has been applied. Money movement is disabled, no org has the rail enabled,
and the external STOP gates remain closed.
**Updated:** 2026-08-01.
**Audience:** product, engineering, operations, risk, and legal.
**Companions:** `docs/plans/arc-books-gameplan.md`, `docs/plans/procore-parity-gameplan.md`, and
`docs/plans/tech-frontier-gameplan.md`.

This document is an execution contract. A **STOP** means the executor must stop and
obtain the named approval. Do not route around a STOP with a different provider or a
temporary production implementation.

### Implementation snapshot

Implemented against the pending schema:

- global vendor identities, explicit builder-company claims, Arc-wide vendor entities,
  cross-builder relationship/payment visibility, and Stripe Express onboarding;
- provider-neutral payment rails with Stripe funding setup and recipient sync;
- org-selectable sole/dual run approval, immutable approval evidence, two-person
  funding changes, recent-MFA checks, and cooling periods;
- atomic draft creation, submission, cancellation, approval/rejection, AP payment,
  AP reversal, sensitive control decisions, and ledger posting;
- shared bill-release checks, frozen run evidence and fees, automated risk signals,
  provider event normalization, return handling, and daily reconciliation;
- payment settings, payment-run operations, vendor-portal payment setup/status, RBAC,
  notifications, cron registration, and platform/per-org execution kill switches.

Not enabled or represented as complete:

- live customer movement, live payout-bank edits, Stripe program configuration, fee
  pricing, Florida-generated waiver language, and QA acceptance;
- vendor-identity recovery and vendor-admin step-up, whose authentication/recovery
  channel must be selected before implementation;
- cards, capital/early pay, and treasury, which remain later gated programs.

---

## 1. Product thesis

Arc's strongest fintech wedge is construction accounts payable, not cards. Most
construction spend is governed by commitments, pay applications, compliance,
retainage, and lien waivers. Arc already knows when a bill is eligible for release.
The money product should extend that control point:

1. A builder prepares a payment run from approved, releasable bills.
2. Arc re-evaluates holds and captures immutable evidence.
3. One or two people other than the preparer approve the run, by org policy.
4. A regulated provider debits the builder and pays each vendor.
5. Arc reconciles every provider event to an append-only, double-entry subledger.
6. Arc Books consumes the resulting accounting events; it does not infer them from
   mutable payment status fields.

This creates a defensible system of control and record around the moment money moves.
Cards, early pay, capital referrals, and treasury are possible expansions, but they
must follow a reliable AP rail rather than compete with it for initial focus.

### What Arc is and is not

Arc is the workflow, control, orchestration, and evidence layer. A regulated partner
is the payment rail. Arc does not intentionally hold customer funds or operate an
Arc-owned FBO account in this plan.

That architecture reduces regulatory scope; it does **not** justify claims that Arc
has no payment, return, fraud, dispute, reserve, credit, or licensing exposure.
Destination-charge and ACH-return allocation depends on the final provider contract
and account configuration. Marketing and contracts must describe the approved model,
not an architectural aspiration.

**STOP — provider and legal approval:** No customer money may move until Stripe (or a
replacement provider), payments counsel, finance, and risk approve the exact flow of
funds, controller properties, return allocation, reserves, disclosures, and prohibited
use cases.

---

## 2. Decisions already approved

These decisions are settled for the foundation and should not be silently changed:

- **Vendor onboarding:** Stripe Connect Express is the first provider adapter.
- **One-time vendor onboarding:** a vendor legal entity creates one Arc-wide recipient
  account, then explicitly claims relationships with individual builders.
- **The claim is a mapping, not a gate.** Authorization to act for a builder's vendor
  record is established entirely by the portal session — token, invited email,
  password, and grant. The claim contributes no additional proof, so it is resolved
  inside the single payout-setup action rather than presented as a step the vendor
  confirms separately. The one genuine decision it carries — *which* global vendor
  entity this builder's company record maps to — is asked only when the vendor already
  administers more than one, and never inferred by name, email, or EIN.
- **Portal identity:** onboarding is tied to the authenticated vendor portal. Existing
  `/s/[token]` links become invitations to claim access, not permanent bearer-token
  identity.
- **No automatic entity merging:** never join vendors across builders using email,
  company name, EIN fragments, bank fingerprints, or fuzzy matching alone.
- **Provider-neutral core:** payment runs, controls, events, ledger, fees, and
  reconciliation are Arc concepts. Stripe IDs are adapter references.
- **Approval choice:** each org selects `sole` or `dual`. Sole means one approver;
  dual means two distinct approvers. The payment-run preparer cannot approve their
  own run in either mode.
- **Default approval mode:** dual.
- **Sensitive changes:** funding-source and payout-destination changes require two
  independent approvals, recent authentication, notifications, and a cooling period,
  regardless of the org's payment-run approval mode.
- **Initial pricing:** subscription plus provider costs passed through at cost. No
  unvalidated flat per-payment markup is enabled by default.
- **Lien waivers:** Florida first. Other jurisdictions stay disabled until separately
  reviewed and implemented.
- **Go-live sequence:** provider-neutral foundation first; Stripe test mode only for
  the QA org after the migration and external approvals.

### One decision intentionally deferred

Before live payout-bank changes, choose the second-reviewer operating model:

- a second administrator of the same vendor entity, or
- an Arc payments-operations reviewer under a documented verification playbook.

The schema supports either. Engineering must not choose between them implicitly.

**STOP — bank-change operating model:** No live payout-destination edit can be enabled
until the human selects the reviewer model and operations documents recovery,
escalation, and fraud-loss ownership.

---

## 3. Existing product ground truth

Read the current implementation before modifying it:

- `lib/integrations/payments/stripe.ts` owns the Stripe client and existing AR flows.
- `lib/services/stripe-connected-accounts.ts` manages org receivables accounts.
- `app/api/webhooks/stripe/route.ts` verifies platform and Connect events and uses
  `webhook_events` for current idempotency.
- `lib/services/vendor-bills.ts` owns manual AP payment recording.
- `lib/services/payment-holds.ts` evaluates release controls.
- `lib/services/lien-waivers.ts` contains conditional/unconditional waiver building
  blocks.
- `app/s/[token]` is the vendor portal.
- `lib/services/external-portal-auth.ts` already provides password authentication,
  session cookies, token claiming, and builder-scoped portal grants.
- `external_portal_accounts` is currently org-scoped. It cannot by itself represent
  one identity across builders.
- `payments` serves AR and AP history, but mutable rows are not a sufficient provider
  event log or accounting subledger.

The global identity migration must layer onto existing portal accounts. It must not
merge existing records by email during migration. A vendor links a legacy builder
profile to a global identity only after authenticating and explicitly accepting the
claim.

---

## 4. Target architecture

### 4.1 Identity model

Keep people, legal entities, and builder records separate:

- `vendor_portal_identities`: a human's global Arc vendor login.
- `vendor_entities`: a vendor's global legal/business identity.
- `vendor_entity_memberships`: humans authorized to administer a vendor entity.
- `external_portal_accounts`: existing org-scoped compatibility profiles.
- `vendor_company_claims`: explicit mapping from one builder's `companies` row to a
  global vendor entity.
- `vendor_payment_relationships`: payment eligibility and status for that specific
  builder/vendor relationship.
- `payment_recipient_accounts`: provider onboarding and payout readiness for the
  global vendor entity.

A human can administer multiple vendor entities. One vendor entity can work with many
builders. Each builder retains authority over its own relationship and bills; it does
not own or edit the vendor's global payout account.

### 4.2 Provider adapter boundary

The application service boundary should expose provider-neutral operations:

```ts
interface PaymentRailProvider {
  createRecipientOnboarding(input: RecipientOnboardingInput): Promise<OnboardingLink>
  syncRecipient(input: SyncRecipientInput): Promise<RecipientSnapshot>
  createFundingSetup(input: FundingSetupInput): Promise<FundingSetupSession>
  submitDisbursement(input: SubmitDisbursementInput): Promise<ProviderDisbursement>
  parseWebhook(input: RawWebhookInput): Promise<NormalizedProviderEvent>
  fetchReconciliation(input: ReconciliationInput): Promise<ProviderBalanceActivity[]>
}
```

The Stripe implementation may use PaymentIntents, transfers, payouts, Connect
accounts, and Financial Connections, but those object types must not become the
domain status vocabulary.

### 4.3 Operational records versus accounting evidence

The core model has four layers:

1. `payment_runs`, items, payees, and approvals describe human intent and control.
2. `disbursements` describe provider-neutral movement attempts.
3. `payment_provider_events` store immutable provider facts with deduplication.
4. `payment_ledger_transactions` and entries store balanced accounting evidence.

Provider events and ledger rows are append-only. Corrections use new processing
attempts, reversal transactions, and entries. No webhook handler may rewrite history.

### 4.4 State model

Use monotonic domain transitions, with explicit return/reversal paths:

```text
created
  -> submitted
  -> debit_pending
  -> funds_available
  -> transfer_pending
  -> payout_pending
  -> paid

created/submitted/debit_pending -> failed | canceled
funds_available/transfer_pending/payout_pending/paid -> returned | reversed
```

Do not mark a vendor bill paid merely because the builder debit succeeded. The
payment service records the appropriate paid/settled state only at the provider event
approved by accounting policy. The UI must distinguish “builder debited,” “in
transit,” and “vendor paid.”

---

## 5. Payment controls

### 5.1 Release gates

Extract one shared `assertBillReleasable` service used by manual payment recording and
electronic runs. It must cover:

- payment permission;
- policy holds and approved overrides;
- compliance-document state;
- conditional/unconditional waiver state;
- sub-tier waivers when applicable;
- retainage and partial-payment math;
- pay-when-paid/funding state;
- duplicate/in-flight payment detection;
- vendor relationship and recipient readiness.

Evaluate gates when adding a bill to a run and again immediately before submission.
Persist hold and waiver snapshots on each run item so reviewers can see what they
approved.

### 5.2 Maker/checker

- The preparer submits a frozen run.
- Changing bills, amounts, payees, destinations, funding source, fees, or evidence
  invalidates existing approvals and returns the run to draft.
- Approvers need `payments.approve_run` and recent step-up authentication.
- One rejection closes the run; the preparer creates a new revision/run.
- Dual mode requires two distinct approvers.
- Approval rows are immutable evidence.

### 5.3 Fraud controls

Before submission, evaluate and persist:

- per-payment, per-run, and daily limits;
- new or recently changed funding/payout destinations;
- velocity and repeated-failure signals;
- duplicate amount/vendor/bill patterns;
- dormant or newly claimed vendor relationships;
- unusual location/device/session signals when available;
- provider restrictions and requirements due.

Bank and funding changes require recent authentication, two independent approvals,
out-of-band notifications to every affected party, and a configurable 24–168 hour
cooling period (72 hours by default). Never include full bank data in Arc logs,
notifications, or general org-readable tables.

### 5.4 Joint checks, partial payments, and retainage

One run item can have multiple payees. A joint payee can be paid by an external check
until an approved electronic joint-payee flow exists. The sum of payees must equal the
vendor amount, enforced in the service transaction. Partial payments create new runs
after the prior attempt reaches a terminal state. Retainage is explicit and never
folded into a generic fee field.

---

## 6. Florida waiver workstream

Florida is the only enabled jurisdiction for the first release. Build a state-aware
waiver policy rather than a boolean `waiver_signed` shortcut:

- conditional progress waiver;
- unconditional progress waiver after confirmed payment;
- conditional final waiver;
- unconditional final waiver after confirmed final payment;
- required signer/authority evidence;
- document version and template provenance;
- payment amount, through-date, project, payer, payee, and exceptions;
- sub-tier waiver collection when policy requires it.

The payment-run item stores a snapshot of the waiver evidence reviewed. Signed source
documents remain immutable.

**STOP — Florida legal approval:** Before generating customer-facing waiver language,
Florida construction counsel must approve templates, timing, electronic-signature
language, retention, and the exact relationship between payment confirmation and an
unconditional waiver. The product may collect uploaded waivers before approval, but
must not represent generated language as legally sufficient.

---

## 7. Pricing and revenue

### Initial model

- Arc subscription revenue remains the primary fee.
- Provider processing costs are itemized and passed through at cost where contracts
  and applicable law permit.
- AP platform markup defaults to zero.
- All fee quotes are frozen on the run before approval.
- Every recognized platform fee produces one idempotent `platform_fee_events` row and
  balanced ledger entries.

Do not launch a flat `$1.50` fee merely because it appeared in an earlier draft. Price
only after measuring provider cost, ACH returns, support, fraud loss, reserves,
reconciliation operations, and willingness to pay.

### Fee engine

Create one fee engine for AR ACH, AR card, AP disbursement, card interchange, and
early-pay spread. Migrate existing AR gross-up math without changing current customer
quotes. Delete the existing dead fee helper only after call-site coverage proves it is
unused.

---

## 8. Delivery sequence and STOP gates

### Phase 0 — Foundation migration (applied)

Migration: `supabase/migrations/20260731221030_fintech_payment_foundation.sql`

It establishes global vendor identity/entity claims, recipients, relationships,
funding sources, approval policy, payment runs, multiple payees, disbursements,
provider events, an append-only ledger, fees, risk reviews, reconciliation, RLS, and
RBAC.

The schema exists in production. It carries no rows and no org has
`payment_rail_policies.enabled` set, so every vendor- and builder-facing payment
surface still fails closed on that flag.

### Phase 1 — Identity and portal claims (implemented)

1. Add global vendor identity login/session support using the existing portal UX and
   security controls as the migration bridge.
2. Turn `/s/[token]` account gates into explicit claim invitations.
3. Let a verified identity create/select a vendor entity and map the builder's company
   record onto it, as part of starting payout verification rather than before it.
4. Show all builder relationships in `/access`, with clear boundaries between them.
5. Source-level guard tests assert that portal authorization, invitation-email
   matching, vendor-entity administrator membership, and hash-based token resolution
   remain in the claim path, and that no second credential prompt returns to it.
   End-to-end cross-builder isolation remains part of QA acceptance.

Still gated: vendor-entity membership administration, recovery, vendor-admin step-up,
and the associated security notifications require an approved vendor authentication
and recovery channel. The builder-side payment MFA path is implemented.

### Phase 2 — Recipient onboarding and builder setup (implemented; live use gated)

1. Implement the provider interface and Stripe Connect Express adapter.
2. Launch hosted onboarding from the authenticated vendor portal.
3. Sync requirements and readiness from signed provider webhooks.
4. Add builder funding setup with provider-hosted bank collection; store only tokens
   and masked metadata.
5. Implement sensitive-change requests, dual review, cooling periods, and
   notifications.
6. Add Payments settings inside the existing settings information architecture.

No money moves in this phase.

**STOP — Stripe program configuration:** Confirm the exact supported Connect account
controller configuration, platform liability, ACH debit flow, transfers, payouts,
webhook routing, reserves, and pricing in writing. Do not reuse an unsupported
controller combination from an older draft.

### Phase 3 — Payment runs and ledger (implemented; execution gated)

1. Implement shared bill-release assertions.
2. Implement draft, submit, approve/reject, preparer cancel, and execute services with
   atomic database functions and idempotency.
3. Implement the fee quote snapshot and risk decision.
4. Normalize provider webhooks into append-only provider events and processing
   attempts.
5. Post balanced ledger transactions for every lifecycle event.
6. Reconcile provider activity, internal movement attempts, ledger entries, and bill
   payments.
7. Add return/reversal handling that reopens the payable state and notifies humans.
8. Keep “Record external payment” alongside electronic payment.

### Phase 4 — QA-only Stripe test flow (not run)

Enable with a platform-controlled flag for the QA org only. Test:

- one and two approver flows;
- preparer self-approval rejection;
- onboarding reuse across two builders;
- held bills and stale approval invalidation;
- partial payment, retainage, and joint external check;
- duplicate webhooks and out-of-order events;
- ACH failure before settlement;
- return/reversal after apparent success;
- bank-change cooling period and notifications;
- reconciliation balanced and exception cases;
- least-privilege/RLS isolation.

**STOP — customer enablement:** A human reviews QA evidence, provider/legal approvals,
incident runbooks, reconciliation ownership, support procedures, and feature-flag
scope before any customer org is enabled.

### Phase 5 — Florida waiver automation

After Florida legal approval, add versioned templates and the conditional → payment
confirmed → unconditional workflow. Do not silently expand to another state.

### Phase 6 — Existing-card ingestion

Before issuing Arc cards, ingest and reconcile customers' existing corporate-card
transactions. Auto-suggest project, cost code, commitment, receipt, and accounting
coding. This delivers spend visibility without immediately taking on a card program.

### Phase 7 — Arc cards

Cards are a gated later expansion for field spend and controlled material purchases,
not the primary construction-spend rail. Require issuer/program approval and a
provider-specific design for funding, fraud, disputes, cardholder verification,
authorization latency, and loss ownership.

**STOP — cards:** Do not build or promise live Issuing until a human approves the
program partner and commercial/risk model. Never assume Arc can fund a shared balance
or front customer spend.

### Phase 8 — Capital and early pay

Build a permissioned underwriting data package for selected partners: contract,
change-order, draw, receivable, payable, schedule, variance, and payment-performance
signals with lineage. Start with partner referrals and customer consent.

Do not lend from Arc's balance sheet. Do not launch early-pay discounting until legal,
accounting, tax, disclosure, credit-loss, and partner-funding models are approved.

### Phase 9 — Treasury

Do not build treasury, deposits, or an Arc-owned FBO account. Revisit only with a bank
partner, a clear customer problem, proven AP volume, legal analysis, and board-level
risk approval.

---

## 9. Implementation invariants

- Integer cents only; no JavaScript floating-point money math.
- Every org-owned query is explicitly org-scoped.
- All provider requests and event processing are idempotent.
- Webhook signatures are verified before parsing or persistence.
- Provider events are stored once and never mutated.
- Ledger corrections are reversals, never edits or deletes.
- Debit and credit totals must balance before a ledger transaction is committed.
- No full account/routing numbers, tax IDs, secrets, or raw identity documents in
  general application tables, logs, analytics, or notifications.
- Server services re-check permission and state; UI visibility is not authorization.
- Run approvals bind to a frozen content/control hash. Any material change invalidates
  them.
- A vendor recipient account can be reused across builders only through explicit,
  authenticated claims.
- One builder cannot see another builder's bills, payments, claims, or relationship
  metadata.
- “Paid” labels must state whose state they describe: builder debit, funds available,
  transfer, payout, or reconciled vendor payment.

---

## 10. Minimum production readiness

Production enablement requires all of the following:

- provider and payments-counsel sign-off;
- approved bank-change reviewer model;
- Florida waiver approval for any generated waiver feature;
- QA evidence for sole and dual approvals;
- tested ACH return and reversal paths;
- daily automated reconciliation with owned exception queues;
- audited least-privilege access and secret handling;
- incident, fraud, account-takeover, and vendor-support runbooks;
- limits, alerts, kill switch, and per-org feature flags;
- clear customer disclosures for fees, timing, returns, and support;
- measured unit economics and approved pricing;
- accounting export behavior verified with Arc Books.

The launch metric is not payment volume alone. Track activation, percent of eligible
bills paid through Arc, time from approval to vendor receipt, return/failure rate,
manual exception rate, reconciliation breaks, support contacts, fraud loss, gross
margin, and vendor onboarding reuse across builders.

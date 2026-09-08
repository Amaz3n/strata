# Fintech Gameplan — Arc's Money Layer

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** Foundation schema, services, provider adapter, controls, portal, operations
UI, event handling, ledger, provider-led reconciliation, and enforced launch gates are
implemented in code. The foundation migration has been applied; the 2026-08-12
hardening migrations were applied to the Arc Supabase project through the Supabase
MCP and verified in production. Money movement is disabled, no org has the rail
enabled, and the external STOP gates remain closed.
**Updated:** 2026-09-03.
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

Hardening completed in code and applied through the Supabase MCP on 2026-08-12:

- manual AP payments and vendor-credit applications now use locked, idempotent RPCs
  as the only writers of payable payment rollups;
- draft approval is rejected by service, bulk path, and a database trigger;
- approved payable obligations become database-immutable while attached to an active
  payment run, and run submit/approval/execution revalidate the live bill, vendor,
  relationship, holds, waivers, balance, currency, and jurisdiction;
- policy enablement requires finite monotonic exposure limits, minimum cooling holds,
  active funding, both execution jobs, and five current append-only launch attestations;
- provider webhook attempts are allocated atomically; ACH inquiries no longer masquerade
  as returns; funding invalidation and payout failure create durable operational cases;
- reconciliation independently enumerates provider payments, transfers, payouts, and
  fee charges, detects provider-only money, exhaustively pages stale cases, and advances
  the success watermark only after a complete successful run;
- clean local schema replay and the focused AP pgTAP suite are verified; migration
  versions that previously collided were made unique so all files are recorded.
- execution checkpoints cover process death before and during provider submission,
  and payout release honors both the rail policy and org feature switch;
- builder-controlled vendor suspension/revocation, strict portal-token lifecycle,
  entity-membership portal visibility, period-correct waivers, and hold-override
  authorization are implemented;
- provider webhook objects are normalized by their adapter before domain processing;
- payment permissions use one `payment.<verb>` namespace, with existing role and
  member grants migrated to the normalized keys;
- reconciliation exceptions have a builder workspace, and payment-control, reversal,
  stale-release, and reconciliation incidents have owned, transition-deduplicated
  notification routes;
- SQL behavioral tests exercise run creation, settlement, reversal, manual payment,
  credit application, idempotency, draft rejection, unsupported payment methods,
  and removal of stale identity/payment fields against a from-zero migrated schema;
- stale vendor password/authentication fields and the always-empty allocation snapshot
  are removed, while database constraints make the initial rail explicitly one
  verified primary-vendor ACH destination per payable.

The first release supports one primary-vendor ACH payee per payable. Joint-payee and
external-check fields were removed from public input because no complete controlled
workflow exists for them; they are not launch claims.

Not enabled or represented as complete:

- live customer movement, live payout-bank edits, Stripe program configuration, fee
  pricing, Florida-generated waiver language, and QA acceptance;
- vendor-identity recovery and vendor-admin step-up, whose authentication/recovery
  channel must be selected before implementation;
- cards and the Column-sponsored Rail v2 programs (FBO balances, direct ACH,
  retainage escrow, and early pay), which remain separately gated.

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
6. Arc Books projects from the `payments` and `payment_reversals` fact rows written
   once by the atomic settlement and reversal RPCs. The rail subledger never feeds
   the Books projector, and mutable payment status is not its source of truth.

The payable enters this control system through one creation workspace: invoice and
supporting document on one side; invoice facts, construction coding, payment terms,
retainage, discount, and lien-waiver intent on the other. A review-ready create may
carry all of that context into approval. A quick draft is deliberately not eligible
for approval, payment-run selection, or automatic approval until a person completes
it. Vision and AI suggestions accelerate preparation but never release money or
bypass the existing hold and approval gates.

This creates a defensible system of control and record around the moment money moves.
Cards, early pay, capital referrals, and account-based treasury services are possible
expansions, but they must follow a reliable AP rail rather than compete with it for
initial focus. Early pay and escrow belong to Rail v2; they are not features of the
Stripe pilot rail.

### What Arc is and is not

Arc is the workflow, control, orchestration, and evidence layer. A regulated partner
is the payment rail.

**Rail v1** is the implemented Stripe separate-charges-and-transfers model. It is a
controlled pilot rail for proving payment operations, reconciliation, loss controls,
and customer demand. It does not use an Arc-owned bank account or FBO ledger, but it
must not be described as a flow in which Arc never holds funds: after the builder's
ACH debit clears and before the delayed vendor transfer, those funds sit on Arc's
Stripe platform balance. The platform payout schedule must remain manual and the
reserve/balance sweep policy must be approved under the WS-B5 launch gate so the
hold window cannot be bypassed by an automatic platform payout.

**Rail v2** is the confirmed strategic direction: pursue sponsorship with Column
N.A. for FBO accounts, direct ACH origination, and provider book transfers. It is a
future regulated program, not an assertion that Arc already has sponsor approval or
may offer stored balances. Retainage escrow and early pay are Rail v2 programs and
remain unavailable on Rail v1.

That architecture reduces regulatory scope; it does **not** justify claims that Arc
has no payment, return, fraud, dispute, reserve, credit, or licensing exposure.
Destination-charge and ACH-return allocation depends on the final provider contract
and account configuration. Marketing and contracts must describe the approved model,
not an architectural aspiration.

**STOP — Rail v1 provider and legal approval (owners: Head of Payments, General
Counsel, Controller, and Risk owner):** No customer money may move until Stripe,
payments counsel, finance, and risk approve the exact flow of funds, Connect
controller properties, platform-balance hold, payout schedule, return allocation,
reserves, disclosures, and prohibited use cases.

---

## 2. Decisions already approved

These decisions are settled for the foundation and should not be silently changed:

- **Two-rail sequence:** Stripe separate charges and delayed transfers are Rail v1,
  used for the controlled pilot and a measurable controls track record. Column bank
  sponsorship is Rail v2, pursued only through the approval gates in phases 7–9.
- **Rail v1 flow of funds:** the builder debit and vendor transfer are separate
  provider operations. Cleared funds remain on Arc's Stripe platform balance during
  the approved return-risk hold; the platform payout schedule is manual and governed
  by the documented reserve/balance policy.
- **Rail v2 direction:** pursue Column sponsorship for FBO accounts, direct ACH
  origination, and book transfers. This direction does not pre-approve the program,
  its compliance allocation, or any customer launch.
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
- **Provider-neutral core:** payment runs, approvals, controls, holds, relationships,
  provider events, ledger, fees, and reconciliation are Arc concepts. Stripe and
  Column IDs are opaque adapter references.
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
- **Go-live sequence:** provider-neutral foundation first; Stripe test mode for the QA
  org, then a gated Rail v1 pilot. Rail v2 cannot inherit Rail v1 approval: the bank
  program, compliance allocation, operations, and reconciliation gates are separate.

### One decision intentionally deferred

Before live payout-bank changes, choose the second-reviewer operating model:

- a second administrator of the same vendor entity, or
- an Arc payments-operations reviewer under a documented verification playbook.

The schema supports either. Engineering must not choose between them implicitly.

**STOP — bank-change operating model (owners: Head of Payments Operations and
Security owner):** No live payout-destination edit can be enabled until those owners
select the reviewer model and document recovery, escalation, and fraud-loss
ownership.

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

The next adapter revision is a design contract only; do not change the implemented
Rail v1 interface until a Column integration is approved and both adapters can be
tested against the same conformance suite. The domain boundary is organized around
these provider-neutral nouns:

- **counterparty:** a builder, vendor, or other legal party known to a rail;
- **verification status:** Arc's normalized view of a counterparty's eligibility and
  outstanding requirements;
- **funding debit:** an instruction to pull money from a builder into the rail;
- **credit:** an instruction that makes funds available to a vendor or other
  counterparty;
- **book transfer:** movement between accounts on the same rail without pretending it
  is an external ACH;
- **return event:** a normalized reversal or return tied to the original movement.

The provider-neutral contract should read conceptually as:

```ts
interface PaymentRailProvider {
  registerCounterparty(input: CounterpartyInput): Promise<CounterpartyReference>
  getVerificationStatus(input: CounterpartyReference): Promise<VerificationStatus>
  originateFundingDebit(input: FundingDebitInput): Promise<FundingDebit>
  creditCounterparty(input: CreditInput): Promise<Credit>
  createBookTransfer(input: BookTransferInput): Promise<BookTransfer>
  normalizeReturnEvent(input: RawProviderEvent): Promise<ReturnEvent | null>
  fetchReconciliation(input: ReconciliationInput): Promise<RailActivity[]>
}
```

Stripe-shaped mechanics stay adapter-private: SetupIntent client secrets, hosted
Connect onboarding links, PaymentIntents, Transfers, Payouts, connected accounts,
customers, payment methods, and mandates. A Stripe adapter maps those objects onto
the nouns above. A Column adapter may instead use entities, deposit/FBO accounts, ACH
originations, and book transfers; those shapes also stay private. Neither vocabulary
becomes a payment-run state or database-wide service contract.

The layers that carry from Rail v1 to Rail v2 unchanged are payment runs, immutable
approval evidence, maker/checker policy, exposure limits, holds, builder/vendor
relationships, the provider-event inbox, the balanced payment ledger,
reconciliation findings, accounting sync, audit history, and operations ownership.
The layers Rail v2 replaces are Stripe Express vendor KYC/KYB, Stripe-hosted builder
bank collection, Stripe customer/payment-method/mandate references, PaymentIntent
funding debits, Connect transfers/payouts, and Stripe platform-balance release
controls. Replacement happens behind the adapter; it does not create a second run,
approval, ledger, or reconciliation model.

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

**STOP — Florida legal approval (owner: General Counsel):** Before generating
customer-facing waiver language, Florida construction counsel must approve templates,
timing, electronic-signature language, retention, and the exact relationship between
payment confirmation and an unconditional waiver; the General Counsel records the
enabled scope. The product may collect uploaded waivers before approval, but must not
represent generated language as legally sufficient.

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

Create one extensible fee engine for AR ACH, AR card, and AP disbursement. Card
interchange and early-pay spread may join it only when their separately gated programs
exist; early-pay pricing is Rail v2-only. Migrate existing AR gross-up math without
changing current customer quotes. Delete the existing dead fee helper only after
call-site coverage proves it is unused.

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

**STOP — Stripe program configuration (owners: Head of Payments and Risk owner):**
Those owners must confirm with Stripe the exact supported Connect account controller
configuration, platform liability, ACH debit flow, transfers, payouts, webhook
routing, reserves, and pricing in writing. Do not reuse an unsupported controller
combination from an older draft.

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
- partial payment and retainage;
- duplicate webhooks and out-of-order events;
- ACH failure before settlement;
- return/reversal after apparent success;
- bank-change cooling period and notifications;
- reconciliation balanced and exception cases;
- least-privilege/RLS isolation.

**STOP — customer enablement (owner: Head of Payments Operations):** The owner reviews
QA evidence, provider/legal approvals, incident runbooks, the Controller's
reconciliation ownership, support procedures, and feature-flag scope before any
customer org is enabled.

### Phase 5 — Florida waiver automation

After Florida legal approval, add versioned templates and the conditional → payment
confirmed → unconditional workflow. Do not silently expand to another state.

### Phase 6 — Rail v1 pilot and controls track record

Operate Stripe separate charges and delayed transfers only for the approved pilot
cohort. Keep the platform payout schedule manual, enforce the payout hold, and measure
daily reconciliation, returns, payout failures, open exceptions, operational touches,
support load, loss exposure, and vendor receipt timing. Rail v1's purpose is to prove
the control system and operating model; it does not promise balances, escrow, direct
ACH origination, or early pay.

**STOP — Rail v1 pilot enablement (owner: Head of Payments Operations):** The owner
may enable a pilot org only after the provider, legal, risk/reserve, operations, and
production-QA launch attestations are current and the approved customer limits are
finite. The Controller owns daily reconciliation sign-off during the pilot.

### Phase 7 — Column sponsorship and program allocation

Pursue a sponsored banking program with Column N.A. Define the exact FBO account
structure, direct ACH flow, book transfers, return handling, safeguarding, customer
agreements, funds availability, statements, complaints, and permissible use cases.
Rail v1 evidence informs this review but does not satisfy it.

**STOP — bank partner approval (owners: Bank Partnerships lead and Head of
Payments):** Do not build against or market the sponsored program until Column has
approved the written program, flow of funds, account structure, transaction types,
limits, reserves, and launch stages.

**STOP — BSA/AML program (owner: designated BSA/AML Compliance Officer):** Do not
onboard a Rail v2 customer until the officer and Column approve the risk assessment,
CIP/CDD, sanctions, transaction monitoring, case escalation, SAR responsibility,
record retention, testing, and training allocation.

**STOP — KYB/KYC ownership (owners: Compliance Officer and Head of Payments
Operations):** Do not replace Stripe Express onboarding until Column and Arc document
which party collects, verifies, refreshes, restricts, and supports every builder,
vendor, beneficial owner, and controlling person.

**STOP — state money-transmission analysis (owner: General Counsel):** Do not offer
Rail v2 in a state until payments counsel records the money-transmission, stored-value,
escrow/trust, unclaimed-property, and construction-funds conclusions for that state
and the General Counsel approves the enabled-jurisdiction list.

### Phase 8 — Rail v2 FBO, direct ACH, and bank-ledger operations

Implement the Column adapter behind the provider-neutral contract. Add sponsored FBO
accounts, direct ACH origination, provider book transfers, normalized returns,
provider balance/activity ingestion, statements, and bank-to-Arc ledger tie-outs.
Reuse the Rail v1 runs, approvals, holds, relationships, ledger, reconciliation,
accounting sync, and operations surfaces; replace only the provider-private
verification, bank collection, debit, credit, transfer, and payout mechanics.

**STOP — daily bank-ledger reconciliation (owners: Controller and Head of Payments
Operations):** Do not move customer funds until named operators own a seven-day
calendar, evidence retention, exception SLA, bank escalation path, customer-impact
communications, and an independently reviewed daily tie-out from Column balances and
transactions to Arc's subledger and FBO customer positions.

**STOP — dual-control operations (owners: Head of Payments Operations and Security
owner):** No production operator may unilaterally create or alter counterparties,
bank accounts, limits, release holds, book transfers, returns, or reconciliation
adjustments. Production access, break-glass use, and every manual money action require
documented maker/checker controls and audit review.

### Phase 9 — Rail v2 programs and adjacent products

Retainage escrow and early pay are Rail v2 programs, not Rail v1 feature flags.
Retainage escrow requires approved legal trust/escrow treatment, project-level
beneficial ownership, release authority, statements, escheatment, and reconciliation.
Early pay requires an approved capital source, underwriting and adverse-action model,
pricing/disclosures, true-sale or credit characterization, loss ownership, accounting,
tax treatment, and customer consent. Arc does not lend from its balance sheet unless
the board separately approves that regulated risk.

Existing-card ingestion, Arc cards, and capital referrals remain optional adjacent
programs. They may reuse coding and ledger infrastructure but do not inherit Rail v2
approval. Card issuing requires issuer approval and a specific funding, fraud,
dispute, cardholder-verification, authorization, and loss model.

**STOP — escrow and early pay (owners: General Counsel, Controller, Risk owner, and
Head of Payments):** Do not market, contract, or enable either program until its bank
partner, legal, compliance, accounting/tax, funding, credit-loss, operations, and
customer-disclosure package is approved in writing.

**STOP — cards (owners: Head of Payments, Risk owner, and issuer-program owner):** Do
not build or promise live issuing until those owners approve the program partner and
commercial/risk model. Never assume Arc may fund a shared balance or front customer
spend.

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

Rail v1 production pilot enablement requires all of the following:

- provider and payments-counsel sign-off;
- written confirmation that the Stripe platform payout schedule is manual, with an
  approved reserve/platform-balance sweep policy for the hold window;
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

Rail v2 has a separate readiness decision. It cannot be enabled merely because Rail
v1 is healthy. Before any sponsored FBO account or direct ACH transaction is offered,
all of the following must be approved and evidenced:

- Column bank-partner approval for the exact program and flow of funds;
- the designated BSA/AML Compliance Officer's approved program and responsibility
  matrix with Column;
- explicit builder/vendor/beneficial-owner KYB/KYC ownership and support procedures;
- General Counsel's state-by-state money-transmission, stored-value, escrow/trust,
  construction-funds, and unclaimed-property analysis;
- Controller-owned daily reconciliation from Column activity through Arc's subledger
  to every customer FBO position, with staffed exception SLAs;
- production dual control for onboarding, account changes, limits, releases, book
  transfers, returns, reconciliation adjustments, and break-glass access;
- customer agreements, disclosures, statements, complaints, funds-availability,
  privacy, security, incident, and regulatory-reporting operations;
- a Rail v2 adapter conformance suite proving that provider replacement did not fork
  runs, approvals, holds, ledger, accounting, or reconciliation semantics.

Escrow and early pay each require their Phase 9 approval package after Rail v2 itself
is ready. Neither may appear in Rail v1 sales claims, configuration, or launch
checklists.

The launch metric is not payment volume alone. For both rails track activation,
percent of eligible bills paid through Arc, time from approval to vendor receipt,
return/failure rate, manual exception rate, reconciliation breaks, support contacts,
fraud loss, gross margin, and vendor onboarding reuse across builders. For Rail v2
also track unmatched bank activity, FBO position breaks, monitoring alerts, manual
money operations, complaints, and time-to-close for compliance and reconciliation
cases.

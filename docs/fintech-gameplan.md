# Fintech Gameplan — Arc's Money Layer

**Status:** Awaiting execution. Written 2026-07-31.
**Audience:** an LLM executor. Follow the directives literally. Where this doc says
STOP, stop and ask the human. Do not improvise around a STOP.
**Companions:** `docs/arc-books-gameplan.md` (ledger of record — reads this doc's
outputs), `docs/procore-parity-gameplan.md` (WS-02 payment holds — already shipped,
this doc builds on it), `docs/tech-frontier-gameplan.md` WS-F4 (virtual cards — this
doc SUPERSEDES and expands F4; when you build cards, follow THIS doc).

---

## 0. Strategy in three paragraphs (read before any code)

Arc adopts the Ramp playbook translated to construction. Ramp's theses: give software
away, monetize money movement (interchange + float); enforce policy at the moment money
moves, not in a report afterward; make bookkeeping disappear; land with one money
product, expand to the whole finance office. The translation: construction spend is
85–95% commitments (contract-bound, waiver-gated, paid against pay apps) — so cards can
only capture the tail (field spend, materials runs). **Arc's "card swipe" is the bill
release and the draw.** Arc already enforces policy at that moment (payment holds,
shipped July 2026). This plan adds: (A) the outbound payment rail so subs get paid
*through* Arc, (B) fee revenue on money movement, (C) virtual/physical cards for the
spend tail, (D) early-pay discounting, (E) the underwriting data feed that powers
partner capital products, (F) treasury/float as a later horizon.

Flow-of-funds doctrine (**Model A — never deviate without a STOP**): money always moves
between the builder's own bank account and the counterparty's own bank account, through
Stripe's regulated infrastructure. Arc orchestrates and records; Arc never holds funds,
never owns an FBO account, never takes credit risk. This keeps Arc out of
money-transmitter licensing. Any design that parks money in an Arc-owned account is a
STOP.

Revenue model this plan implements: per-transaction fees on AP disbursements (flat,
cheap, visible), the existing AR processing-fee gross-up (already live), card
interchange (Stripe Issuing revenue share), and early-pay discount spread. Referral
fees on partner capital products ride the underwriting feed but the partnerships
themselves are human-led — this plan only builds the data product.

---

## 1. Ground truth — what exists today (verified 2026-07-31)

The executor MUST read these files before writing code. Facts you can rely on:

- **Stripe client:** `lib/integrations/payments/stripe.ts`. Singleton `getStripe()`
  reads `STRIPE_SECRET_KEY`, API version pinned `2025-02-24.acacia`. Payment Intents
  with `payment_method_types: ["us_bank_account", "card"]` (ACH first-class, instant
  verification via Financial Connections). Connect accounts created with a
  **controller object** (`fees.payer: "account"`, `losses.payments: "stripe"`,
  `requirement_collection: "stripe"`, full Stripe dashboard), capabilities
  `card_payments` + `transfers`. Charges are **direct on the connected account**
  (`{ stripeAccount }`, `charge_type: "direct"`).
- **Connected accounts:** `lib/services/stripe-connected-accounts.ts`; table
  `stripe_connected_accounts` (one per org, `org_id` unique). Today only ORGS have
  connected accounts (receivables). Vendors/subs have nothing.
- **Webhooks:** `app/api/webhooks/stripe/route.ts`; verifies against
  `STRIPE_WEBHOOK_SECRET` + `STRIPE_CONNECT_WEBHOOK_SECRET`; idempotency via
  `webhook_events` table; handles payment_intent.succeeded/failed, charge.succeeded
  (backfills real fees from expanded balance_transaction), refunds, disputes,
  account.updated, subscription events.
- **Fees today:** `lib/payments/fees.ts` — org policy in
  `org_settings.settings.payment_fee_policy`; ACH 0.8% capped $5, card 2.9%+$0.30;
  gross-up math (`grossedUpTotal = ceil((balance + fixed) / (1 - rate))`); applied ONLY
  on the public invoice portal (`createPublicInvoicePaymentIntent` in
  `lib/services/payments.ts:685`). **`calculateFees` in
  `lib/integrations/payments/stripe.ts:411` is dead code with zero call sites** — a
  platform-fee stub that was never wired. Every `payment_intents` insert writes
  `application_fee_amount: 0`.
- **AP mark-paid:** `updateVendorBillStatus` in `lib/services/vendor-bills.ts:635` —
  permission `payment.release`, then `evaluateHolds(billId, orgId)` (THROWS if not
  releasable), then sub-tier waiver gate, then compliance rules, then inserts a manual
  `payments` row (`provider: "manual"`, `method: "check"` default). **There is no
  electronic AP rail today — no `transfers.create`, no `payouts.create` anywhere.**
- **Payment holds (shipped):** `lib/services/payment-holds.ts` — pure
  `evaluatePaymentHoldFacts`, `evaluateHolds`, `overridePaymentHold` (permission
  `payments.override_hold`, reason ≥8 chars), `sendVendorBillWaiverChase`. Tables
  `payment_hold_policies` (org + per-project rows, project wins wholesale) and
  `payment_hold_overrides`. Hold kinds: `insurance_current`, `waiver_signed`,
  `compliance_docs_approved` (block); `retainage_rules_met`, `funding_received` (warn).
  `vendor_bills.funding_invoice_id` → pay-when-paid linkage exists at `warn` level.
- **Payments table serves both sides:** `payments` rows carry `invoice_id` (AR) or
  `bill_id` (AP); `provider: "manual" | "stripe"`; fee columns
  (`gross_cents/fee_cents/processor_fee_cents/platform_fee_cents/net_cents`) populated
  from `charge.succeeded`.
- **Sub portal:** `app/s/[token]` with `external-portal-auth`; subs already submit
  invoices, sign waivers (`waivers/[billId]`), see commitments/POs.
- **Outbox:** enqueue pattern per `lib/services/outbox.ts`; drained by
  `app/api/jobs/process-outbox/route.ts`; job type `chase_vendor_bill_waiver` is a good
  reference for a payments-adjacent job.
- **No metering anywhere** (no Stripe billing meters / usage records).

Known gotchas (do not rediscover these the hard way):
- `mapStripeEventToDomain` hardcodes `fee_cents: 0`; real fees arrive only via the
  `charge.succeeded` branch. Any new money flow must replicate that two-step.
- `payment_hold_policies` project row replaces the org row wholesale (no per-key merge).
- Legacy `qbo_*` columns coexist with `accounting_coding` jsonb; never add new `qbo_*`
  columns (CLAUDE.md rule).
- Server actions return `{ success, error }` — thrown errors get redacted in prod.
- Vercel Cron sends GET. Every new cron handler must handle GET.
- New public API routes (webhooks!) must be added to `PUBLIC_API_ROUTES` in `proxy.ts`
  or they 307 to signin.

---

## WS-P1 — Outbound AP rail: pay subs through Arc

### What this is
Today "mark paid" records that a check went out. This workstream makes Arc actually
move the money: builder clicks Pay → their bank account is ACH-debited → funds land in
the sub's own bank account. Stripe is the regulated rail; Arc never holds funds.

### Stripe mechanics (decision already made — implement exactly this)
- **Vendor onboarding:** create a Connect account per paid vendor company —
  `controller: { fees: { payer: "application" }, losses: { payments: "application" },
  requirement_collection: "stripe", stripe_dashboard: { type: "none" } }` with the
  `transfers` capability only. This is the "recipient" configuration: the vendor never
  sees a Stripe dashboard; they just link a bank account through an embedded/hosted
  onboarding flow reached FROM THE SUB PORTAL.
- **Builder debit:** the org adds a funding bank account via Stripe Financial
  Connections (instant verification — the same mechanism buyers already use to pay
  invoices). Store as a payment method on an org-level Stripe Customer.
- **Money movement per payment run:** create a PaymentIntent that debits the org's
  bank account (`us_bank_account`, on the PLATFORM account, not the org's connected
  account) with `transfer_data: { destination: <vendor_connect_account> }` and
  `transfer_group` per payment batch. Stripe handles debit → settle → transfer →
  payout to the vendor's bank. ACH debit settlement is 1–4 business days; the vendor
  payout releases after settlement. Surface this timing honestly in the UI
  ("arrives in 2–4 business days").
- **Fees:** set `application_fee_amount` OR use a separate fee mechanism — for
  destination charges use `application_fee_amount` on the PaymentIntent. Fee policy in
  §WS-P2.
- STOP conditions: if Stripe account review requires a platform-profile change, or if
  the `losses.payments: "application"` configuration is rejected for this use case,
  stop and surface to the human — this is a Stripe program-approval conversation, not
  a code problem.

### Schema (one migration; write to `supabase/migrations/`, then STOP for approval)
```sql
-- vendor payout accounts: one per company per org
create table public.vendor_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  stripe_account_id text not null unique,
  status text not null default 'onboarding'
    check (status in ('onboarding','ready','disabled')),
  payouts_enabled boolean not null default false,
  requirements_currently_due jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, company_id)
);

-- org funding sources (the builder's own bank account, tokenized at Stripe)
create table public.org_funding_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_payment_method_id text not null,
  bank_name text,
  last4 text,
  status text not null default 'active' check (status in ('active','disabled')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- disbursements: one row per outbound payment attempt (the AP mirror of payment_intents)
create table public.disbursements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  bill_id uuid not null references public.vendor_bills(id) on delete restrict,
  vendor_payout_account_id uuid not null references public.vendor_payout_accounts(id),
  funding_source_id uuid not null references public.org_funding_sources(id),
  amount_cents bigint not null check (amount_cents > 0),
  fee_cents bigint not null default 0,
  currency text not null default 'usd',
  status text not null default 'created' check (status in
    ('created','debiting','settling','transferred','paid_out','failed','returned','canceled')),
  provider_intent_id text unique,
  provider_transfer_id text,
  failure_reason text,
  initiated_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index disbursements_org_project_idx on public.disbursements (org_id, project_id);
create index disbursements_bill_idx on public.disbursements (bill_id);
```
RLS: copy the policy shape from `payment_hold_overrides` (same migration family, recent
neighbor), org-scoped, `(select auth.uid())` everywhere. `updated_at` triggers on all
three tables. RBAC: reuse `payment.release` for initiating; add `payments.manage_rail`
(funding sources + vendor account admin) seeded to admin + bookkeeper via the
catalog-as-code migration pattern.

### Service plan
Create `lib/services/disbursements.ts` (mirror the service exemplar shape —
`requireOrgContext` → `requirePermission` → logic → `recordEvent` + `recordAudit` →
DTO):
- `createVendorPayoutOnboarding(companyId)` — creates/fetches Connect account, returns
  hosted onboarding URL. Called from a new sub-portal section ("Get paid by direct
  deposit") — extend `app/s/[token]` with a `payments` page; token capability via
  `portal-links`.
- `addOrgFundingSource()` — SetupIntent flow (Financial Connections) from
  `/settings?tab=invoicing` area (Payments settings live with the money settings; do
  NOT create a new top-level settings page — add a "Payments" group).
- `initiateDisbursement({ billId, fundingSourceId })` — MUST call the exact same gate
  chain as `updateVendorBillStatus`: `payment.release` permission, `evaluateHolds`
  (throw if not releasable), sub-tier waiver gate, compliance rules. Extract that gate
  chain from `updateVendorBillStatus` into a shared
  `assertBillReleasable(billId, orgId)` in `lib/services/payment-holds.ts` and call it
  from BOTH paths — do not copy-paste the checks (they will drift).
  Then: create the PaymentIntent (idempotency key = disbursement id), insert the
  `disbursements` row (`status: 'debiting'`), do NOT touch the bill status yet.
- Webhook extensions in `app/api/webhooks/stripe/route.ts`: on
  `payment_intent.succeeded` for a disbursement intent → `status: 'settling'`; on
  `transfer.created` → `'transferred'`; on the destination `payout.paid` (Connect
  event) → `'paid_out'` AND ONLY THEN insert the `payments` row
  (`provider: 'stripe'`, `method: 'ach'`, `bill_id`) and advance the bill via the
  existing paid/partial math in `updateVendorBillStatus` (refactor: extract the
  "record payment + recompute status" block into `applyBillPayment(...)` used by both
  the manual path and the webhook). On `payment_intent.payment_failed` or ACH return
  (R01 etc. arrive as `charge.failed`/dispute-like events) → `'failed'`/`'returned'`,
  notify initiator (email type must be added to `EMAIL_NOTIFICATION_TYPES`).
- Statuses must be monotonic; write a small state machine guard
  (`assertDisbursementTransition(from, to)`) with unit tests.

### UI plan
- Payables workbench + `/payables` desk: bills that are releasable AND have a ready
  vendor payout account show a **Pay by ACH** primary action next to the existing
  manual mark-paid (which stays, relabeled "Record external payment"). Bills paying
  electronically show a status chip (Debiting → In transit → Paid) driven by
  `disbursements.status`.
- Vendor detail sheet (companies): payout account status + "invite to direct deposit"
  (sends portal link — email type registration required).
- Empty/loading/error/dark on every new surface; money in `tabular-nums`.

### Phases
1. Migration + vendor onboarding via portal + org funding source setup. (No money
   moves yet.) STOP after migration is written.
2. `initiateDisbursement` + webhook lifecycle + bill status integration, behind a
   platform feature flag (`feature-flags` service), enabled only for the QA org.
   Test end-to-end in Stripe test mode. STOP before enabling for any customer org.
3. Batch payment run UX on `/payables` (select N releasable bills → one confirm →
   N disbursements with one `transfer_group`).

### Acceptance
- A held bill can NEVER create a disbursement (unit + integration test on
  `assertBillReleasable`).
- Webhook replay-safe: reprocessing any event is a no-op (dedupe on
  `webhook_events.provider_event_id` — already exists; extend coverage).
- ACH return after payout reverses cleanly: bill returns to `approved`, `payments` row
  reversed via the existing `recordPaymentReversal` machinery, humans notified.
- `pnpm lint && npx tsc --noEmit` clean; `pnpm test:financials` extended and passing.

---

## WS-P2 — Fee engine: monetize the movement

### What this is
One coherent fee layer replacing today's single-purpose gross-up, covering: AR
processing fees (exists), AP disbursement fees (new), card interchange bookkeeping
(WS-P3), and early-pay spread (WS-P4). Revenue must be *visible to Arc* (platform
scorecard) and *predictable to the builder* (published, flat, no surprises).

### Directives
1. **Delete the dead code:** `calculateFees` in `lib/integrations/payments/stripe.ts`
   has zero call sites. Remove it in the first PR of this workstream (leave-no-trash).
2. Create `lib/payments/fee-engine.ts` as the single choke point:
   `quoteFee(kind, amountCents, orgPolicy) -> { feeCents, payer, description }` where
   `kind ∈ 'ar_ach' | 'ar_card' | 'ap_disbursement' | 'early_pay_spread'`.
   Move the existing gross-up math here; `lib/payments/fees.ts` becomes a thin re-export
   during migration, then delete it and update the two call sites
   (`app/i/[token]/page.tsx`, `createPublicInvoicePaymentIntent`).
3. **AP disbursement fee:** flat per-payment (default $1.50, org-configurable range
   $0–$5 by platform admin only — this is a platform revenue lever, not an org
   setting). Charged to the ORG (payer of record), implemented as
   `application_fee_amount` on the disbursement PaymentIntent. Show it on the pay
   confirmation ("$1.50 processing").
4. **Fee ledger:** platform-side revenue visibility. New table `platform_fee_events`
   (org_id, kind, source_type/source_id, fee_cents, provider ref, created_at) written
   by the webhook fee-backfill branch (the `charge.succeeded` handler already extracts
   `application_fee_amount` — extend it to insert here). Surface: a new band on
   `/admin/analytics` (platform staff only) — monthly fee revenue by kind by org.
5. Do NOT invent per-org negotiated pricing tables yet. One default + platform-admin
   override per org (a `fee_policy` jsonb on the org's platform record) is enough.

### Acceptance
Every dollar of fee revenue appears exactly once in `platform_fee_events`, reconciles
against Stripe's application fee reporting (manual spot-check note in PR), and the
public invoice portal quotes are byte-identical to today's for unchanged policies
(regression fixture).

---

## WS-P3 — Cards: Stripe Issuing with budget-line authorization

### What this is
Virtual (and later physical) cards scoped to a project, commitment, or budget line.
The authorization webhook approves/declines each swipe in real time against the
remaining budget. Approved swipes auto-create coded expenses. Interchange revenue
accrues to Arc via Stripe Issuing revenue share. This SUPERSEDES tech-frontier WS-F4 —
build from this spec.

### Pre-work (human, not executor)
Stripe Issuing requires program approval. STOP at the start of this workstream: the
human must enable Issuing on the platform account and accept Stripe's Issuing terms.
The executor may build everything in test mode meanwhile.

### Mechanics (implement exactly)
- Cardholders: `Issuing.Cardholder` per team member (name, billing address = org
  address). Cards: `Issuing.Card` virtual, linked to cardholder, spending controls set
  to a generous ceiling (real control lives in OUR webhook, not Stripe's static
  controls — but set `spending_controls.spending_limits` as a backstop at 2× the scope
  limit).
- **Funding:** Issuing balance is prepaid from the org's funding source
  (`org_funding_sources` from WS-P1). Auto-top-up rule: when balance < 20% of
  outstanding card limits, debit the default funding source. STOP: confirm with the
  human whether orgs share one platform Issuing balance (simpler, Arc fronts float —
  NO, violates doctrine) or per-org Connected-account Issuing (each org's own balance
  — YES, this is the Model-A-compliant shape; cards are issued on the org's connected
  account). Default to per-org connected-account Issuing.
- **Authorization webhook:** `issuing_authorization.request` arrives with ~2s budget.
  Handler must be FAST: single indexed lookup of the card's scope → remaining =
  scope_limit − (posted job costs + pending card auths for that scope) → approve if
  `amount <= remaining`, else decline with reason. Precompute "remaining" into a
  `spend_card_state` row updated on every auth/expense event so the webhook does one
  point read (no aggregate query in the hot path). Respond via
  `approve()`/`decline()` API within the window. Log every decision to
  `card_authorization_events`.
- **Expense creation:** on `issuing_authorization.updated` (captured) /
  `issuing_transaction.created` → create a `project_expenses` row through the EXISTING
  expenses service (do not write raw rows), status `pending_receipt`, coded to the
  card's scope (project + cost_code/budget_line). Push APNs (via `lib/services/apns.ts`)
  to the cardholder: "Snap the receipt for $214.85 at HD Supply" → deep link to the
  mobile `expenses/scan` OCR flow (exists). Unmatched receipts age into the financials
  review queue after 5 days.
- Declines push an APNs with the reason ("Budget line Framing Materials has $180
  remaining").

### Schema sketch (one migration, then STOP)
`spend_cards` (org_id, cardholder app_user, scope kind/ref, limit_cents, period,
stripe ids, status), `spend_card_state` (card_id pk, reserved_cents, spent_cents,
updated_at), `card_authorization_events` (auth id, card_id, amount_cents, decision,
reason, latency_ms). RLS org-scoped; permissions: `cards.manage` (admin/bookkeeper),
`cards.use` (cardholder sees own card + transactions).

### UI
Settings → Payments group: card program enrollment, card list, issue-card dialog
(member, scope picker reusing the budget-line picker from expenses, limit, period).
Project financials: a "Card spend" filter on expenses (it's just expenses with
`metadata.source = 'card'` — no parallel list). Mobile: card detail (number reveal via
Stripe's ephemeral-key flow — PAN never touches Arc's servers), transaction feed,
receipt chase.

### Hard rules
- PAN/CVV never stored, logged, or proxied — use Stripe's issuing-elements/ephemeral
  key mechanism only. Any code path that would touch raw card numbers is a STOP.
- The authorization webhook must have a fail-safe: on any internal error, DECLINE (fail
  closed) and alert. Money leaks are worse than a super's declined swipe.
- Webhook p99 decision latency < 800ms; add a `latency_ms` column and an `/admin/ops`
  stat.

### Phases
1. Test-mode: schema, issuance, auth webhook with scope math, expense creation.
2. QA-org live pilot (one card, platform staff). STOP before customer rollout.
3. Receipt-chase loop + review-queue aging + decline UX polish.
4. Physical cards + Apple Wallet provisioning (later; needs no new architecture).

---

## WS-P4 — Early-pay discounting (builder-funded first)

### What this is
A sub with an approved bill sitting on net-30 terms opts to be paid today at a small
discount (e.g., 1.5%). Phase 1 is funded by the builder's own cash: the builder earns
the discount as yield on money they'd pay anyway; the sub gets liquidity; Arc takes a
slice of the spread. No third-party capital, no credit risk, Model A intact.

### Mechanics
- Eligibility: bill `approved`, releasable per `assertBillReleasable`, vendor payout
  account ready (WS-P1), org has early-pay enabled with a funded cap
  (`early_pay_policy` on org settings: enabled, discount_bps default 150,
  arc_share_bps default 30, monthly_cap_cents).
- Offer surface: **sub portal** bill row shows "Get paid today — $X instead of $Y on
  <due date>". Accepting creates an `early_pay_agreements` row (bill_id, original
  amount, discount_cents, arc_fee_cents, accepted_at, portal actor) and immediately
  initiates a WS-P1 disbursement for `amount − discount`.
- Accounting: the discount is income to the builder. Book it as a credit against the
  bill (bill considered paid in full at `amount`; `payments` row for `amount −
  discount`; a `job_cost_entries` adjustment or a dedicated discount line — DECISION:
  book as negative expense adjustment via a `manual_adjustment` job-cost entry with
  metadata `{ source: 'early_pay_discount' }`; do NOT invent a new ledger concept).
  Arc's share is an `application_fee_amount` on the disbursement (flows through
  WS-P2's `platform_fee_events`).
- Builder control: `/payables` desk gets an "Early pay" band — pending offers, accepted
  agreements, yield-to-date this quarter. Org setting to auto-approve offers under a
  threshold vs. require per-offer approval (default: require approval).

### Phase 2 (design only, do not build): third-party capital funds the early payment
via the underwriting feed (WS-P5); builder pays the funder at due date. This changes
the flow of funds and requires human-led partner + legal work. STOP boundary.

### Acceptance
Spread math property-tested (discount + arc fee + net payout ≡ original amount, all
integer cents, no rounding leaks); sub-side offer only renders when truly releasable;
`pnpm test:financials` extended.

---

## WS-P5 — The underwriting feed (data product, no lending)

### What this is
A consented, org-scoped, point-in-time data package that any capital/insurance partner
can consume: schedule velocity, draw history, AR/AP aging, payment lags, concentration,
compliance posture, WIP position. Arc builds the feed once; draw advances, materials
financing, sub factoring, bonding, and insurance pricing are all downstream consumers
negotiated by humans.

### Directives
- `lib/services/underwriting-feed.ts`: `buildUnderwritingPackage(orgId, options)`
  composing EXISTING report services (do not re-derive): WIP (`reports/wip-over-under`),
  AR/AP aging (`reports/aging`), draw status (`reports/draw-status`), payments ledger,
  cycle-time (production), plus derived metrics: median owner-payment lag (invoice
  sent→paid from `payments`), bill-payment lag, % draws funded on time, change-order
  frequency, compliance-current % of active vendors. Output: one versioned JSON
  document (schema version field from day one) + a generated PDF summary (existing PDF
  stack).
- Consent + delivery: org admin explicitly shares a package from a new
  Settings → Payments → "Financial data sharing" panel — generates a time-boxed signed
  URL (reuse `file-share-links` machinery) OR (later) a scoped MCP/API token. Every
  generation and access recorded (`recordAudit` + `file_access_events`). NEVER an
  always-on firehose in v1 — point-in-time packages only.
- No scores in v1. Report facts; let partners model. (An "Arc score" is a product
  decision with adverse-action implications — STOP if asked to build one.)

### Acceptance
Package generates in <30s for a 200-project org; numbers tie to the corresponding
in-app reports exactly (same service calls, same day); share links expire and revoke.

---

## WS-P6 — Treasury horizon (design notes only — DO NOT BUILD)

Recorded so the endgame stays coherent; every item here is a human-led, regulated
decision:
- Retainage in interest-bearing escrow (partner bank; state rules vary; float share).
- Buyer deposit/earnest-money trust accounts (state-mandated in several states).
- Org idle-cash sweep (Stripe Treasury or partner).
- FBO instant-disbursement rail (only if WS-P1's 2–4 day timing proves to be a real
  deal-loser at volume; it is a different regulatory business).
Any executor asked to implement anything in WS-P6: STOP.

---

## Sequencing & dependencies

| Order | WS | Depends on | Gate |
|---|---|---|---|
| 1 | P2 phases 1–2 (fee engine consolidation) | — | none |
| 2 | P1 (AP rail) | P2 | STOP at migration; STOP before customer enable |
| 3 | P4 (early pay, builder-funded) | P1 | none beyond P1's |
| 4 | P3 (cards) | P1 funding sources | STOP for Issuing program approval |
| 5 | P5 (underwriting feed) | — (parallel any time) | none |
| — | P6 | — | permanently gated |

Global definition of done for every WS: `pnpm lint && npx tsc --noEmit` clean,
`pnpm test:financials` green, empty/loading/error/dark verified, org-scoped +
permission-checked + event/audit on every mutation, migration written-not-applied with
an explicit note to the human, and anything obsoleted (starting with `calculateFees`)
deleted in the same change.

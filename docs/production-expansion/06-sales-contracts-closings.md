# Workstream 06 — Sales, Purchase Agreements & Closings

## STATUS — NOT STARTED

> Prereqs: 00 master (read fully — §4 naming collisions, §5.6 purchase-agreement
> decision, §7 repo rules), 01 (communities/phases/lots/takedowns + posture wiring +
> community workbench), 02 (`community_plan_availability` base pricing + lot plan
> pinning), 03 (option catalog, `resolveOptionPricing`, structural scope, the
> structural-lock gate that CALLS this workstream's executed-agreement helper).
> Workstream 08 (accounting seam) is referenced for closing-invoice posting but is
> NOT built here. This doc is self-contained for a fresh executor: every schema and
> service claim below was verified against the repo on 2026-07-17.

## Mission

Production revenue is a **sales pipeline per community ending in a closing**. A
community sells two kinds of units: **specs** (lot + started house, no buyer yet)
and **to-be-builts (TBB)** (buyer picks lot + plan + elevation + options before
start). Either way the commercial event chain is the same:

```
buyer (contact) → lot hold/reservation (+ earnest deposit)
  → configuration (plan × elevation × structural options × design selections)
  → PURCHASE AGREEMENT  (contracts row, contract_type='purchase_agreement', e-signed)
  → change orders post-signing (existing change_orders lifecycle, portal approval)
  → CLOSING             (settlement: ONE closing invoice, deposits applied as credits)
```

Master §5.6 binds hard: purchase agreements are **`contracts` rows** — no new
contract table. Price = community base + lot premium + structural options + design
selections + change orders − incentives. **One closing invoice at settlement** via
the unified invoice engine; **no draws, no SOV, no retainage anywhere in the buyer
flow**. Deposits/earnest money ride the existing invoice + payments rails (verified
below: payments require an invoice — there is no invoice-less payment path, and we
do not build one).

This workstream delivers: (A) the per-community sales pipeline (spec inventory,
reservations, price sheets, incentives, cancellations), (B) purchase agreements
(configuration snapshot, e-sign, structural lock handshake with 03, post-signing
COs), (C) buyer management + the Buyer-portal reshape of `app/p`, (D) closings
(status pipeline, checklist, settlement + the closing invoice, backlog reporting),
and (E) the Sales desk.

**Out of scope — OSC / lead nurture, decided:** online sales counselors, drip
campaigns, and lead scoring stay OUT. Arc already has a lead pipeline —
`prospects` (statuses `new → contacted → qualified → pricing → estimate_sent →
changes_requested → client_approved → executed → won/lost`,
`lib/validation/prospects.ts:3-14`) with contacts, activity, and follow-ups. A
community-interested lead is just a prospect whose `source`/`tags` say so; nothing
about nurture is production-specific, and building a second funnel beside
prospects would violate the duplicate-capability rule. **This workstream starts at
the moment a buyer attaches to a LOT** (hold/reservation). The only bridge built
here is `lot_reservations.prospect_id` (nullable) so a won prospect carries its
history into the reservation. A production-grade OSC/marketing module is a future
product decision, not a gap in this plan. Also out of scope: realtor/co-broker
commission tracking (open question), escrow/title integrations, mortgage/lender
status tracking.

## Current-state audit (code-verified 2026-07-17)

**Lead pipeline & conversions:**
- `lib/services/prospects.ts` (790 lines) is the LIVE pipeline: `prospects` table
  (status enum above, `jobsite_location` jsonb, `won_at/lost_at`, `project_id`
  backlink), `prospect_contacts` join rows (`full_name/email/phone/is_primary/
  promoted_contact_id`), estimate rollups (`estimate_count`,
  `estimate_value_cents`). CRUD + follow-ups + activity feed.
- `lib/services/crm.ts` (750 lines) is a LEGACY overlapping surface: its
  `Prospect extends Contact` reads the `contacts` table, not `prospects`. Do not
  build on it; do not extend it. (Its eventual deletion is not this workstream's
  job — just stay off it.)
- `lib/services/conversions.ts`: `conversion_runs` + step rows give resumable,
  audited multi-entity conversions. `convertExecutedProspectToProject` (L520)
  turns prospect + **executed estimate** into project + `contracts` row (status
  `active`), idempotent via `projects.prospect_id` lookup;
  `runProposalAcceptanceConversion` (L191) drives RPC
  `run_proposal_acceptance_conversion` and requires the proposal be linked to a
  **preconstruction project** — i.e. projects legitimately exist pre-construction
  today. This is the pattern (and precedent) for `executePurchaseAgreement`.
- Estimate acceptance honors optional add-ons: contract total = base + accepted
  options from `estimate.metadata.accepted_options` (conversions.ts:571-580) — the
  same shape of "priced configuration at signing" this doc formalizes in
  `contracts.snapshot`.

**Contracts:**
- `contracts` is rich and REUSED (master §4): columns per the embed in
  `lib/services/projects.ts:180` — `id, org_id, project_id, proposal_id, number,
  title, status, contract_type, total_cents, currency, markup_percent, gmp_cents,
  contingency_cents, fixed_fee_cents, fee_presentation, savings_split_owner_pct,
  savings_split_builder_pct, labor_burden_multiplier, rate_schedule_id,
  requires_client_cost_approval, open_book, retainage_percent,
  retainage_applies_to_fee, retainage_release_trigger, retainage_schedule,
  stored_materials_retainage_percent, terms, effective_date, signed_at,
  signature_data, parent_contract_id, snapshot, created_at, updated_at`.
- `contract_type` values in live use: `"fixed"`, `"time_materials"` (cost-plus
  variants resolve via `snapshot.billing_model` — `lib/financials/billing-model.ts:72-99`).
  `"purchase_agreement"` is unused and ours. `status: "active"` is the executed
  state conversions write. `lib/services/contracts.ts` is a thin reader
  (`getProjectContract`, `listProjectContracts`).
- Billing feature config: `getProjectFinancialFeatureConfig`
  (`lib/financials/billing-model.ts:101`) returns `{ billingModel, landingPage,
  showDraws, ... , ownerBillingBasis }` — workstream 01 already specifies the
  production default (no draws surface, no SOV/pay-apps). This doc adds the
  purchase-agreement resolution rule (below).

**E-sign:**
- `lib/services/envelopes.ts`: `envelopes` ride `documents`
  (`document_id`, `source_entity_type/source_entity_id`, `document_revision`);
  `ensureDraftEnvelopeForDocument` (L35), `replaceEnvelopeRecipients` (L144),
  `createEnvelopeSigningRequests` (L221) → `document_signing_requests` rows with
  signer tokens. Execution callbacks are the established pattern:
  `acceptProposalFromEnvelopeExecution` (`proposals.ts:231`, records
  `source: "envelope_execution"`), `confirmSelectionFromEnvelopeExecution`
  (`selections.ts:133`). Purchase agreements add one more callback, nothing new
  in the e-sign machinery.

**Invoices & payments (the money rails deposits and the closing invoice ride):**
- `lib/services/invoices.ts` (2,420 lines): unified status engine (`draft`,
  `saved`, `sent`, `partial`, `paid`, `overdue`, `void`), atomic create via RPC
  `create_invoice_atomic` (L1222), metadata already carries discounts/per-line
  tax/deposit conventions (deposit = negative line — recurring-composer work,
  July 2026), `metadata.source_change_order_id` / draw links precedent for
  source tagging. Totals math is mirrored in `lib/financials/invoice-totals.ts`
  (`calculateInvoiceTotals`, `deriveRetainageCents`) with financials tests.
- `lib/services/payments.ts` (1,284 lines): `recordPayment` (L779) — permission
  `payment.release`, **requires an invoice** (org+invoice resolved before
  insert), idempotent on `provider_payment_id`, fee metadata
  (`payment_method_total_cents`, `processor_fee_cents`); Stripe intents for
  `card`/`ach` with fee quotes (L260-340); signed pay links
  (`generatePayLink`/`validatePayLinkToken`); reversals
  (`recordPaymentReversal`/`resolvePaymentReversal`); activity feed
  (`getInvoicePaymentActivity` L1116). **Audit conclusion: there is no
  invoice-less payment. Earnest deposits therefore ride a deposit INVOICE on the
  buyer's project — never a new money table, never a payment floating on a
  reservation row.**

**Client portal (`app/p/[token]`) — becomes the Buyer portal:**
- Entry `app/p/[token]/page.tsx` (token → optional account gate → optional PIN →
  `loadClientPortalData`); shell `app/p/[token]/portal-client.tsx` with hardcoded
  tabs: `home`, `roadmap`, `timeline` (labeled "Photos"), `documents`, `invoices`
  (rendered only when `data.invoices.length > 0`), `actions` (pending COs +
  selections, red-dot), `about`. Tab components in `components/portal/tabs/`.
- Data gating is per-capability booleans on `portal_access_tokens`
  (`can_view_schedule`, `can_view_documents`, `can_view_invoices`,
  `can_pay_invoices`, `can_approve_change_orders`, `can_submit_selections`,
  `can_view_warranty`, `can_view_budget`, `can_download_files`, …26 total —
  `lib/services/portal-access.ts:1316-1347`), NOT posture:
  **`ProjectPosture` never touches the portal today.**
- `loadClientPortalData` (`portal-access.ts:772-888`) returns `{ org, project,
  projectManager, schedule, photos, pendingChangeOrders, pendingSelections,
  pendingDecisions, warrantyRequests, invoices, rfis, submittals, recentLogs,
  sharedFiles, punchItems, financialSummary }`. `loadPortalFinancialSummary`
  (L547-657) is draw-oriented (contract total / paid / balance / **next draw**,
  `nextDrawPaymentAvailable`).
- CO approval in-portal is complete: `approveChangeOrderFromPortalSignature`
  (`change-orders.ts:1337`, native signature capture, idempotent, posts financial
  impact) behind `can_approve_change_orders`. Change-order lifecycle:
  `draft|pricing|proposed|approved|rejected|void` (+ legacy `status` dual-write).
- Invoice pay in-portal: `createPublicInvoicePaymentIntent` via
  `app/p/[token]/invoices/[id]/actions.ts:29`.
- Portal invite flow: `sendPortalInviteAction`
  (`app/(app)/contacts/actions.ts:160-227`) — contact → reuse-or-create
  `portal_access_tokens` row (`contact_id`, `portal_type`), email invite.

**Buyer identity:** a project's client is a **contact** — `projects.client_id` →
`contacts` (FK `projects_client_id_fkey`; no `clients` table exists). Contacts
carry `contact_type`, `primary_company_id`, `metadata.has_portal_access`
(`contacts.ts:35-67`). "Buyer" is purely terminology
(`lib/terminology.ts` production row: owner→**Buyer**, ownerPortal→**Buyer
portal**, primeContract→**Purchase agreement**) — no new identity model.

**Closeout pattern (reused for the closing checklist):**
`lib/services/closeout.ts` — `closeout_packages` (per-project, status
`in_progress|complete` auto-rolled-up) + `closeout_items` (`title`, `status
missing|complete`, `file_id`, `due_date`, `responsible_party`, `notes`),
`ensurePackage` seeds default items, attachments via `file_links`
(`entity_type='closeout_item'`). Copy this structure, do not extend it — project
closeout (as-builts, O&M) and buyer closing (blue-tape walk, orientation) are
different lists with different audiences.

**What does NOT exist in code yet (docs 01–03 are unexecuted):** no
`communities`/`lots`/`house_plans`/`selection_catalog_prices` services or tables.
This doc builds against their published contracts:
- 01: `communities` (+`selection_change_fee_cents` added by 03), `community_phases`,
  `lots` (status `controlled|owned|developed|assigned|started|closed`,
  `premium_cents`, `cost_basis_cents`, 0..1 `project_id`, unique partial index
  both ways), `lot_takedowns`, community workbench
  `app/(app)/communities/[id]/` (Lots default tab, `land`, `settings`),
  permissions `community.read/write`, `lot.write`, role `org_land_manager`.
- 02: `community_plan_availability` (`community_id × house_plan_id ×
  elevation_id?`, `base_price_cents`, `is_available`, `effective_start/end`);
  lots pin `house_plan_id/house_plan_version_id/house_plan_elevation_id`.
- 03: `selection_options.option_scope in ('structural','design_studio')`,
  `selection_catalog_prices`, **`resolveOptionPricing(...)` — THE pricing
  contract** (returns `priceCents/costCents/source` per option/package for a
  plan version + community; nobody re-derives precedence), selection snapshots
  stamped at confirm, `assertSelectionMutable` rule 1 calls **this workstream's
  `hasExecutedPurchaseAgreement(projectId)`** for the structural lock,
  `createPostCutoffSelectionChangeOrder` for post-signing selection changes.

## Data model

All money `bigint`/`integer` **cents**. Every table: `org_id` NOT NULL, standard
org-access RLS with `(select auth.uid())` initplan pattern, `updated_at` trigger,
indexes as listed — copy the RLS/trigger block from a recent migration verbatim
(01's instruction; e.g. `20260711120200_prequalification.sql`).

### Migration 1 — `202607DD######_lot_reservations_incentives.sql`

```sql
-- ============ Lot reservations (hold → reserved → converted) ============
create table public.lot_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid not null references public.communities(id),
  lot_id uuid not null references public.lots(id),
  buyer_contact_id uuid not null references public.contacts(id),
  co_buyer_contact_id uuid references public.contacts(id),
  prospect_id uuid references public.prospects(id),   -- lead history bridge, optional
  status text not null default 'hold'
    check (status in ('hold',        -- soft hold, expires, no money
                      'reserved',    -- earnest deposit invoiced/receipted
                      'converted',   -- purchase agreement executed
                      'released',    -- given up / expired / cancelled
                      'expired')),   -- lazily stamped when expires_at passes
  expires_at timestamptz,                              -- required while status='hold'
  asking_price_cents bigint,                           -- price-sheet snapshot at hold time
  deposit_required_cents bigint not null default 0,
  deposit_invoice_id uuid references public.invoices(id),  -- the earnest-deposit invoice
  contract_id uuid references public.contracts(id),        -- set at conversion
  released_reason text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lot_reservations_org_community_idx
  on public.lot_reservations (org_id, community_id, status);
create index lot_reservations_buyer_idx on public.lot_reservations (buyer_contact_id);
-- One live reservation per lot (hold|reserved|converted are "live"):
create unique index lot_reservations_live_lot_uniq on public.lot_reservations (lot_id)
  where status in ('hold','reserved','converted');

-- ============ Incentives (org- or community-level definitions) ============
create table public.incentives (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid references public.communities(id),  -- null = org-wide
  name text not null,                                   -- "July rate buydown", "Design studio credit"
  incentive_type text not null default 'fixed_amount'
    check (incentive_type in ('fixed_amount','percent_of_base')),
  amount_cents bigint,                                  -- required when fixed_amount
  percent numeric(5,2),                                 -- required when percent_of_base
  applies_to text not null default 'price'
    check (applies_to in ('price',           -- reduces agreement total
                          'design_credit')), -- caps out against design selections only
  status text not null default 'active'
    check (status in ('draft','active','ended')),
  effective_start date,
  effective_end date,
  max_uses integer,                                     -- null = unlimited
  requires_approval boolean not null default false,     -- sales manager approves application
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (incentive_type <> 'fixed_amount' or amount_cents is not null),
  check (incentive_type <> 'percent_of_base' or percent is not null)
);
create index incentives_org_idx on public.incentives (org_id, status);
create index incentives_community_idx on public.incentives (org_id, community_id)
  where community_id is not null;

-- ============ Spec-inventory field ============
alter table public.lots
  add column if not exists asking_price_override_cents bigint;
  -- null = asking price is COMPUTED (base + premium + installed structural options);
  -- set = sales manager priced the spec by hand (markdowns, aged specs).
```

**Decisions & justifications:**
- **Reservations are a table, not lot columns.** A lot outlives many reservations
  (holds expire, buyers walk); history and cancellation reporting need rows. The
  partial unique index enforces "one live reservation per lot" in the database,
  not just the service.
- **Incentive APPLICATION is not a table.** Applied incentives are captured in the
  agreement's `contracts.snapshot.pricing.incentives[]` (immutable at signing,
  exactly like 03's selection snapshots) and, before signing, recomputed live.
  A join table would duplicate the snapshot and drift. Incentive-spend reporting
  reads snapshots of executed agreements (bounded per community; the Sales-desk
  query aggregates server-side).
- **No new columns on `contracts`.** The agreement's community/lot resolve through
  `contracts.project_id → lots.project_id` (unique). Buyer = `projects.client_id`.
  Configuration + pricing live in the existing `snapshot` jsonb. `contract_type =
  'purchase_agreement'` is the discriminator. Additive impact on the reused
  table: zero DDL.
- **Reservation expiry is lazy, no cron** (mirrors 03's "live check — cron
  independence"): every read/mutation path that touches a `hold` first applies
  `expires_at < now()` → stamps `expired` + frees the lot. No vercel.json, no
  CRON_JOBS, no proxy entries.

### Migration 2 — `202607DD######_closings.sql`

```sql
create table public.closings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  lot_id uuid references public.lots(id),
  community_id uuid references public.communities(id),   -- denormalized for desk queries
  status text not null default 'projected'
    check (status in ('projected',        -- has an executed agreement, date is a forecast
                      'scheduled',        -- settlement date set with title/buyer
                      'cleared_to_close', -- checklist gates passed
                      'closed',           -- settled; invoice issued; lot closed
                      'cancelled')),      -- agreement voided pre-settlement
  scheduled_date date,
  actual_date date,
  settlement jsonb not null default '{}'::jsonb,   -- snapshot, shape speced below
  closing_invoice_id uuid references public.invoices(id),
  cancelled_reason text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index closings_project_uniq on public.closings (project_id)
  where status <> 'cancelled';               -- one live closing per house
create index closings_org_status_idx on public.closings (org_id, status, scheduled_date);
create index closings_community_idx on public.closings (org_id, community_id)
  where community_id is not null;

-- Checklist: copy the closeout_packages/closeout_items structure 1:1
-- (lib/services/closeout.ts), scoped to the closing not the project.
create table public.closing_checklist_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  closing_id uuid not null references public.closings(id) on delete cascade,
  title text not null,
  status text not null default 'open'
    check (status in ('open','complete','waived')),
  gate boolean not null default false,     -- true = blocks cleared_to_close
  due_date date,
  responsible_party text,
  notes text,
  sort_order integer not null default 0,
  completed_at timestamptz,
  completed_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index closing_checklist_items_closing_idx
  on public.closing_checklist_items (org_id, closing_id);
```

Default checklist seed (in service, like closeout's `ensurePackage`): Blue-tape
walk completed (gate), **Punch list clear (gate — auto-checked from punch
ball-in-court: zero open punch items on the project)**, Buyer orientation /
walkthrough (gate), Certificate of occupancy on file, Final buyer selections
reconciled, Warranty package delivered, HOA/closing documents delivered. Items
attach files via `file_links` with `entity_type='closing_checklist_item'`
(closeout's exact pattern).

### Migration 3 — `202607DD######_sales_permissions.sql` (RBAC, speced in §RBAC)

## Pricing composition spec (the exact formula)

One pure module owns the math — **`lib/financials/purchase-agreement-pricing.ts`**
— mirrored by unit tests (`pnpm test:financials`), the same doctrine as
`invoice-totals.ts`. No service or component re-derives any term.

```
agreement_price_cents =
    base_price_cents            -- community_plan_availability row for (community,
                                --   plan, elevation) effective on pricing date;
                                --   elevation-specific row wins over the null-elevation row
  + lot_premium_cents           -- lots.premium_cents at pricing time
  + structural_options_cents    -- Σ resolveOptionPricing(items where option_scope='structural')
  + design_selections_cents     -- Σ resolveOptionPricing(items where option_scope='design_studio')
  − incentives_cents            -- Σ applied incentives:
                                --   fixed_amount → amount_cents
                                --   percent_of_base → round(base_price_cents × percent / 100)
                                --   'design_credit' applies min(value, design_selections_cents)

contract_price_cents (post-signing, live) =
    agreement_price_cents       -- frozen in contracts.snapshot at execution
  + Σ approved change_orders.total_cents   -- lifecycle='approved', the existing engine

settlement.final_price_cents = contract_price_cents at settlement build time
closing invoice balance_due  = final_price − Σ deposit credits (negative lines)
```

Rounding: integer cents throughout; percent incentives round half-up once (at
application), never per-line. Signs: incentives are stored positive and
SUBTRACTED; a deduction CO is a negative `total_cents` (existing convention).

**`contracts.snapshot` shape for `contract_type='purchase_agreement'`** (additive
keys; nothing existing is repurposed — cost-plus keys like `billing_model` are
simply absent):

```jsonc
{
  "purchase_agreement": {
    "community_id": "…", "lot_id": "…",
    "plan": { "house_plan_id": "…", "house_plan_version_id": "…",
              "house_plan_elevation_id": "…", "swing": "left" },
    "pricing": {
      "priced_at": "2026-08-01",
      "base_price_cents": 41200000,
      "lot_premium_cents": 1500000,
      "structural_options": [   // one entry per option/package, from resolveOptionPricing
        { "option_id": "…", "package_id": null, "category": "…", "label": "…",
          "price_cents": 850000, "source": "plan_community" }
      ],
      "structural_options_cents": 850000,
      "design_selections": [ /* same entry shape */ ],
      "design_selections_cents": 2300000,
      "incentives": [
        { "incentive_id": "…", "name": "…", "incentive_type": "fixed_amount",
          "applies_to": "price", "value_cents": 500000 }
      ],
      "incentives_cents": 500000,
      "total_cents": 45350000
    },
    "deposits": [   // appended as they are receipted; read by settlement build
      { "invoice_id": "…", "label": "Earnest deposit", "amount_cents": 1000000 }
    ]
  }
}
```

The snapshot is **immutable after execution** (like 03's confirm-time snapshots and
plan-version immutability): post-signing price movement is ONLY change orders.
`contracts.total_cents = pricing.total_cents` at execution — existing consumers
(portal financial summary, reports) keep working unmodified.

**`closings.settlement` shape** (stamped by `buildSettlement`, re-stamped until
`closed`, frozen at close):

```jsonc
{
  "built_at": "…",
  "final_price_cents": 45850000,
  "components": { "agreement_total_cents": 45350000,
                  "approved_change_orders_cents": 500000,
                  "change_order_ids": ["…"] },
  "deposits_applied": [ { "invoice_id": "…", "payment_id": "…", "amount_cents": 1000000 } ],
  "deposits_applied_cents": 1000000,
  "balance_due_cents": 44850000
}
```

**Billing-model wiring:** `resolveProjectBillingModel`
(`lib/financials/billing-model.ts:72-99`) gains one clause: `contract_type =
'purchase_agreement'` → `fixed_price` with `ownerBillingBasis` treated as
none-until-closing — concretely, `getProjectFinancialFeatureConfig` for such a
contract returns `showDraws: false`, `showGenerateFromCosts: false`,
`landingPage: "summary"`. (01 already sets the production posture default; this
rule makes the CONTRACT authoritative even on a project whose posture was flipped
later — same precedence the resolver already uses.)

## Service layer

Two new services; both follow the mandated spine (`requireOrgContext()` →
`requirePermission()`/`requireAuthorization` → logic → `recordEvent()` +
`recordAudit()` → mapped DTO). All list functions are paginated/capped —
400-lot communities and 250-closings/yr orgs are the design case.

### `lib/services/community-sales.ts`

```ts
// ---------- Spec inventory & pipeline reads ----------
listSpecInventory(opts: { communityId?: string; divisionId?: string; status?: string;
  limit?: number; cursor?: string }): Promise<Paginated<SpecInventoryRowDTO>>
// A spec = lot with project_id set AND no live reservation AND no executed
// purchase agreement on the project. Row: { lotId, lotLabel, communityId,
// projectId, planLabel, stage (current schedule phase — the project's active
// schedule item group, same derivation the portal roadmap uses), startedAt,
// agingDays, askingPriceCents (override ?? computed via pricing module),
// premiumCents }. One grouped query + pricing resolution; never N+1 per lot.

getCommunitySalesPipeline(communityId: string, orgId?: string): Promise<CommunityPipelineDTO>
// { specs: SpecInventoryRowDTO[] (capped 100 + count), holds: ReservationDTO[],
//   reserved: ReservationDTO[], agreements: AgreementSummaryDTO[] (executed, pre-closing),
//   closings: ClosingSummaryDTO[], counts per stage } — the community Sales tab payload.

// ---------- Reservations ----------
createLotHold(input: { lotId: string; buyerContactId: string; coBuyerContactId?: string;
  prospectId?: string; expiresAt: string; notes?: string }): Promise<ReservationDTO>
// Lot must be sellable (status in owned|developed|assigned|started, no live
// reservation — the partial unique index backstops the race). Snapshots
// asking_price_cents from the pricing module. Event lot_hold_created.

convertHoldToReservation(input: { reservationId: string; depositCents: number;
  projectInput?: { name?: string } }): Promise<ReservationDTO>
// TBB lot without a project: creates the preconstruction project shell
// (posture production, client_id = buyer contact, links lots.project_id, lot
// status → assigned) — precedent: proposals already require precon projects
// (conversions.ts:resolveProposalProjectId). Spec: reuses the existing project,
// sets projects.client_id = buyer. Then creates the EARNEST DEPOSIT INVOICE via
// the existing invoice service (metadata.invoice_kind='earnest_deposit',
// metadata.source_reservation_id, client_visible: true) and stores
// deposit_invoice_id. The buyer pays it through the EXISTING portal/pay-link
// Stripe rails (payments.ts) or the builder records a check via recordPayment —
// zero new money code. Status → reserved. Events: lot_reserved.

releaseReservation(input: { reservationId: string; reason: string;
  depositDisposition?: 'refund' | 'forfeit' }): Promise<ReservationDTO>
// hold|reserved → released. Deposit paid? refund = recordPaymentReversal on the
// deposit invoice's payment (existing rails); forfeit = leave the paid invoice
// (income), note disposition in metadata. Frees the lot; TBB project shells with
// no other activity are archived (never deleted). Event lot_reservation_released.

expireStaleHolds(orgId: string, communityId?: string): Promise<number>
// Lazy sweep called by every pipeline read (see decision above). No cron.

// ---------- Price sheets ----------
getCommunityPriceSheet(communityId: string, opts?: { onDate?: string }): Promise<PriceSheetDTO>
// GENERATED, not stored: rows = community_plan_availability (is_available,
// effective on date) × elevations, + lot premium range (min/max of sellable
// lots), + active incentives. Row: { planName, elevationName, basePriceCents,
// bedsBathsSqft (from house_plans), fromPriceCents (base + min premium) }.
// PDF export via the existing pdf-lib stack (follow
// lib/services/reports/pay-application.ts layout helpers) — this is the sheet a
// sales agent hands a buyer, and the agent-view read model for desk + configurator.

// ---------- Incentives ----------
listIncentives(opts: { communityId?: string; status?: string }): Promise<IncentiveDTO[]>
upsertIncentive(input: IncentiveInput): Promise<IncentiveDTO>      // sales.manage
endIncentive(id: string): Promise<void>                            // status → ended, never delete

// ---------- Agreement configurator + execution ----------
priceAgreementDraft(input: {
  lotId: string
  housePlanVersionId?: string; elevationId?: string; swing?: 'left'|'right'
  optionItems: Array<{ optionId?: string; packageId?: string }>
  incentiveIds: string[]
}): Promise<AgreementPricingDTO>
// Pure composition: availability lookup + lots.premium_cents +
// resolveOptionPricing (03's contract — pass the plan version + community) +
// incentive application, all through lib/financials/purchase-agreement-pricing.ts.
// Returns the full breakdown for the configurator UI. Validates plan/elevation
// availability and swing fit (02's lot pinning rules). Spec lots: plan fields
// come from the lot's pins and are not editable.

createPurchaseAgreement(input: {
  reservationId: string
  pricing: /* the priced draft, revalidated server-side — never trusted */
  terms?: string; effectiveDate?: string
}): Promise<AgreementDTO>
// Re-prices server-side (reject on drift with a clear diff error), pins the lot's
// plan/elevation (02 columns), writes the contracts row: contract_type
// 'purchase_agreement', status 'draft', number/title, total_cents,
// snapshot.purchase_agreement (spec above), project_id from the reservation.
// Confirms structural project_selections rows from the configuration (03's
// selectProjectOption/confirm path stamps snapshots). Generates the agreement
// PDF as a `documents` row, then ensureDraftEnvelopeForDocument(source_entity_type
// 'contract', source_entity_id contractId) + replaceEnvelopeRecipients(buyer,
// co-buyer, builder signer) + createEnvelopeSigningRequests — the proposal
// e-sign path, verbatim.

executePurchaseAgreementFromEnvelopeExecution(input: {
  orgId: string; contractId: string; envelopeId: string; executedFileId?: string | null
}): Promise<void>
// The envelope-execution callback (registered where acceptProposalFromEnvelopeExecution
// is dispatched from — grep the envelope completion route and add the
// 'contract' + purchase_agreement branch). Wrapped in a conversion run
// (conversions.ts pattern) with steps:
//   1. contracts: status 'active', signed_at, signature_data (envelope ref)
//   2. reservation → converted (contract_id set)
//   3. lot status → assigned (or unchanged if already started — spec sale)
//   4. STRUCTURAL LOCK sweep: locked_at on every structural project_selections
//      row (03 §enforcement — 03 checks this helper live; the sweep is the
//      belt-and-suspenders row lock 03 rule 3 reads)
//   5. closings row created: status 'projected', scheduled_date = project's
//      forecast end (schedule) if available
//   6. recordEvent purchase_agreement_executed + audit
// Idempotent on contracts.status='active' (re-delivered webhooks).

hasExecutedPurchaseAgreement(projectId: string, orgId: string): Promise<boolean>
// THE helper 03's assertSelectionMutable rule 1 calls: exists contracts row,
// project_id match, contract_type='purchase_agreement', status='active'.
// One indexed query; also exported for portal + UI affordances.

voidPurchaseAgreement(input: { contractId: string; reason: string;
  depositDisposition: 'refund' | 'forfeit' }): Promise<void>
// The cancellation flow (pre-closing only): contracts.status → 'void';
// closing → 'cancelled'; reservation → released (with disposition, above);
// structural locks lifted (locked_at cleared) — the house returns to SPEC
// inventory: lot keeps its project & status (started stays started), buyer
// unlinked (projects.client_id → null, portal token revoked). If never started,
// lot back to developed/owned and the TBB project shell is archived. Requires
// sales.manage; force-semantics audited like 01's lot status guard.
```

**Post-signing change orders — nothing new.** Buyer-initiated selection changes
go through 03's `createPostCutoffSelectionChangeOrder`; ad-hoc changes through
the existing CO composer. COs are `client_visible`, ride
`draft→proposed→approved`, and the buyer approves in the portal via the existing
`approveChangeOrderFromPortalSignature`. This workstream only ensures agreement
projects default new COs to `requires_signature: true` (already the default,
`change-orders.ts:612`).

### `lib/services/closings.ts`

```ts
getClosing(projectId: string, orgId?: string): Promise<ClosingDetailDTO | null>
// { closing, checklist (ensured + seeded on first read, closeout.ts pattern),
//   settlementPreview: buildSettlement(live) , agreement: AgreementSummaryDTO }

listClosings(opts: { communityId?: string; divisionId?: string; status?: string;
  from?: string; to?: string; limit?: number; cursor?: string }): Promise<Paginated<ClosingSummaryDTO>>

scheduleClosing(input: { closingId: string; scheduledDate: string }): Promise<ClosingDTO>
// projected → scheduled. closing.manage.

updateClosingChecklistItem(input: { itemId: string; status: 'open'|'complete'|'waived';
  fileId?: string; notes?: string }): Promise<ClosingChecklistItemDTO>
// Waiving a gate item requires closing.manage and is audited with reason.

markClearedToClose(closingId: string): Promise<ClosingDTO>
// Gate check: every gate item complete|waived AND the punch-clear gate re-verified
// live (zero open punch items) AND hasExecutedPurchaseAgreement. scheduled →
// cleared_to_close. Event closing_cleared.

buildSettlement(closingId: string): Promise<SettlementDTO>
// Pure read: snapshot.pricing.total + Σ lifecycle-approved COs − deposits
// receipted (paid earnest/deposit invoices from snapshot.deposits +
// metadata.invoice_kind lookup). Persisted onto closings.settlement each call
// until closed. All math in lib/financials/purchase-agreement-pricing.ts.

settleClosing(input: { closingId: string; actualDate: string }): Promise<ClosingDetailDTO>
// The revenue event, in order (conversion-run wrapped, idempotent on status):
//   1. status must be cleared_to_close
//   2. buildSettlement → freeze closings.settlement
//   3. THE CLOSING INVOICE via create_invoice_atomic (existing engine): one
//      invoice, client_visible, lines =
//        + "Purchase price — {plan}, Lot {label}"  final_price components
//          (base+premium+options as separate lines from the snapshot; approved
//          COs one line each referencing co_number)
//        − one NEGATIVE line per deposit applied ("Less: earnest deposit
//          received {date}") — the existing deposit-as-negative-line convention
//      metadata: { invoice_kind: 'closing', source_closing_id }, due on
//      actual_date. Deposit invoices are marked settled-into-closing in
//      metadata (they are already 'paid'; no double count — the negative lines
//      carry the credit).
//   4. Settlement funds arrive by wire: recordPayment against the closing
//      invoice (method 'wire'/'check' — recordPayment already accepts arbitrary
//      method strings) → invoice paid.
//   5. status → closed, actual_date; lots.status → 'closed' (01 lifecycle);
//      projects gains no new column — warranty (07) keys off the closing row.
//   6. Accounting: the invoice flows through the EXISTING outbox→QBO seam
//      untouched; when 08 lands, closings post through AccountingProvider with
//      entity mapping by community/division. REFERENCE ONLY — build nothing.
//   7. recordEvent closing_settled { final_price_cents, community_id } + audit.

cancelClosing(input: { closingId: string; reason: string }): Promise<void>
// delegate of voidPurchaseAgreement (keeps one home for the mutation).

// ---------- Backlog reporting (Sales desk + reports) ----------
getBacklogReport(opts: { divisionId?: string }): Promise<BacklogReportDTO>
// Per community: { backlogUnits, backlogValueCents (Σ executed-agreement
//   contract price not yet closed), closedUnitsYTD, closedValueYTDCents,
//   avgDaysAgreementToClose, cancellations: { count, rate } ,
//   incentiveSpendCents, incentivePercentOfPrice }.
// Aggregate SQL/RPC (grouped sums server-side — the >1000-row aggregate-RPC
// rule from platform ops), never row-fetch-and-sum in JS.
```

## Actions

Thin, Zod-validated (`lib/validation/community-sales.ts`, `lib/validation/closings.ts`),
returning `ActionResult` (`lib/action-result.ts`) with `unwrapAction()` client-side
(the invoices-actions pattern):

- `app/(app)/communities/[id]/sales/actions.ts` — createLotHoldAction,
  convertHoldToReservationAction, releaseReservationAction,
  priceAgreementDraftAction, createPurchaseAgreementAction,
  voidPurchaseAgreementAction, upsertIncentiveAction, endIncentiveAction.
- `app/(app)/projects/[id]/closing/actions.ts` — scheduleClosingAction,
  updateClosingChecklistItemAction, markClearedToCloseAction, settleClosingAction.
  (Closing mutations live on the PROJECT workbench — the house is the workbench;
  the Sales desk one-click-completes ONLY by calling these actions.)
- Sales desk (`app/(app)/sales/`) ships **no mutations of its own** except
  deep-links and the desk-rule-sanctioned one-click calls above.

## UI spec

Design rules bind: tokens only, radius 0, no hero/marquee, shadcn primitives,
dense editorial tables, `tabular-nums` money, color = state only. Every view:
empty + loading + error + dark mode, density matching siblings.

### Community workbench — new **Sales** tab (`app/(app)/communities/[id]/sales/page.tsx`)

Added to 01's tab strip (Lots · Land · **Sales** · Settings). Server component,
`Promise.all(getCommunitySalesPipeline, listIncentives, getCommunityPriceSheet)`.

- **Pipeline strip** (top, one row of muted count chips, NOT stat billboards):
  Specs · Holds · Reserved · Under agreement · Scheduled to close · Closed YTD.
- **Sections as stacked dense tables** (no kanban):
  - *Spec inventory:* Lot, Plan/Elevation, Stage, Started, Aging (days, amber
    token past org threshold), Asking price (override editable inline,
    `sales.manage`), row action "Start agreement…".
  - *Reservations:* Buyer, Lot, Status, Expires (relative, red token when <48h),
    Deposit (invoiced/paid state from the invoice), actions: Convert to
    reservation…, Release…, Start agreement….
  - *Agreements (backlog):* Buyer, Lot, Plan, Price, Signed, COs (count/Σ),
    Projected close — row opens the agreement sheet.
  - *Closings:* mirror of the project closing pipeline rows, deep-linking to the
    project workbench.
- **Price sheet** sub-view (`?view=pricesheet` or nested segment): the generated
  matrix (Plan × Elevation × Base price × From-price) + active incentives table +
  "Export PDF". This is the agent's real-time write-contracts-from view.
- **Incentives** managed in a small section (table + dialog), `sales.manage`.
- New-lot-hold + convert dialogs are compact Dialogs; agreement flow below.

### Agreement configurator (the one flow surface, launched from lot/reservation rows)

A full-height Sheet (detail-sheet exemplar: invoice detail sheet in
`components/invoices/`), stepped but not a wizard-page: sections stacked in one
scroll — Buyer (contact picker + co-buyer), Plan (plan × elevation × swing from
`community_plan_availability`; locked/prefilled for specs from lot pins),
Structural options (03's catalog filtered `option_scope='structural'`, priced
rows), Design selections (optional at signing; note "selected later in the design
studio" when skipped), Incentives (eligible list, checkboxes;
`requires_approval` ones show a pending chip), **Price panel** (right-aligned
running composition: Base / Lot premium / Structural / Design / Incentives /
Total — every number `tabular-nums`, recomputed via `priceAgreementDraftAction`).
Primary action: "Create agreement & send for signature" → e-sign recipients
confirm dialog → done state links the envelope. Client components under
`components/community-sales/`.

### Project workbench — **Closing** tab (`app/(app)/projects/[id]/closing/page.tsx`)

Shown only when a closing row exists (production agreement projects). Layout
mirrors the Closeout tab: status header (pipeline chips projected → scheduled →
cleared to close → closed), settlement panel (the `buildSettlement` breakdown as
a dense two-column money table: price components, COs, deposits, **Balance due at
closing**), checklist table (title, gate chip, status, due, responsible, file
attach), actions per state (Schedule…, Mark cleared, Settle… — settle dialog
confirms date + shows the invoice preview line summary). After settling: link to
the closing invoice (existing invoice detail sheet).

### Sales desk — `app/(app)/sales/page.tsx` (org desk)

Passes the whole-JOB test: a production builder at 25–250 closings/yr has a sales
manager whose entire job is this surface across communities. Read-mostly desk;
every row deep-links into the community Sales tab or project Closing tab.

- Title row ("Sales" + division filter when `orgHasDivisions()`, community
  filter). No hero. Then:
- **Funnel table** (rows = communities): Specs / Holds / Reserved / Backlog
  (units + $) / Scheduled closings (30d) / Closed YTD (units + $) /
  Cancellation rate / Incentive % of price. Server aggregates
  (`getBacklogReport`), one query, division-scoped via reporting-scope.
- **Aging specs** table (org-wide, worst first, capped 50): Lot, Community,
  Stage, Aging, Asking price — the "what do we need to move" list.
- **Upcoming closings** (next 30/60/90 toggle): date, buyer, community/lot,
  balance due, checklist gates remaining.
- Nav: `app-sidebar.tsx` workspaceItems entry "Sales" (`requiredAny:
  ["sales.read"]`), added for `productTier === "production"` exactly like 01's
  Communities entry; route itself not tier-gated.

### Buyer portal reshape (`app/p/[token]` under production posture)

Minimal-surgery reshape — the portal reads posture for the FIRST time, through
one config object, not scattered ifs:

- `loadClientPortalData` computes the project's posture
  (`getProjectPosture(project.property_type, org tier)` — 01 widens the type) and
  returns a new `portalPresentation` key: `{ posture, terms: terminology(posture),
  showDrawSchedule: boolean, financialSummaryMode: 'draws' | 'closing' }`.
- `PortalPublicClient` + tabs consume it:
  - **Home/financial summary:** `financialSummaryMode='closing'` renders
    Purchase price / Deposits received / Approved change orders / **Balance due
    at closing** (+ Est. closing date when scheduled) instead of the draw-based
    summary; `nextDrawPaymentAvailable` is never surfaced. Labels via
    `terms` ("Purchase agreement", "Buyer").
  - **Roadmap tab** = construction milestones (existing schedule payload — no new
    data; rename via terms only).
  - **Photos, Documents, Actions, About** unchanged. Actions tab already carries
    CO approvals and pending selections — that IS the buyer approval center;
    purchase-agreement signing arrives by envelope email (existing signing
    request flow), with the executed agreement visible under Documents.
  - **Selections tab** (03's buyer selection flow) is the design studio; locked
    structural rows already render 03's CO affordance.
  - **Invoices tab:** stays — it is how buyers see **earnest/deposit receipts**
    (`invoice_kind='earnest_deposit'`, client_visible, with payment activity)
    and, at the end, the closing invoice. `can_pay_invoices` keeps the deposit
    payable online through the existing Stripe rails.
  - Warranty tab: unchanged; workstream 07 extends it.
- What is deliberately NOT built: no separate `/b/[token]` route, no new portal
  type — the client portal IS the buyer portal, renamed by terminology
  (master §2). Token capabilities keep working; sensible production defaults for
  new invites (`can_submit_selections`, `can_approve_change_orders`,
  `can_view_invoices`, `can_pay_invoices` on; `can_view_budget` off) set in the
  invite path, not enforced by posture.

## RBAC, events, notifications, search

**Migration 3 — `202607DD######_sales_permissions.sql`** (follow 01's Migration 6;
fold into `20260708120500_rbac_catalog_seed.sql` desired-state too):

```sql
insert into public.permissions (key, description) values
  ('sales.read',    'View sales pipeline, reservations, price sheets, and closings'),
  ('sales.manage',  'Manage reservations, incentives, purchase agreements, and pricing'),
  ('closing.manage','Schedule, clear, and settle closings')
on conflict (key) do update set description = excluded.description;
-- Grants: sales.read   -> org_owner, org_admin, org_office_admin, org_project_lead, pm, org_viewer
--         sales.manage -> org_owner, org_admin, org_office_admin
--         closing.manage -> org_owner, org_admin, org_office_admin, org_bookkeeper

insert into roles (key, label, scope, description) values
  ('org_sales_agent', 'Sales Agent', 'org',
   'Community sales: inventory, pricing, reservations, and purchase agreements. No job-cost or payables access.')
on conflict (key) do update set label = excluded.label, scope = excluded.scope,
  description = excluded.description;
-- org_sales_agent grants: org.member, org.read, project.read, community.read,
--   sales.read, sales.manage, directory.read, docs.read, report.read
```

Add the three keys to `TEAM_PERMISSION_OPTIONS` (`lib/services/team.ts`) and
`org_sales_agent` to the assignable-role list (mirror `org_bookkeeper`/
`org_estimator`). Settling a closing ALSO requires the money rails' own gates
(`payment.release` for recording the wire) — do not duplicate them into
`closing.manage`. Margin fields (spec cost basis vs price, incentive cost) render
only behind `financials.margin.read` (existing key); `SpecInventoryRowDTO` for
non-margin callers omits `cost_basis_cents` at the type level (03's DTO rule).

**Events** (`recordEvent`): `lot_hold_created`, `lot_reserved`,
`lot_reservation_released`, `purchase_agreement_sent`,
`purchase_agreement_executed`, `purchase_agreement_voided`,
`incentive_applied` (in snapshot pricing at execution), `closing_scheduled`,
`closing_cleared`, `closing_settled`, `closing_cancelled`. **Audit**
(`recordAudit`) entity types: `lot_reservation`, `incentive`, `closing`,
`closing_checklist_item` (+ existing `contract`, `invoice`).

**Notifications:** in-app for reservation-expiring (48h — emitted by the lazy
sweep), agreement executed, closing scheduled/cleared. **EMAIL allowlist adds
exactly one type** (`lib/types/notifications.ts` `EMAIL_NOTIFICATION_TYPES`):
`purchase_agreement_executed` to the buyer (their copy of the executed
agreement). Everything else stays in-app; envelope signing emails and payment
receipts already email through their own existing paths.

**Search index** (`lib/services/search-index.ts`
`AUDIT_ENTITY_TYPE_TO_SEARCH`): register `closing` ("Closing — {project name}",
url = project Closing tab). Reservations and incentives are NOT registered
(settings-grade; buyers are `contacts`, already indexed).

**proxy.ts / crons:** none. No new public routes (the portal and e-sign routes
already exist), no crons (lazy expiry).

## Migration plan (recap)

| # | File | Contents |
|---|---|---|
| 1 | `..._lot_reservations_incentives.sql` | `lot_reservations`, `incentives`, `lots.asking_price_override_cents`; RLS + indexes + triggers |
| 2 | `..._closings.sql` | `closings`, `closing_checklist_items`; RLS + indexes + triggers |
| 3 | `..._sales_permissions.sql` | permissions, grants, `org_sales_agent` (+ catalog-seed fold-in) |

All additive; zero DDL on `contracts`/`invoices`/`payments`. Write files, then
STOP for human approval before assuming tables exist (local env = production).

## Phases

### Phase 1 — Reservations, incentives, spec inventory (data + service + community Sales tab)
Migrations 1+3; `community-sales.ts` (holds/reservations/release/expiry,
incentives, spec inventory, pipeline read, price sheet incl. PDF); pricing module
`lib/financials/purchase-agreement-pricing.ts` + tests; community Sales tab UI
(pipeline tables, dialogs, price sheet, incentives).
*Accept:* hold a lot with expiry → appears in pipeline; second hold on the same
lot rejected by the partial index; convert to reservation → precon project +
deposit invoice created, buyer pays it through the existing portal pay flow and
the reservation row shows Paid; expired hold lazily flips and frees the lot;
price sheet renders every available plan × elevation with correct base prices and
exports a PDF; `pnpm lint` + `pnpm test:financials` clean.

### Phase 2 — Purchase agreements (configurator, e-sign, execution, structural lock, cancellation)
`priceAgreementDraft`/`createPurchaseAgreement`/execution callback/
`hasExecutedPurchaseAgreement`/`voidPurchaseAgreement`; configurator Sheet;
billing-model clause; CO defaults verified.
*Accept:* configure a TBB (plan+elevation+2 structural options+1 incentive) →
server re-price matches UI to the cent; agreement e-signed by buyer →
`contracts` row active with immutable snapshot, reservation converted, lot
assigned, structural selections locked (03's gate now rejects with
`SELECTION_LOCKED_STRUCTURAL`), closing row `projected`; post-signing selection
change produces a fee-bearing CO the buyer approves in the portal and contract
price consumers include it; voiding returns the lot to inventory, lifts locks,
and handles refund vs forfeit through payment rails.

### Phase 3 — Buyer portal reshape
`portalPresentation` in `loadClientPortalData`; financial-summary closing mode;
terminology sweep of tab labels via `terms`; production invite defaults.
*Accept:* production-posture project's portal shows Buyer language, purchase
price/deposits/balance-at-closing, milestones, receipts in Invoices, NO draw UI
anywhere; a residential project's portal is pixel-identical to before (zero
regression); dark mode + empty/loading/error verified on changed tabs.

### Phase 4 — Closings
Migration 2; `closings.ts` (checklist seed/gates, settlement build, settle with
closing invoice, cancel); project Closing tab.
*Accept:* pipeline walks projected → scheduled → cleared (blocked until gate
items + zero open punch) → settled; settlement = base + premium + options + COs −
deposits to the cent; ONE closing invoice with deposit credit lines lands via
`create_invoice_atomic`, wire recorded via `recordPayment` → invoice paid,
closing `closed`, lot `closed`; the invoice flows to QBO through the untouched
existing sync; `pnpm test:financials` covers settlement math.

### Phase 5 — Sales desk + backlog reporting
`getBacklogReport` aggregate RPC; `app/(app)/sales` desk; nav entry; division
scoping.
*Accept:* desk funnel/aging/upcoming tables reconcile with per-community pipeline
counts; division filter scopes everything; 400-lot community + 100-agreement
backlog stays one aggregate query per table (no N+1 — verify in query logs);
desk mutates nothing except sanctioned one-click calls into workbench actions.

## Test plan

- **Unit (pnpm test:financials):** `purchase-agreement-pricing.test.ts` —
  composition formula, percent-incentive rounding, design-credit capping,
  deduction COs, settlement with multiple deposits, zero-deposit and
  zero-incentive paths; invoice-line generation for the closing invoice
  (negative deposit lines sum check against `calculateInvoiceTotals`).
- **Service-level:** reservation state machine incl. expiry laziness and the
  live-reservation unique race; `hasExecutedPurchaseAgreement` truth table;
  execution-callback idempotency (double webhook delivery); void/cancel
  inventory-return matrix (TBB unstared / TBB started / spec).
- **Manual QA (internal QA org only — never a customer org):** the Phase
  acceptance flows end-to-end, plus: mixed org check (residential project portal
  + invoicing untouched), RBAC check (`org_sales_agent` can run the pipeline but
  cannot see payables/budget or margin fields), search finds a closing, email
  allowlist sends exactly the one new type.
- `pnpm lint` clean at every phase end.

## Open questions

1. **Forfeited-deposit accounting** — kept as paid invoice income here; does the
   controller want a distinct income mapping (needs 08's entity/account mapping)?
2. **Reservation agreements as e-signed docs** — some builders sign a reservation
   form before the purchase agreement. Deferred: `lot_reservations.metadata` can
   hold an envelope ref; a first-class flow only if customers ask.
3. **Realtor/co-broker commissions** (% of price, paid at closing) — out of
   scope; likely a payables artifact generated at settlement. Future.
4. **Price-sheet effective-dating/versioning** — sheets are generated live;
   builders may want "as of" archives for regulatory reasons. Cheap to add
   (store the generated PDF), deliberately not speced.
5. **Aging-spec threshold** — hardcode 90 days or org setting? Start hardcoded,
   promote to `communities.settings` on demand.
6. **Buyer portal for pre-project holds** — a hold has no project, hence no
   portal. Acceptable? (Reservation creates the project shell, so the gap is
   hold-stage only.)

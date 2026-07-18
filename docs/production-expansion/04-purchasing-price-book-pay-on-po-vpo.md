# Workstream 04 — Purchasing: Price Book, Auto-PO, Pay-on-PO, VPO/Variance

> **STATUS: NOT STARTED**
>
> Prereqs: `00-MASTER-production-expansion.md` (read FIRST, fully — especially §5.4,
> §5.5, §4, §9), workstream 01 (divisions/communities/lots) shipped, workstream 02
> (house plans + takeoff lines + budget_templates) shipped for phases 4+. Phases 1–2
> of THIS doc need only 01. Workstream 03 (option catalog) is needed only for
> option-sourced PO lines — the generation engine treats options as an input feed and
> degrades gracefully without it.
>
> This is the **crown jewel** of the production suite. Purchasing discipline — price
> book → generated POs → pay-on-PO → VPO tracking — is what production builders buy
> an ERP for, and the field-VPO wedge (master §6) is the strongest standalone slice:
> **even a partial ship of this doc (phases 1–2) is a sellable product.**

## Mission

Four pillars, one spine:

- **(A) Price book** — `vendor_price_agreements`: who builds what, for how much, where,
  until when. Unit pricing by cost code or plan-specific lump pricing, scoped org →
  division → community → plan, effective-dated, with full pricing history (a reprice
  is a new row, never an overwrite). Fed by plan/community-level bid packages
  ("rebids") whose awards mint agreements instead of commitments.
- **(B) Auto-PO generation** — at start release (invoked by workstream 05's
  orchestration), generate the complete PO set for a lot from plan-version takeoff
  lines × price book + selected options. Output = `commitments`
  (`commitment_type='purchase_order'`) grouped per vendor, plus the **derived budget**
  (master §5.4). Idempotent, re-runnable, dry-runnable. Unpriceable lines land in an
  exceptions queue — never silently zero.
- **(C) Pay-on-PO** — completion-triggered payment with **no vendor invoice** (master
  §9: the Hyphen BuildPro/SupplyPro model; SupplyPro charges trades — Arc's free token
  portal is the competitive angle). Super or trade marks the PO complete → verification
  → auto-created `vendor_bills` row → existing AP + compliance + accounting rails take
  over unchanged.
- **(D) VPO/variance** — any post-generation dollar is a VPO: a
  `commitment_change_orders` row extended with reason codes (org-configurable
  taxonomy), origin, and threshold-based approvals. Variance analysis reporting —
  $ and incidence by reason code / plan / community / vendor / superintendent, rated
  against direct-cost budget with the 1–2% benchmark line (master §9) — is the
  flagship report of the entire production suite.

Plus the **Purchasing desk**: the org desk for the purchasing manager (a persona whose
whole JOB is this feature across projects — passes the desk test, master §7.6).

**Hard constraints (master, binding):**
- POs are commitments; VPOs are commitment change orders. **NO parallel PO tables.**
- The budget is a derived artifact — generation writes it; hand edits after
  generation are variances (§5.4).
- `variance_alerts` is TAKEN (budget threshold alerts, §4). The report is "Variance
  analysis"; the taxonomy table is `variance_reason_codes`.
- No new `qbo_*` columns anywhere. Pay-on-PO bills ride the existing
  `vendor_bills` → `qbo-sync.ts` path; workstream 08 abstracts that seam later —
  this doc only has to NOT widen it.
- Integer cents (`bigint` in new DDL, matching doc 01), org-scoped everything,
  additive migrations.

## Current-state audit (code-verified 2026-07-16)

**Commitments spine** (`lib/services/commitments.ts`, 909 lines):
- `commitments.commitment_type text not null default 'subcontract'` **already exists**
  (migration `20260617120000_commitment_budget_glow_up.sql` L27) but the service DTO
  (`CommitmentSummary`, `mapCommitment`) does not map or filter it, and no caller sets
  it. First job of this doc: surface it.
- `commitment_lines` has `cost_code_id`, `budget_line_id` (nullable FK to
  budget_lines — the tie-in the derived budget needs), `description`, `quantity`,
  `unit`, `unit_cost_cents`, `scheduled_value_cents`, `retainage_percent`,
  `sort_order`. `syncCommitmentTotalFromLines` keeps `commitments.total_cents` =
  Σ(qty × unit_cost) whenever lines change.
- `createCommitment` auto-adds the vendor to `project_vendors`
  (`ensureProjectVendorForCommitment`); approval transition checks prequalification
  (`getCompanyPrequalificationWarning`) and compliance rules
  (`block_commitment_on_prequal`). PO approval inherits all of this for free.
- E-sign: `markCommitmentExecutedFromEnvelope` + `subcontract-documents.ts` generate
  and execute documents against a commitment. POs reuse this rail when a signed PO
  document is wanted.

**Commitment change orders** (`lib/services/commitment-change-orders.ts`, 1147 lines):
- `commitment_change_orders`: status `draft|sent|approved|rejected|voided`,
  `total_cents`, `approved_at/by`, `prime_change_order_id` (link to client CO),
  `signature_envelope_id`, `metadata jsonb`. Lines carry `commitment_line_id`,
  `cost_code_id`, `budget_line_id`, qty/unit_cost/amount.
- Approved CCO totals already roll into `revised_total_cents` on every commitment
  list (`loadApprovedCommitmentChangeOrderTotals`) and into budget committed costs
  (`budgets.ts` L994). **VPOs therefore already hit committed cost correctly the
  moment they're approved — zero rollup work needed.** This doc adds classification
  (reason/origin), capture surfaces, and threshold approvals on top.

**Bid spine** (`lib/services/bids.ts` 3236 lines, `bid-portal.ts` 1179 lines):
- `bid_packages.project_id` is **already nullable** — prospect-level packages exist
  (`prospect_id`, see `listBidPackages`' `or(project_id.eq...,and(project_id.is.null,
  prospect_id.eq...))` at bids.ts:956 and `resolveBidPackageJobName` at :468). The
  loosening this doc needs is a third parent: `community_id` + `house_plan_id`
  columns and job-name resolution for them. Project-assuming code to touch:
  `resolveBidPackageJobName` (:468), buyout rollups (`getProjectBuyoutStatus` :747,
  `getProjectBuyoutSummary` :988 — these stay project-only; community packages are
  simply excluded), `listOrgBidPackages` (:1229 — must grow community/plan labels),
  bid portal's job-name display (`loadBidPortalData`).
- Award: `run_bid_award_conversion` RPC (latest:
  `20260716090001_bid_award_structured_items.sql`) — security-definer plpgsql, row
  locks, idempotent re-award return, structured `bid_submission_items` (base +
  accepted alternates) → commitment + SOV lines. **This is the exact pattern for the
  new `run_bid_award_price_agreements` RPC** (award of a community/plan package →
  price agreement rows instead of a commitment).

**Vendor bills / AP** (`lib/services/vendor-bills.ts`, 1831 lines):
- Payment blocking verified at `updateVendorBillStatus` (~L689–761): paid/partial
  requires approved first; `projects.require_subtier_waivers` → first-tier waiver
  `lien_waiver_status === 'received'` + `listMissingSubtierWaiversForBill`; org
  `compliance_rules.block_payment_on_missing_docs` → lien waiver +
  `getCompanyComplianceStatusWithClient` (COI etc). **Pay-on-PO bills created by this
  doc go through this exact function — compliance holds work with zero new code.**
- Bill approval posts to the job-cost ledger:
  `propagateApprovalToLedger({ source: "vendor_bill", ... })` (vendor-bills.ts:1091)
  → `job-cost-actuals.ts` `postJobCostEntryFromBillLine`/
  `postJobCostActualsForVendorBill` (per-line, keyed `source_type
  'vendor_bill_line'`). Actuals-by-cost-code flow is untouched by this doc.
- `metadata.source` is the established discriminator (`'vendor_credit'`,
  `'ap_review'`, portal submissions via `createVendorBillFromPortal` :1380).
  Pay-on-PO bills use `metadata.source = 'pay_on_po'` — **a metadata flag, not a
  schema change**, mirroring vendor credits.
- QBO seam: `qbo-sync.ts` syncs vendor_bills by reading the row + company
  `qbo_vendor_id` (~:960–1190). Pay-on-PO bills are ordinary rows; they sync
  unchanged. Workstream 08 will later swap this for `AccountingProvider` — this doc
  writes nothing QBO-specific.

**Budgets** (`lib/services/budgets.ts`): committed = Σ commitment_lines (qty ×
unit_cost, :987) + Σ approved CCO lines (:994); committed_billed = Σ bill lines
against commitments (:1023); EAC logic at :1138–1143. PO generation writes
`budget_lines` and links `commitment_lines.budget_line_id` so this rollup just works.

**Sub portal** (`app/s/[token]`): tabs for commitments, bills, submit-invoice, time,
expenses, daily-logs, waivers, punch, RFIs, submittals. Grants =
`portal_access_tokens` boolean capability columns enumerated in
`lib/services/portal-links.ts` `PORTAL_CAPABILITY_KEYS` (26 flags incl.
`can_view_commitments`, `can_submit_invoices`; token reuse matches the FULL set —
**new capability columns MUST be added to that array or reuse breaks**, per the file's
own header comment). `sub-portal-client.tsx` switches tabs on
`access.permissions.*`. The trade confirm→complete loop is new tabs + 2 new flags.

**Approvals precedent:** there is **no generic approvals engine** with dollar
thresholds anywhere in the repo (checked: change orders and vendor bills gate on a
single permission; the closest config precedent is org-level `compliance_rules`
read via `getComplianceRules`). VPO thresholds therefore follow the
compliance-rules pattern: an org-settings row read by the service, mapping amount
bands to required permissions — not a new workflow engine.

**Mobile** (`app/api/mobile/v1/`): `projects/`, `organizations/`, `session/`,
`devices/`, `notifications/`, `platform/`. Supers live here (master §9) — EPO capture
is new routes under `projects/[id]/`.

**From doc 01** (shipped): `divisions`, `communities` (+`division_id`, `code`),
`community_phases`, `lots` (0..1 `project_id`, unique partial index), denormalized
`projects.division_id`, `membership_divisions` scoping. From doc 02:
`house_plans`/`house_plan_versions` + plan takeoff lines (qty × uom per cost code)
and `budget_templates`. This doc references those tables but does not create them.

## Data model

Four migrations. All tables: org-scoped RLS with the `(select auth.uid())` initplan
pattern copied from doc 01's policy block, `updated_at` trigger per neighboring
migrations, money as `bigint` cents.

### Migration 1 — `<ts>_vendor_price_agreements.sql` (Phase 1)

```sql
create table public.vendor_price_agreements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  company_id uuid not null references public.companies(id),        -- vendor/trade
  cost_code_id uuid not null references public.cost_codes(id),
  cost_type text,                                    -- labor|material|labor_material|equipment|other (nullable)
  -- Scope (all nullable; null = org-wide). Resolution precedence in §Price resolution.
  division_id uuid references public.divisions(id),
  community_id uuid references public.communities(id),
  house_plan_id uuid references public.house_plans(id),
  house_plan_version_id uuid references public.house_plan_versions(id), -- optional pin; null = any version of the plan
  -- Pricing: exactly one of the two shapes.
  pricing_kind text not null check (pricing_kind in ('unit','lump_sum')),
  uom text,                                          -- required when pricing_kind='unit' (sf, lf, ea, sq, ...)
  unit_cost_cents bigint,                            -- required when 'unit'
  lump_sum_cents bigint,                             -- required when 'lump_sum' (plan-specific turnkey price)
  check (
    (pricing_kind = 'unit' and uom is not null and unit_cost_cents is not null and lump_sum_cents is null)
    or
    (pricing_kind = 'lump_sum' and lump_sum_cents is not null and unit_cost_cents is null and house_plan_id is not null)
  ),
  scope_of_work text,                                -- flows onto generated PO lines
  effective_from date not null default current_date,
  effective_to date,                                 -- null = open-ended
  status text not null default 'active'
    check (status in ('draft','active','expired','superseded','void')),
  superseded_by_id uuid references public.vendor_price_agreements(id),
  source text not null default 'manual' check (source in ('manual','bid_award','import')),
  source_bid_award_id uuid references public.bid_awards(id),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Resolution hot path: every PO generation run hits this per takeoff line.
create index vpa_resolution_idx on public.vendor_price_agreements
  (org_id, cost_code_id, status, effective_from);
create index vpa_company_idx on public.vendor_price_agreements (org_id, company_id, status);
create index vpa_community_idx on public.vendor_price_agreements (org_id, community_id)
  where community_id is not null;
create index vpa_plan_idx on public.vendor_price_agreements (org_id, house_plan_id)
  where house_plan_id is not null;
-- Expiring surfacing (desk query):
create index vpa_expiring_idx on public.vendor_price_agreements (org_id, effective_to)
  where status = 'active' and effective_to is not null;
```

**History rule (invariant, enforced in service, documented in a table comment):**
active agreements are immutable on price/scope fields. A reprice inserts a NEW row
and closes the old one (`status='superseded'`, `superseded_by_id`, `effective_to =
new.effective_from - 1 day`). Only `notes`, `metadata`, `effective_to`, and status
transitions (`void`, `expired`) mutate in place. Pricing history = the row chain.

### Migration 2 — `<ts>_bid_packages_community_plan.sql` (Phase 3)

```sql
alter table public.bid_packages
  add column if not exists community_id uuid references public.communities(id),
  add column if not exists house_plan_id uuid references public.house_plans(id),
  add column if not exists award_target text not null default 'commitment'
    check (award_target in ('commitment','price_agreement'));
create index bid_packages_community_idx on public.bid_packages (org_id, community_id)
  where community_id is not null;
-- Exactly one parent context:
alter table public.bid_packages add constraint bid_packages_one_parent check (
  (project_id is not null)::int + (prospect_id is not null)::int
    + (community_id is not null or house_plan_id is not null)::int <= 1
  or (community_id is not null and house_plan_id is not null
      and project_id is null and prospect_id is null)
);
```

(`award_target='price_agreement'` is forced by the service whenever
`project_id is null and prospect_id is null`; the column exists so the award UI and
RPC don't have to infer.)

Plus the new RPC `run_bid_award_price_agreements(p_org_id, p_bid_submission_id,
p_awarded_by, p_notes, p_accepted_alternate_ids)` — same skeleton as
`run_bid_award_conversion` (row locks on submission/invite/package, idempotent
re-award return, `bid_awards` row) but instead of a commitment it inserts
`vendor_price_agreements` rows: one per priced `bid_submission_item` (cost code from
the scope item; `pricing_kind` from the scope item's uom presence — plan packages
with no uom become `lump_sum` on the package's plan), `source='bid_award'`,
`source_bid_award_id`, scoped to the package's `community_id`/`house_plan_id`.
Superseding overlapping active agreements (same company+cost_code+scope tuple)
happens in the same transaction.

### Migration 3 — `<ts>_po_generation_pay_on_po.sql` (Phases 4–5)

```sql
-- One row per generation attempt for a lot's project. The auditable record that
-- makes generation idempotent + re-runnable + dry-runnable.
create table public.po_generation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  lot_id uuid not null references public.lots(id),
  house_plan_version_id uuid not null references public.house_plan_versions(id),
  mode text not null check (mode in ('dry_run','commit')),
  status text not null default 'running'
    check (status in ('running','succeeded','succeeded_with_exceptions','failed','superseded')),
  as_of_date date not null default current_date,     -- price book resolution date
  input_fingerprint text not null,                   -- sha256 of ordered (takeoff lines + option ids + resolved agreement ids)
  summary jsonb not null default '{}'::jsonb,        -- {po_count, line_count, total_cents, exception_count, per_vendor: [...]}
  error text,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index po_gen_runs_project_idx on public.po_generation_runs (org_id, project_id, created_at desc);

-- Unpriceable / ambiguous lines. NEVER silently zero (mission rule).
create table public.po_generation_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  run_id uuid not null references public.po_generation_runs(id) on delete cascade,
  project_id uuid not null references public.projects(id),
  cost_code_id uuid references public.cost_codes(id),
  source_kind text not null check (source_kind in ('takeoff_line','option')),
  source_ref jsonb not null,                         -- {takeoff_line_id} | {project_selection_id, option_id}
  description text not null,
  quantity numeric,
  uom text,
  reason text not null check (reason in
    ('no_agreement','expired_agreement','ambiguous_agreement','uom_mismatch','no_vendor','no_cost_code')),
  candidates jsonb not null default '[]'::jsonb,     -- competing agreement ids for 'ambiguous_agreement'
  status text not null default 'open'
    check (status in ('open','resolved_agreement','resolved_manual','dismissed')),
  resolution jsonb,                                  -- {agreement_id} | {company_id, unit_cost_cents} | {note}
  resolved_by uuid references public.app_users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index po_gen_exceptions_open_idx on public.po_generation_exceptions (org_id, status, project_id);

-- Pay-on-PO completion workflow (workflow record, not a parallel PO table —
-- the PO itself stays a commitment).
create table public.po_completions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  commitment_id uuid not null references public.commitments(id),
  -- null = whole-PO completion; set = partial completion of specific lines:
  commitment_line_ids uuid[],
  status text not null default 'reported'
    check (status in ('reported','verified','approved','rejected','billed','void')),
  reported_source text not null check (reported_source in ('trade_portal','super_mobile','office')),
  reported_by_contact_id uuid references public.contacts(id),   -- trade portal path
  reported_by_user_id uuid references public.app_users(id),     -- super/office path
  reported_at timestamptz not null default now(),
  notes text,
  photo_file_ids uuid[] not null default '{}',
  verified_by uuid references public.app_users(id),
  verified_at timestamptz,
  approved_by uuid references public.app_users(id),
  approved_at timestamptz,
  rejected_reason text,
  vendor_bill_id uuid references public.vendor_bills(id),       -- set on approval
  amount_cents bigint,                                          -- snapshot of billed amount
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index po_completions_queue_idx on public.po_completions (org_id, status, project_id);
create index po_completions_commitment_idx on public.po_completions (org_id, commitment_id);

-- Pay-on-PO toggle: org default + per-community override.
alter table public.communities
  add column if not exists pay_on_po_enabled boolean;            -- null = inherit org setting
-- Org default lives in the purchasing settings row (Migration 4).

-- Sub portal trade loop capabilities (MUST also be appended to
-- PORTAL_CAPABILITY_KEYS in lib/services/portal-links.ts — see audit):
alter table public.portal_access_tokens
  add column if not exists can_view_purchase_orders boolean not null default false,
  add column if not exists can_report_po_completion boolean not null default false;
```

### Migration 4 — `<ts>_vpo_reason_codes_and_settings.sql` (Phase 2)

```sql
-- Org-configurable variance taxonomy. NOT named variance_alerts (taken, master §4).
create table public.variance_reason_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  code text not null,                                -- short stable key, e.g. 'missed_scope'
  label text not null,
  description text,
  is_active boolean not null default true,
  is_backcharge boolean not null default false,      -- CONSTRUCTION-phase trade back-charge offsets (negative VPOs on open POs); post-closing warranty backcharges use WS07's vendor-credit rail, NOT CCOs
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

-- VPO classification on the commitments-CO spine (master §5.5). Additive columns;
-- existing residential/commercial CCOs keep nulls and are unaffected.
alter table public.commitment_change_orders
  add column if not exists reason_code_id uuid references public.variance_reason_codes(id),
  add column if not exists origin text
    check (origin in ('field_mobile','office','design_studio_co','trade_portal')),
  add column if not exists requested_by uuid references public.app_users(id),
  add column if not exists photo_file_ids uuid[] not null default '{}';
create index cco_variance_idx on public.commitment_change_orders
  (org_id, reason_code_id, status) where reason_code_id is not null;

-- Purchasing settings, one row per org (compliance_rules pattern — see audit:
-- no generic approvals engine exists; thresholds are settings the service reads).
create table public.purchasing_settings (
  org_id uuid primary key references public.orgs(id),
  pay_on_po_enabled boolean not null default false,  -- org default; communities.pay_on_po_enabled overrides
  po_completion_requires_verification boolean not null default true,  -- super verify step for trade-reported completions
  vpo_reason_code_required boolean not null default true,
  -- Ordered bands: first band whose up_to_cents >= |total| wins; null up_to = infinity.
  -- Default: [{"up_to_cents":100000,"permission":"vpo.approve"},
  --           {"up_to_cents":null,"permission":"vpo.approve_large"}]
  vpo_approval_thresholds jsonb not null default
    '[{"up_to_cents":100000,"permission":"vpo.approve"},{"up_to_cents":null,"permission":"vpo.approve_large"}]'::jsonb,
  expiring_agreement_lead_days integer not null default 30,
  updated_at timestamptz not null default now()
);
```

**Seed** (in the same migration, inserted per-org lazily by the service on first read
— NOT a data migration across all orgs; follow the compliance-rules lazy-default
pattern): default `variance_reason_codes` — industry taxonomy:
`missed_scope` (Missed scope / estimating omission), `plan_error` (Plan/spec error),
`damage_theft` (Damage or theft), `selection_after_cutoff` (Selection after cutoff),
`site_condition` (Unforeseen site condition), `back_charge` (Trade back-charge,
`is_backcharge=true`), `winter_condition` (Winter/weather condition), `code_required`
(Inspection/code requirement), `price_increase` (Vendor price increase),
`quantity_overrun` (Quantity overrun), `warranty_rework` (Warranty/rework —
WS07 links), `other` (Other — always last).

## Price resolution algorithm (exact spec — `lib/financials/price-resolution.ts`, pure)

Input: `{ costCodeId, costType?, uom?, quantity, housePlanId, housePlanVersionId,
communityId, divisionId, asOfDate }` + the org's candidate agreement rows.
Output: `{ resolved: { agreementId, companyId, pricingKind, unitCostCents? |
lumpSumCents, scopeOfWork } } | { exception: { reason, candidates } }`.

1. **Filter** to candidates: `status='active'`, `cost_code_id` matches,
   `effective_from <= asOfDate`, `(effective_to is null or effective_to >= asOfDate)`,
   and scope compatibility — an agreement is compatible iff each of its non-null
   scope fields matches the input (`division_id`, `community_id`, `house_plan_id`;
   `house_plan_version_id` when set must equal the input version). `cost_type` set on
   the agreement must match the input cost_type when both present.
2. **Rank by specificity** (master-mandated precedence, most specific wins):
   1. `community + plan` match (both non-null and matching)
   2. `plan` match (plan non-null, community null)
   3. `community` match (community non-null, plan null)
   4. `org default` (both null)
   Within a tier, a row with `division_id` set outranks one without; a row with
   `house_plan_version_id` pinned outranks an unpinned plan row; a row with
   `cost_type` set outranks a null-cost_type row.
3. **UOM check** (unit pricing): if the winning agreement is `pricing_kind='unit'`
   and its `uom` ≠ the takeoff line's uom → exception `uom_mismatch` (no unit
   conversion in v1 — an open question below). `lump_sum` agreements ignore uom and
   quantity (line total = `lump_sum_cents`).
4. **Tie-break** within the winning specificity tier: latest `effective_from` wins;
   if still tied (two vendors, same tier, same date) → exception
   `ambiguous_agreement` with both ids in `candidates`. **Never auto-pick a vendor
   on a tie.**
5. No candidates → exception `no_agreement` (or `expired_agreement` when the only
   matches failed the date filter — distinguishing these makes the desk actionable).

Pure function, zero DB access, exhaustively unit-tested (see Test plan). The service
wrapper batches: load ALL active agreements for the org's involved cost codes in one
query, resolve in memory.

## PO generation engine (`lib/services/po-generation.ts`)

**Contract:**

```ts
generatePurchaseOrders(args: {
  projectId: string
  mode: "dry_run" | "commit"
  asOfDate?: string            // default today; price-book resolution date
  orgId?: string
}): Promise<PoGenerationResult>

interface PoGenerationResult {
  runId: string
  mode: "dry_run" | "commit"
  status: "succeeded" | "succeeded_with_exceptions" | "failed"
  inputFingerprint: string
  purchaseOrders: Array<{      // grouped per vendor (one PO per company per run)
    commitmentId?: string      // set in commit mode
    companyId: string; companyName: string
    totalCents: number
    lines: Array<{ costCodeId: string; description: string; scopeText?: string
      optionDescriptor?: string; quantity: number; unit: string
      unitCostCents: number; totalCents: number; sourceAgreementId: string }>
  }>
  exceptions: PoGenerationExceptionDTO[]
  budgetLinesWritten: number   // commit mode only
}
```

**Inputs** (all read in one `Promise.all`):
1. The lot's pinned `house_plan_version` takeoff lines (WS02): qty × uom per cost
   code + description.
2. Confirmed `project_selections` with cost data (WS03): option cost lines carry
   their own cost_code + vendor hint + cost; options whose catalog entry names a
   vendor bypass resolution; others resolve like takeoff lines. Option lines carry
   `optionDescriptor` (option name + SKU) into the PO line description. If WS03 is
   not yet shipped, this feed is empty — the engine must not require it.
3. Price book resolution per line (§above), `asOfDate` = the run's as_of_date.

**Behavior:**
- **Grouping:** one PO (commitment, `commitment_type='purchase_order'`,
  status `draft`) per vendor per run. Title: `PO — <trade/cost-code area> — <lot
  label>`; `contract_number` from the existing per-project numbering convention
  (audit `subcontract-documents.ts` numbering, reuse). Lines =
  `commitment_lines` rows carrying description, scope text (from the agreement's
  `scope_of_work`), option descriptors, cost codes, qty/uom/unit_cost.
  `metadata.source_generation_run_id`, `metadata.source_agreement_ids` on the
  commitment; per-line `metadata.source` (`takeoff_line`/`option`) with refs.
- **Derived budget (master §5.4):** in commit mode, write the lot's `budget_lines`
  from the same resolved data (grouped per cost code, amount = Σ resolved line
  totals; the WS02 `budget_templates` shape defines columns) and set
  `commitment_lines.budget_line_id` to the matching budget line. Budget committed
  rollup (`budgets.ts` :987) then reconciles to the PO set by construction.
- **Exceptions:** every unresolvable line becomes a `po_generation_exceptions` row
  (both modes; dry-run exceptions let purchasing fix the book BEFORE release).
  Commit mode with exceptions → status `succeeded_with_exceptions`; the generated
  POs cover only resolved lines and the run summary shows uncovered cost codes.
  WS05's start-package gate treats open exceptions as a release blocker
  (`hasOpenPoExceptions(projectId)` exported for it).
- **Idempotency + re-run:** `input_fingerprint` = sha256 over sorted (takeoff line
  ids+qty, selection ids, resolved agreement ids, asOfDate). Re-running in commit
  mode when a prior committed run exists:
  - identical fingerprint → no-op, returns the prior run;
  - changed fingerprint → allowed only while ALL prior generated POs are still
    `draft` (none approved/executed/billed): prior run marked `superseded`, its
    draft commitments + written budget lines deleted (leave-no-trash), fresh set
    generated. Once any PO is approved, re-generation is REFUSED with a message
    pointing at the VPO flow — post-approval deltas are variances by definition
    (master §5.4/§5.5).
- **Atomicity:** commit mode runs inside a security-definer RPC
  `run_po_generation_commit(p_run_id, p_payload jsonb)` (pattern:
  `run_bid_award_conversion` / `post_pay_application`) so POs + lines + budget
  lines + run status land in one transaction. The service does resolution/assembly
  in TS, then hands the RPC a fully-resolved payload.
- **Caller:** WS05's start-release orchestration (outbox job) calls
  `generatePurchaseOrders({ mode: 'commit' })`; the lot workbench and Purchasing
  desk expose dry-run. PO documents: optional per-vendor PDF via the existing
  `subcontract-documents.ts` + e-sign rails, triggered per-PO from the commitment
  detail (not auto-sent by generation — approval and issuance stay human).

## Pay-on-PO state machine

Enabled when `communities.pay_on_po_enabled ?? purchasing_settings.pay_on_po_enabled`
is true for the lot's community. Everywhere else, traditional invoice-based AP
remains the default and nothing in this section renders.

```
                    trade (portal) or super (mobile/web) reports done
  PO approved ──────────────────────────────────────────────► reported
                                                                 │
                     super/PM verifies in field                  │  (skipped when
  reported ────────────────────────────────────────► verified    │  po_completion_requires_verification=false
                                                                 │  OR reporter is a super — self-verify)
  verified ──── purchasing/bookkeeper approves ────► approved ── creates vendor_bill ──► billed
  reported|verified ── reject (reason required) ──► rejected ── trade may re-report
  any pre-billed state ── void ──► void
```

| Transition | Who | Permission / grant |
|---|---|---|
| → `reported` | trade via `app/s/[token]` (grant `can_report_po_completion`) or super via mobile/web | portal grant / `po_completion.report` |
| `reported → verified` | super/PM confirms work in place (photos visible) | `po_completion.verify` |
| `verified → approved` | purchasing manager / bookkeeper | `bill.approve` (reuse — approval here IS bill approval) |
| `approved → billed` | system, same transaction | — |
| `→ rejected` / `→ void` | verifier/approver | `po_completion.verify` |

**On approval (single service transaction):** create a `vendor_bills` row via the
existing internal creation path in `vendor-bills.ts` — `company_id` from the
commitment, `commitment_id` set, `bill_lines` copied from the PO's commitment_lines
(or the completed subset for partial completions), `total_cents` = completed amount,
`status='approved'` with `approved_at/by`, `metadata.source='pay_on_po'`,
`metadata.po_completion_id`. Bill approval fires the existing
`propagateApprovalToLedger` job-cost posting; **payment** still goes through
`updateVendorBillStatus` where the audited compliance holds (COI, first-tier +
sub-tier lien waivers) block exactly as they do for invoiced bills. Guard:
Σ pay-on-PO billed per commitment ≤ commitment revised total (base + approved VPOs);
over-completion is refused with a pointer to the VPO flow. QBO: the bill syncs on
the existing vendor_bills path untouched (WS08 seam).

**Trade portal loop** (extends `app/s/[token]`): new "Purchase orders" tab (grant
`can_view_purchase_orders`) listing the company's POs on the project — scope lines,
amounts, schedule context (linked schedule items from WS05 when present), VPOs, and
per-PO payment status (completion state → bill status → paid). "Mark complete"
(grant `can_report_po_completion`): whole-PO or per-line, required photos (reuse
`portal-uploads.ts`), optional note → creates the `po_completions` row and notifies
the super. This is deliberately the seed of the trade-network surface (master §10 —
free for trades, vs SupplyPro charging them; say so in the empty state copy, plainly).

## VPO lifecycle + approvals

A VPO is a `commitment_change_orders` row on a `commitment_type='purchase_order'`
parent with `reason_code_id` set. Lifecycle reuses the existing CCO statuses:

```
draft ──submit──► sent(=pending approval) ──approve──► approved ──► committed-cost rollup (already wired)
draft|sent ──reject──► rejected      approved ──void──► voided (reverses rollup by status change)
```

- **Create** (`origin` tags the surface): field super via mobile EPO capture
  (`field_mobile`), office via Purchasing desk / commitment detail (`office`),
  design-studio post-cutoff CO fan-out from WS03 (`design_studio_co` — WS03 calls
  `createCommitmentChangeOrder` with reason `selection_after_cutoff`), trade request
  from the portal (`trade_portal`, lands as `draft` for office review). Required:
  reason code (when `vpo_reason_code_required`), amount lines (cost code inherited
  from the parent PO line when linked), photos optional but pushed hard in field UX.
- **Approval thresholds:** `approveCommitmentChangeOrder` resolves the required
  permission from `purchasing_settings.vpo_approval_thresholds` by |total_cents|
  band and enforces via `requireAuthorization`. Default: ≤$1,000 → `vpo.approve`
  (PM/super-manager tier), above → `vpo.approve_large` (purchasing manager/org
  admin). Backcharge reason codes force negative totals and require
  `vpo.approve_large` regardless of size (they hit another trade's ledger; WS07
  builds the offsetting flow). Non-PO commitment COs (subcontract CCOs,
  residential/commercial) keep their existing gate — threshold logic applies ONLY
  when `reason_code_id` is present, so shipped postures are untouched.
- **Budget effect:** none to build — approved CCO totals already roll into committed
  cost and EAC (audit §above). A VPO IS the audit trail of the budget delta.

**Variance analysis reporting (flagship).** `lib/services/reports/variance-analysis.ts`:
- Base query: approved VPOs (`reason_code_id is not null`) joined to commitment →
  project → lot → community/division, plus the project's direct-cost budget base
  (generated budget total from the committed `po_generation_runs.summary`, fallback
  Σ budget_lines).
- Dimensions: reason code, house plan, community, division, vendor, superintendent
  (project assignee), month. Measures: variance $ (net + absolute), incidence
  (count), variance rate = variance $ ÷ direct-cost budget of the covered lots.
- The **1–2% benchmark band** (master §9) renders as a reference line/band on the
  rate; per-community rate colored by state tokens only when outside the band
  (color = state, not decoration).
- **Weekly review queue:** the desk's VPO tab defaults to "pending approval +
  approved this week"; a weekly digest notification to `vpo.approve_large` holders
  (respect the EMAIL_NOTIFICATION_TYPES allowlist — in-app by default; email only
  if added to the allowlist deliberately).
- Aggregates use the >1000-row RPC-sum rule (memory: platform-ops) — an org doing
  250 closings/yr generates thousands of VPO rows; sums happen in SQL
  (`get_variance_analysis` RPC returning grouped rows), never row-fetch-and-reduce.
- Export: csv/json/pdf following `project-reports` conventions.

**Rebate capture (deferred, master §10):** PO lines already persist SKU-bearing
option descriptors and source agreements — the data a future PO↔SKU rebate-matching
module needs. Note in code comments where descriptors are written; build nothing.

## Service layer

**New `lib/services/price-book.ts`** (canonical shape: `requireOrgContext` →
`requireAuthorization` → logic → `recordEvent`/`recordAudit` → DTO):
- `listPriceAgreements({ filters: { companyId?, costCodeId?, communityId?, housePlanId?, status?, expiringWithinDays? }, page })` — server-paginated day one.
- `createPriceAgreement(input)` / `repriceAgreement(agreementId, { unitCostCents|lumpSumCents, effectiveFrom, notes })` — reprice = insert new + supersede old in one transaction (history invariant).
- `voidPriceAgreement(agreementId)`, `setAgreementEnd(agreementId, effectiveTo)`.
- `getPriceBookHealth()` — desk widget: counts by status, expiring within lead days, cost codes with zero active coverage per active community, ambiguous overlaps.
- `expirePastDueAgreements()` — flips `active`→`expired` past `effective_to`; runs in the existing daily maintenance cron (register in CRON_JOBS if a new job is added; prefer piggybacking an existing daily job).
- `resolvePriceForLine(...)` — thin wrapper over the pure resolver, used by the exceptions queue's "test a fix" affordance.
- `importPriceAgreements(rows[])` — CSV import (source `import`), idempotent, dry-runnable; WS09 reuses it.

**New `lib/services/po-generation.ts`:** `generatePurchaseOrders` (contract above),
`listGenerationRuns(projectId)`, `listPoExceptions({ status, projectId?, page })`,
`resolvePoException(exceptionId, resolution)` (creates/points at an agreement, or
manual price → regenerates the affected lines into the run's PO set via a scoped
re-run), `dismissPoException(exceptionId, note)`, `hasOpenPoExceptions(projectId)`
(WS05's `price_book` readiness gate), and `isPurchasingEnabled(orgId,
communityId?)` — true when at least one `active` vendor_price_agreement exists in
scope. WS05's release orchestration branches on it: purchasing enabled → the `pos`
step (this engine) writes the derived budget; disabled (wedge orgs) → WS02's
budget instantiation writes it. Exactly one writer, per master §5.4.

**New `lib/services/po-completions.ts`:** `reportPoCompletion` (internal +
portal-context variant following `createVendorBillFromPortal`'s token-auth pattern),
`verifyPoCompletion`, `approvePoCompletion` (creates the bill, transaction),
`rejectPoCompletion`, `listPoCompletions({ status, projectId?, communityId?, page })`,
`listPortalPurchaseOrders(access)` (portal read model with payment status).

**Evolve `lib/services/commitments.ts`:** add `commitment_type` to
`CommitmentSummary` + `mapCommitment` + select strings; `listProjectCommitments`
gains an optional `type` filter; `createCommitment` accepts `commitment_type`
(validation enum `subcontract|purchase_order`; default unchanged). No behavior forks
by type inside the service.

**Evolve `lib/services/commitment-change-orders.ts`:** map + accept `reason_code_id`,
`origin`, `requested_by`, `photo_file_ids`; threshold enforcement in the approve path
(spec above); `listVarianceOrders({ filters, page })` for the desk queue. Zod in
`lib/validation/commitment-change-orders.ts` extended accordingly.

**Evolve `lib/services/bids.ts`:** `createBidPackage`/`updateBidPackage` accept
`community_id`/`house_plan_id` (+`award_target`), `resolveBidPackageJobName` handles
community/plan parents (name = `<community> — <plan>` etc.),
`listCommunityBidPackages(communityId)`, award action routes to
`run_bid_award_price_agreements` when `award_target='price_agreement'`. Bid portal
job-name display follows.

**New pure math:** `lib/financials/price-resolution.ts` (resolver) +
`lib/financials/po-generation-math.ts` (grouping, totals, fingerprint) — DB-free for
the financials test suite.

## Actions

Thin, Zod-validated, `ActionResult`/`{ success, error }` per repo rule (server-action
error redaction). New `app/(app)/purchasing/actions.ts` for desk mutations
(price agreements CRUD/reprice, exception resolution, VPO approve/reject, completion
verify/approve); lot-workbench generation actions live with the project financials
actions; portal actions in `app/s/[token]/purchase-orders/actions.ts` (token-scoped,
no session assumptions); mobile handlers under `/api/mobile/v1` (below). Validation
files: `lib/validation/price-book.ts`, `po-generation.ts`, `po-completions.ts`.

## UI spec

Dense, calm, editorial — tokens only, radius 0, tables over cards, tabular-nums
money, color = state. Every view: empty/loading/error + dark mode. Match financials
siblings' density. No heroes.

**Purchasing desk — `app/(app)/purchasing/`** (org desk; persona = purchasing
manager, whole-JOB test passes; read-mostly + one-click-completes that call workbench
actions):
- Title row ("Purchasing"), then a slim stat strip (plain figures, no billboard):
  active agreements / expiring ≤N days / open exceptions / VPOs pending / VPO rate
  MTD vs benchmark.
- Tabs: **Price book** (the editor below), **Bid packages** (community/plan packages:
  stage, invites, due, award → agreements; deep-links to the existing bid package
  detail), **Exceptions** (open `po_generation_exceptions` across lots: lot, cost
  code, description, qty/uom, reason, candidates → row expands to resolve inline:
  pick candidate / create agreement prefilled / manual price+vendor; resolving
  re-runs the affected lines), **VPOs** (approval queue: lot, vendor, reason, origin,
  requested-by, photos indicator, amount, age; approve/reject inline per thresholds;
  filters by community/reason/origin; "this week" default), **Variance analysis**
  (the report: rate headline vs 1–2% benchmark band, grouped tables by reason /
  community / plan / vendor / super with $, count, rate columns; period picker;
  export). All server-paginated.
- Nav: org sidebar entry "Purchasing", visible when org tier is production OR the
  org has any price agreements (mixed orgs; follow the nav-config pattern, no inline
  posture ifs).
- Empty states are onboarding: price book empty → "Import agreements or award a bid
  package" with both actions.

**Price book editor:** dense grid — vendor, cost code, scope (division/community/
plan chips), kind, uom, unit/lump price, effective from→to, source, status. Row
click → detail sheet (invoice-detail-sheet exemplar): pricing history chain
(superseded rows, oldest→newest), source bid award link, Reprice (new-row semantics
explicit in the affordance: "Reprice from <date>"), End, Void. Filters: vendor, cost
code, community, plan, status, expiring. Expiring rows carry a quiet state-colored
date, not a banner.

**Lot/project surfaces:** project financials commitments tab gains a type column/
filter (PO vs subcontract) — no new tab; commitment detail sheet shows generation
provenance (run link, source agreements), VPO list with reasons, completion state
when pay-on-PO. Generation panel on the lot workbench (WS05 owns placement):
last run summary, Dry run / Generate buttons, exceptions count linking to the desk.

**Trade portal** (`app/s/[token]/purchase-orders/`): PO list (title, amount, revised
amount, schedule window, status chain completion→bill→paid), detail with lines +
scope + VPOs, "Mark complete" flow (per-line checkboxes, photo upload required,
note). Matches existing sub-portal visual language; token states (expired/revoked)
already handled by the layout.

**Mobile EPO capture** (`/api/mobile/v1/projects/[id]/vpos` + org-level
`/api/mobile/v1/organizations/[id]/reason-codes`): `GET` list (super's own +
project), `POST` create draft VPO — commitment picker (defaults from cost code),
reason code (required, server list), amount, note, photo file ids (existing mobile
upload path), `origin='field_mobile'`. Follows the mobile v1 route/session/decoding
conventions (memory: iOS `.iso8601` fractional-seconds gotcha). iOS UI itself ships
with the iOS workstream; the API contract lands here.

## RBAC, events, notifications, search

- **Catalog-as-code seed migration** (rbac_catalog pattern): permissions
  `price_book.read`, `price_book.write`, `po.generate`, `po_exception.resolve`,
  `vpo.request`, `vpo.approve`, `vpo.approve_large`, `po_completion.report`,
  `po_completion.verify`. New assignable role **`org_purchasing_manager`**
  (bookkeeper/estimator assignable-role pattern): all of the above +
  `commitment.read/write/approve`, `bill.approve`. PMs/supers get `vpo.request`,
  `po_completion.report/verify`, `vpo.approve` (small band) via existing role rows.
- **Events:** `price_agreement.created|repriced|expired|voided`,
  `bid_package.awarded_to_price_book`, `po_generation.completed` (payload: run id,
  mode, counts), `po_exception.resolved`, `vpo.requested|approved|rejected`,
  `po_completion.reported|verified|approved|rejected`, plus existing
  commitment/bill events firing naturally. Audit on every mutation.
- **Notifications:** in-app to approvers on `vpo.requested` and
  `po_completion.reported`(→verifiers); weekly variance digest. EMAIL only if
  deliberately added to `EMAIL_NOTIFICATION_TYPES` — propose adding ONLY
  `vpo.requested` above the large threshold; everything else stays in-app.
- **Search:** register `price_agreement` (title = vendor + cost code + scope) and
  keep commitments/CCOs flowing through the existing write-through index; VPO reason
  labels included in the CCO index text.
- **Proxy/cron:** no new public routes (portal rides `/s/[token]` pages/actions;
  mobile rides `/api/mobile/v1` which is already public-listed — verify in
  `proxy.ts`). Any new cron job → GET handler + `vercel.json` + CRON_JOBS registry.

## Migration plan

Order: Migration 4 (reason codes/settings — Phase 2 wedge) may ship before 2 and 3;
1 ships first regardless. Each is additive; RLS + indexes in-file; applied via
`supabase/migrations/` + MCP `apply_migration` per repo rules (local env is PROD —
no test mutations). Backfill: none required — existing commitments keep
`commitment_type='subcontract'` (already defaulted), existing CCOs keep null reason
codes and are excluded from variance surfaces by the `reason_code_id is not null`
predicate. Leave-no-trash checkpoints: superseded generation runs delete their draft
commitments/budget lines; no `-v2` anything; if the desk obsoletes any existing
buyout surface piece, delete it in the same phase.

## Phases

**Phase 1 — Price book core** (needs 01 only)
Migration 1; `price-book.ts` (CRUD, reprice chain, health, expiry job, import);
`price-resolution.ts` pure resolver + tests; Purchasing desk shell with Price book
tab + editor + expiring surfacing; RBAC seed; search registration.
*Accept:* create/reprice/void agreements with history chain visible; reprice never
mutates the old row (verified in audit_log); expiring filter and desk stat correct;
resolver unit tests green; `pnpm lint` clean.

**Phase 2 — VPO workflow + variance analysis (THE WEDGE — shippable alone)**
Migration 4 + lazy seed; CCO service/validation extension; threshold approvals;
desk VPO queue tab; mobile EPO API; variance-analysis service + report tab + weekly
digest (in-app); events/notifications.
*Accept:* field-originated VPO (API) with reason + photos → appears in queue →
small-band approver can approve ≤$1,000, cannot above; approved VPO moves committed
cost/EAC on the budget with no new rollup code; variance report groups by all six
dimensions with correct rate vs benchmark; existing subcontract CCO flows byte-
identical (regression: approve a reason-less CCO on a commercial project).

**Phase 3 — Rebid: community/plan bid packages → price agreements**
Migration 2 + `run_bid_award_price_agreements` RPC; bids.ts/bid-portal loosening
(job-name resolution, org list labels); desk Bid packages tab; award UI routing.
*Accept:* create a community+plan package with uom scope items, invite, receive
portal bids, award → agreements created with correct scope/pricing/source links and
overlapping old agreements superseded in the same transaction; re-award idempotent;
project-level bid award path untouched (regression).

**Phase 4 — Auto-PO generation** (needs 02; 03 optional)
Migration 3 (runs + exceptions tables); `po-generation.ts` + commit RPC +
`po-generation-math.ts`; commitments.ts `commitment_type` surfacing; exceptions desk
tab + resolution flow; lot generation panel; derived-budget write.
*Accept:* dry run on a lot with a full price book yields per-vendor PO preview whose
total = Σ(takeoff × book) + options; commit creates draft commitments + budget lines
with `budget_line_id` links and committed rollup reconciling exactly; a line with no
agreement lands as an exception (never $0); identical re-run no-ops; changed-input
re-run supersedes drafts but refuses once a PO is approved; exception resolution
completes the PO set.

**Phase 5 — Pay-on-PO + trade portal loop**
`po_completions` flow in `po-completions.ts`; portal capability columns +
`PORTAL_CAPABILITY_KEYS` additions; portal Purchase orders tab + mark-complete;
completion verify/approve queue on the desk; bill auto-creation; toggles.
*Accept:* toggle on for one community only; trade reports completion with photos →
super verifies → approve creates an approved `vendor_bills` row
(`metadata.source='pay_on_po'`) that posts job-cost actuals and syncs to QBO like
any bill; payment attempt with missing COI/waiver blocked by the existing holds;
over-completion beyond revised total refused; toggle-off communities show zero
pay-on-PO UI anywhere.

**Phase 6 — Desk completion + polish**
Stat strip wiring incl. price-book health + VPO rate MTD; variance export (csv/pdf);
weekly digest scheduling; nav visibility rule; empty/loading/error + dark sweep on
every new surface; pagination audit at the 400-lot/250-closing design case;
leave-no-trash sweep.
*Accept:* desk loads under the design-case data volume with server pagination
everywhere; all states verified; `pnpm lint` + `pnpm test:financials` green.

## Test plan

`pnpm test:financials` additions (pure, DB-free, node-test style in `tests/` — the
pay-app-math precedent):
- `tests/price-resolution.test.js` — every precedence tier, division/version/
  cost_type tie-breaks within tiers, effective-date windows, uom mismatch, ambiguity
  (never auto-pick), expired-vs-missing distinction.
- `tests/po-generation-math.test.js` — vendor grouping, lump-sum vs unit line
  totals, option merge, fingerprint stability (order-independence) and sensitivity
  (qty/price/option changes), budget-line grouping = PO totals.
- `tests/vpo-approval-thresholds.test.js` — band selection incl. boundary values,
  negative/backcharge totals, null-infinity band, default-settings parse.
Existing suite must stay green — this doc touches committed-cost inputs
(commitment_type additive only) and the bill path (new rows, no changed logic).
Manual regression before merge (financials rule): on a QA-org commercial project,
subcontract CCO approve + vendor-bill pay flows byte-identical pre/post.

## Open questions

1. **UOM conversion** (sf↔sy, lf↔ea): v1 refuses with `uom_mismatch`. Is a
   per-cost-code conversion table worth it, or do we force takeoff and book to agree
   on uom (recommended: force agreement; conversion tables rot)?
2. **Ambiguous-tie policy:** always exception, or allow an org setting "preferred
   vendor per cost code per community" as a standing tie-break? (Lean: ship the
   exception, add the preference only if real usage demands it.)
3. **PO issuance ceremony:** production builders often issue POs without signatures
   (the PO doc IS the contract). Default POs to auto-`approved` on generation for
   pay-on-PO communities, or keep draft→approve? (Doc specs draft→approve; revisit
   with the pilot builder — flip is a one-line service default.)
4. **Partial completions granularity:** per-line array now; do trades need
   percent-of-line (e.g., 50% of framing)? Deferred — per-line is the industry norm
   for production trades.
5. **Backcharge mechanics** — RESOLVED with WS07: two distinct rails by phase.
   Construction-phase back-charges (house still open, PO still live) are negative
   VPOs here (`is_backcharge=true`, reason `back_charge`). Post-closing WARRANTY
   backcharges ride WS07's vendor-credit rail (negative vendor_bills with
   commitment_id attribution) and never touch commitment_change_orders — a
   negative CCO on a closed house would corrupt historical committed cost and
   this doc's variance benchmark math (WS07 §7 has the full reasoning).
6. **`purchasing_settings` vs a future generic `org_settings`:** if WS08/09 grow
   more settings singletons, consolidate then; do not build the generic table now.

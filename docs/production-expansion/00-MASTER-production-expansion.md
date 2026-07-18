# Production Expansion — Master Gameplan

> **Audience:** an LLM executing agent. Read this file FIRST, fully, before opening any
> workstream doc. Every workstream doc in this folder assumes you have internalized the
> rules and context here. Do not skip to the code. This suite is the successor to
> `docs/commercial-expansion/` — that folder's `00-MASTER` and `09-platform-deferred-and-production.md`
> are prerequisite reading; their rules still apply unless overridden here.

## 1. Mission

Arc serves residential/custom builders (live) and commercial GCs (shipped July 2026).
We are now expanding to **production homebuilders**: builders of repeatable homes in
communities — spec + to-be-built, plan libraries, option catalogs, volume purchasing,
even-flow starts. This is the third and final posture reserved by the commercial
master plan:

| Tier key | Working name | Segment | Status |
|---|---|---|---|
| `residential` | Arc | Custom-home builders | Live |
| `commercial` | Arc Commercial | Commercial GCs | Shipped (QA hardening ongoing) |
| `production` | Arc Production | Production/volume homebuilders | THIS gameplan set |

**Target segment (two rings, one product):**

- **Core ring:** private/regional builders at **~25–250 closings/yr** — squeezed between
  Buildertrend (no price book, no auto-PO, no even-flow; wall at ~50 units) and
  MarkSystems/NEWSTAR-class ERPs (implementation-heavy, despised legacy UX, defended
  only by switching costs). This is Arc's existing buyer profile one notch up.
- **Outer ring:** large private builders with **divisions across states and multiple
  legal entities/accounting files**. We design the org model and accounting layer for
  them from day one (divisions, multi-entity), even though the first customers land in
  the core ring. Nothing in this suite may assume "one org = one state = one set of books."

**Production building is manufacturing, not projects.** The unit of work is the **lot**
inside a **community**, built from a **plan** (floor plan × elevation × swing × options),
purchased from **unit-price catalogs**, released on an **even-flow calendar**, and sold
via a per-community **sales pipeline** ending in a **closing**. Estimating happens once
per plan; each house's budget and PO set are *generated*, and any dollar spent after
start release is a **variance PO (VPO)** — the single most watched cost metric in the
industry (target ≤1–2% of direct cost).

**North-star pitch:** "The production ERP rebuilt as modern software: price book →
auto-PO → even-flow → community P&L, with accounting your controller doesn't hate, at a
price that doesn't require a NEWSTAR implementation." Sellable ROI wedges: VPO reduction
(~2% of revenue leaks, mostly untracked), start-package/even-flow discipline (cycle time
= capital turns), warranty backcharge recovery, and (later) rebate capture.

## 2. The two-level posture model still rules

Everything from `docs/commercial-expansion/00-MASTER` §1 carries over verbatim:

- **The PROJECT is the unit of posture.** `projects.property_type` gains a `production`
  value (enum migration). A production-posture project = a **job/house on a lot**. Posture
  drives terminology, sidebar modules, and financial defaults. Mixed orgs are normal —
  a builder can run custom homes and a 60-lot community side by side.
- **The ORG tier** (`orgs.product_tier` — `production` value already valid) sets defaults,
  org-surface vocabulary, and packaging. Never a capability gate, never a data gate.
- **Terminology is the single noun choke point** (`lib/terminology.ts`). Production rows
  already exist: Owner→**Buyer**, Contract→**Purchase agreement**. This suite adds:
  Client portal→**Buyer portal**, and new production-only nouns (Lot, Community, Plan,
  Start, Closing) which are NOT terminology-swapped — they are new first-class concepts.
- **Never write `if (posture === 'production')` inline.** All posture behavior routes
  through `getProjectPosture()`, `getOrgProductTier()`, `terminology(posture)`, nav
  config (`components/layout/project-nav-items.ts` `postures:` field), and
  `getProjectFinancialFeatureConfig()` (`lib/financials/billing-model.ts`).
- **No `production_*` names for neutral capabilities.** Divisions, budget templates,
  accounting abstraction, template bundles, price agreements — all of these help
  residential/commercial too and get neutral names. Domain terms that ARE the production
  domain (communities, lots, house plans, starts, closings) keep their real names.

## 3. What already exists (do NOT rebuild)

Verified against the **live production schema** (258 tables, PostgREST introspection,
2026-07-16) and the service layer. Reuse these:

- **Commitments spine** — `commitments` (+`commitment_type` text column already exists),
  `commitment_lines`, `commitment_sov_lines`, `commitment_change_orders` (+ lines),
  subcontract doc generation, e-sign. POs, VPOs, and pay-on-PO all ride this spine.
- **Selections** — `selection_categories` (has `is_template`), `selection_options`
  (already has `sku`, `vendor`, `lead_time_days`, `price_cents`, `price_delta_cents`,
  `is_default`, `is_available`, image/file), `project_selections` (status, due_date,
  confirmed_at, metadata jsonb). Deliberately preserved during commercial work as the
  1:1 seed of the production option catalog. Evolve — do not replace.
- **Allowances** — `allowances` links contract + selection_category with budget/used;
  reference for option-price bookkeeping.
- **Templates** — `schedule_templates` (org-scoped, `items` jsonb, keyed by
  project_type/property_type), `estimate_templates`, `checklist_templates`,
  `esign_templates`, `form_templates`, inspection templates. There is **no
  budget_templates** table — workstream 02 creates it.
- **Bid/buyout spine** — bid_packages → invites → sub bid portal → leveling → award →
  `run_bid_award_conversion` RPC auto-creating a commitment with SOV. Reference for
  plan/community-level bidding and for start-release orchestration RPCs.
- **Budget engine** — budgets/budget_lines, committed/actual/pending, EAC/CTC/VAC,
  `variance_alerts` (threshold alerts — note: this name is TAKEN; VPOs are a different
  concept and live on the commitments spine), budget transfers + contingency.
- **Field suite** — schedule (+typed dependencies/lag/baselines), daily reports
  (+manpower/delays/equipment), inspections, quality checklists, punch (ball-in-court),
  safety, photos, drawings pipeline (canonical one-set-per-project), tasks.
- **Warranty** — `warranty_requests` with assigned-company dispatch email. Workstream 07
  extends to volume service ops; the dispatch pattern is the seed.
- **Portals** — `portal_access_tokens` + `external_portal_accounts`; client portal
  `app/p/[token]` (becomes Buyer portal), sub portal `app/s/[token]` (grows the trade
  confirm→complete loop), bid portal, e-sign flows.
- **Financial rails** — invoices (unified status engine, atomic create), payments +
  Stripe, vendor_bills + `bill_lines`, payables email ingest, draw_schedules, contracts
  (rich: contract_type, retainage_schedule, snapshot jsonb), lien waivers, retainage.
- **CRM/pipeline** — prospects, opportunities, conversions. Workstream 06 builds
  per-community sales on top, not beside.
- **Infra** — events, audit_log, outbox (+dedupe/claims), job_runs + CRON_JOBS registry,
  RBAC catalog-as-code, `membership_project_scope`, feature_flags, search_index,
  notifications (+EMAIL_NOTIFICATION_TYPES allowlist), mobile API `/api/mobile/v1`.
- **Reporting seam** — `lib/services/reporting-scope.ts`; rollups must stay
  parameterizable by explicit project-id sets. Community/division rollups are scoped
  desk queries, not new aggregation frameworks.

## 4. Live-schema naming collisions (bind on all docs)

Checked against production 2026-07-16. These names are TAKEN — do not create tables,
types, or service files that collide:

| Wanted name | Taken by | Use instead |
|---|---|---|
| `plans` | Stripe subscription plans (billing) | **`house_plans`** (+ `house_plan_elevations`, `house_plan_versions`, `house_plan_options`) |
| `variance_alerts` | Budget threshold alerts | VPOs = `commitment_change_orders` extension (workstream 04); the report is "variance analysis" |
| `entitlements` | Billing plan entitlements | Land entitlement status is a column/enum on lots, not a table |
| `contracts` | Prime contracts (reused!) | Purchase agreements = `contracts` rows with `contract_type = 'purchase_agreement'` |
| `draw_schedules` | Owner-draw billing schedule | Lot takedown schedules = `lot_takedowns` |
| `phases` (unused but ambiguous) | — | `community_phases` |

## 5. The production data model — canonical shape

This is the target entity graph. Workstream docs own the exact DDL; disagreements
resolve in favor of THIS section.

```
orgs
 └─ divisions                    (optional layer; null division = "main")
     └─ communities
         └─ community_phases     (lot releases / takedown tranches)
             └─ lots             (land records; exist BEFORE any house)
                 └─ projects     (the job/house: 0..1 per lot, property_type='production')

house_plans ── house_plan_elevations
     └─ house_plan_versions      (immutable once released; lot pins its version)
           ├─ budget template ref     (workstream 02 — net-new budget_templates)
           ├─ schedule template ref   (existing schedule_templates)
           ├─ checklist/inspection template refs
           ├─ drawing source set ref
           └─ takeoff lines           (qty × uom per cost code — priced by price book)

community_plan_availability      (which plans/elevations sell where, base price per community)
option catalog                   (evolved selection_* tables: org/community catalog,
                                  structural vs design_studio scope, plan applicability,
                                  cost + price, packages)
vendor_price_agreements          (vendor × cost code [× plan] [× community/division],
                                  unit pricing, effective dates, source bid)
start packages                   (gate record per lot: permit, plot plan, selections
                                  locked, budget generated, POs generated, approval)
community_release_slots          (even-flow calendar: target starts per week per community)
closings                         (the revenue event per project)
accounting_connections           (provider-agnostic, MANY per org, entity-mapped —
                                  replaces the one-active-qbo-connection-per-org model)
```

**Load-bearing decisions (every doc must honor these):**

1. **The lot is a land record, not a project.** `lots` exist from land
   acquisition/takedown onward — before a buyer, before a start, sometimes before the
   builder owns them (controlled via option). A `projects` row (the job) is created at
   or near start release and linked `lots.project_id`. This keeps the project atom
   intact (doc 09's constraint) while giving land pipeline, spec inventory, and sales a
   home that doesn't pollute `projects` with 300 not-yet-started rows.
2. **Divisions are a light scoping layer, not a tenant boundary.** `divisions` carry
   name/code/region/settings; `communities.division_id` and (denormalized)
   `projects.division_id` scope desks, reports, RBAC (a `membership_division_scope`
   analogous to `membership_project_scope`), and accounting-entity mapping. RLS stays
   org-based; divisions filter, never isolate. Orgs without divisions never see the
   concept (null division everywhere, zero UI).
3. **Plan versions are immutable once released.** Re-pricing or value-engineering a plan
   creates a new version; in-flight lots keep the version they started with. Version
   drift is reportable, never silently propagated.
4. **The budget is a derived artifact.** Start release generates the lot budget from
   (plan-version takeoff × price book) + options. Nobody hand-builds a production
   budget; hand edits after generation are variances.
5. **POs are commitments; VPOs are commitment change orders with reason codes.** No
   parallel PO tables. Pay-on-PO auto-creates a `vendor_bills` row from the approved
   completion (source-flagged), so AP rails and accounting sync reuse the existing path.
6. **Purchase agreements are contracts.** Buyer contract = `contracts` row
   (`contract_type='purchase_agreement'`) on the lot's project; price = community base
   price + lot premium + structural options + design selections + change orders. One
   closing invoice at settlement; no draws, no SOV, no retainage in the buyer flow.
7. **Accounting entity mapping is a layer, not columns.** `projects.qbo_class_id`
   and `qbo_customer_id` inline columns are the legacy shape; workstream 08 introduces
   `accounting_connections` (many per org) + an entity/dimension mapping keyed by
   division/community/project. New production code must not write new `qbo_*` columns
   anywhere (standing rule since commercial doc 09).
8. **Enforcement is the product.** Selection cutoffs are *derived* from the lot's
   schedule (offset from a named template task), and hard-block edits past cutoff —
   forcing a fee-bearing change order that flows to purchasing as a VPO and to the
   schedule. Start packages hard-gate release. Even-flow release slots make over/under-
   starting visible. Where the industry's discipline erodes, Arc holds the line.

## 6. Workstream index and dependency order

| # | Doc | Contents | Depends on |
|---|---|---|---|
| 01 | `01-foundation-divisions-communities-lots.md` | `production` property type + posture wiring, `divisions`, `communities` + phases, `lots` (land pipeline: status, takedowns, deposits, premiums), community workbench shell, nav, rollup scoping, RBAC roles/permissions for new personas | — |
| 02 | `02-plan-library-template-bundles.md` | `house_plans`/elevations/versions, plan takeoff lines, **`budget_templates` (net-new, neutral)**, template bundling, community plan availability + base pricing, plan drawing source sets, instantiation engine (plan version → lot artifacts) | 01 |
| 03 | `03-option-catalog-design-studio.md` | Catalog lift of selection_* (org/community catalog, structural vs design-studio, plan applicability pricing, packages), buyer selection flow with **schedule-derived cutoffs + hard enforcement**, post-cutoff fee-bearing COs, design-studio appointment views | 01, 02 |
| 04 | `04-purchasing-price-book-pay-on-po-vpo.md` | `vendor_price_agreements` (price book), plan/community-level bid packages + rebid, **auto-PO generation at start release**, pay-on-PO (completion-triggered payment, no vendor invoice), VPO workflow (field capture, reason codes, approval hierarchy, variance reporting), trade confirm→complete loop in sub portal | 01, 02, (03 for option POs) |
| 05 | `05-starts-evenflow-scheduling.md` | Start packages + gates, start-release orchestration (outbox pipeline: budget + POs + schedule + checklists), even-flow release board + `community_release_slots`, superintendent multi-house views ("My Houses", task-type-across-lots), trade look-aheads/notifications, cycle-time + even-flow reporting | 01, 02, 04 |
| 06 | `06-sales-contracts-closings.md` | Per-community sales pipeline (spec inventory + TBB), price sheets (base + lot premium + options), purchase agreements via contracts + e-sign, incentives, buyer management, closings (settlement, revenue event, accounting posting), buyer portal reshape of `app/p` | 01, 02, 03 |
| 07 | `07-warranty-service-at-volume.md` | Service department ops: intake → queue → dispatch (tech or trade) → **trade backcharge tied to originating PO**, SLAs, recurring-defect analytics by plan/trade feeding purchasing, buyer-portal warranty flow | 01, 04 (PO linkage), 06 (closed homes) |
| 08 | `08-accounting-abstraction-multi-entity.md` | Provider-agnostic accounting layer: `AccountingProvider` interface extracted from `qbo-sync.ts`, `accounting_connections` (many per org) + entity/dimension mapping (division/community/project), migration of qbo_* tables/columns, QBO adapter first, second adapter target (Sage Intacct) speced not built | — (platform track; 01 consumes its mapping) |
| 09 | `09-onboarding-provisioning-migration.md` | Onboarding a big builder end-to-end: provisioning flow (org → divisions → accounting connections → cost codes → plan library → price book → communities/lots → open-WIP migration for in-flight houses → team/RBAC), importers (CSV + AI-assisted from MarkSystems/NEWSTAR/Buildertrend exports), phased go-live playbook (pilot community/division), admin tooling | all (executes last, drafts early) |

**Execution order:** 08 and 01 start in parallel (08 is platform work everything
financial rides on; do the interface extraction + multi-connection before 04/06 post
money). Then 01 → 02 → {03, 04} → 05 → 06 → 07. 09 is drafted alongside 01 and executed
against real onboarding.

**Wedge checkpoints** (shippable slices for early customers):
- After 01+02+05: "communities, starts, and even-flow in Arc" (purchasing stays in
  spreadsheets) — a credible pilot for a 25–75/yr builder.
- After 04 (even partial): **field VPO capture + weekly variance report** — the
  strongest standalone wedge; onboards the builder onto the commitments spine.

## 7. Non-negotiable repo rules (recap + production additions)

`CLAUDE.md` at repo root is authoritative. Highlights plus production-specific rules:

1. **Search first** (~130 services, ~440 components); duplicating a capability is a defect.
2. **Services own business logic:** `requireOrgContext()` → `requirePermission()` →
   logic → `recordEvent()` + `recordAudit()` → mapped DTO. Actions thin, Zod-validated,
   returning `{ success, error }` / `ActionResult`.
3. **Every query scoped by `org_id`.** Division/community are filters on top, never a
   substitute.
4. **Integer cents everywhere.** Price book unit costs, option prices, lot premiums,
   incentives — all `*_cents`.
5. **Design language:** tokens only, radius 0, no heroes/marquees, shadcn primitives,
   dense tables, tabular-nums. Community lot grids and release boards are dense
   editorial tables/grids, not card walls. Every view: empty/loading/error + dark mode.
6. **Desk/workbench doctrine.** New desks must pass the "whole JOB" test — Purchasing
   desk (purchasing manager), Starts desk (starts coordinator), Sales desk (sales
   manager), Warranty desk (service manager), and "My Houses" (superintendent, extends
   My Work) all pass. Community workbench is a workbench: mutations live there or in
   the lot (project) workbench, exactly one home each.
7. **Unbounded lists get pagination/caps day one.** 400-lot communities and 200-active-
   project orgs are the DESIGN CASE, not the stress case: audit every org desk, search
   surface, and dashboard rollup you touch for scale.
8. **Cron/webhook rules:** GET handlers, `PUBLIC_API_ROUTES` in `proxy.ts`,
   CRON_JOBS registry mirrors `vercel.json`.
9. **New entity types registered** in search index, events, notifications allowlist
   (only if they should EMAIL), mobile API where field-relevant, and RBAC catalog
   (`supabase/migrations/*rbac_catalog_seed*` pattern — catalog-as-code).
10. **Migrations:** additive, org-scoped, RLS with `(SELECT auth.uid())` initplan
    pattern, applied via `supabase/migrations/` only. This repo's local env POINTS AT
    PRODUCTION — never test-mutate.
11. **New personas become assignable roles** in the RBAC catalog: purchasing manager,
    starts coordinator, design studio coordinator, warranty/service manager,
    superintendent (exists conceptually — verify scope), sales agent. Follow the
    bookkeeper/estimator assignable-role pattern.
12. **Leave no trash.** Anything obsoleted (e.g., inline qbo columns after 08's mapping
    layer, selection template duplication after 03's catalog) is migrated and deleted
    in the same workstream, with a documented cutover.

## 8. Onboarding doctrine (summary — doc 09 owns the detail)

Production builders arrive BIG: divisions in multiple states, multiple legal
entities/accounting files, hundreds of in-flight houses, an existing plan library and
price book in spreadsheets or a legacy ERP. Onboarding is a product surface, not a
services engagement:

- **Provisioning order:** org → divisions → accounting connections (one per entity,
  entity-mapped to divisions/communities) → cost codes → plan library import → price
  book import → communities/phases/lots import → open-WIP cutover → team + RBAC → pilot
  community go-live → division-by-division rollout.
- **Open-WIP cutover rule:** in-flight houses import at *current state* — budget
  snapshot + open PO balances + remaining schedule — never reconstructed history. The
  first fully Arc-native house per community is the real go-live.
- **Importers are first-class admin tooling** (extend `/admin/provision`): CSV templates
  for every entity plus AI-assisted mapping from MarkSystems/NEWSTAR/Buildertrend
  exports. Every importer is idempotent and dry-runnable.
- Big builders on Sage Intacct/NetSuite can go live with accounting UNCONNECTED
  (Arc-native job cost, CSV/journal export) — the abstraction (08) makes connecting an
  adapter later a config change, not a migration.

## 9. Market facts the docs may cite (dated 2025–26, from the July 2026 research pass)

- Cycle time (start→close) is the north-star ops metric; current normalized ~120–130
  days for spec/production homes.
- VPO/variance benchmark: keep to ~1–2% of budgeted direct cost; track by $ AND
  incidence per reason code; ≥90% of true variance cost hides in overhead.
- Even-flow: constant weekly starts per community (100/yr ≈ 2/wk); a 100/yr builder
  carries ~18 houses in precon + ~40 under construction.
- A superintendent runs 10–15 concurrent houses; supers live on mobile.
- Design-studio cutoffs keyed to construction stage; post-cutoff = refusal or fixed CO
  fees ($250–500 typical).
- Pay-on-PO: the PO is the contract; verified completion triggers payment; no vendor
  invoice exists in the loop (Hyphen BuildPro/SupplyPro model; SupplyPro charges the
  trades — Arc's free token portal is a competitive angle).
- Margin managed by community AND by plan; NAHB 2023: GM 20.7% avg / 29.7% top quartile.
- Warranty: "1-2-10" structure; ~0.7–1.0% of revenue; backcharges against the
  originating trade PO.
- Land: lots controlled via options/takedowns (deposits ~10–20%); finished-lot delivery
  dates feed the starts calendar.

## 10. Deferred (explicitly NOT in this suite)

- **Second accounting adapter implementation** (Sage Intacct/NetSuite) — 08 specs the
  interface and proves it with the QBO adapter + a stub; building adapter #2 is its own
  future workstream driven by a real customer.
- **Rebate capture module** (PO↔SKU matching against manufacturer programs) — noted as
  a differentiator in 04; not built.
- **Land development cost tracking** (horizontal development budgets) — lots carry
  basis/premium/deposit fields; full lot-development job costing is future.
- **BTR (build-to-rent) operate-side** — the build workflow works for BTR as-is.
- **Trade-side network app** (SupplyPro competitor as a standalone product) — the sub
  portal loop in 04 is the seed; a trade-facing multi-builder surface is future.
- **P6/MSP interchange, SSO/SAML, customer API** — still deferred from commercial 09.

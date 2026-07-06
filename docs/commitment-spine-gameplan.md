# Commitment Spine Gameplan

Unify precon (bids/estimates), commitments, change orders, compliance, and payables so
vendor cost has one spine — the **commitment** — exactly the way revenue already has one
spine (the contract). This closes the sold-but-never-bought gap on change orders, makes
buyout visible on the budget, collapses duplicate vendor entry points, and fixes a real
compliance-gating bug.

**Status: not started.** Written 2026-07-05 after a full review of the as-built system.

---

## 0. Context an implementer must internalize first

### 0.1 What already exists and MUST be reused (do not rebuild any of this)

| Capability | Where | Notes |
|---|---|---|
| Bid award → commitment + project_vendor, transactional | `lib/services/conversions.ts` `runBidAwardConversion` → RPC `run_bid_award_conversion`; called from `lib/services/bids.ts` `awardBidSubmission` | The gold-standard conversion pattern (conversion_runs + steps). |
| Estimate → contract + budget on acceptance | `lib/services/conversions.ts` `runProposalAcceptanceConversion` → RPC | Revenue-side mirror of what we're building. |
| Commitment CRUD + lines + envelope execution | `lib/services/commitments.ts` (incl. `markCommitmentExecutedFromEnvelope`) | Lines coded to `cost_code_id`/`budget_line_id`; total syncs from lines. |
| Budget committed rollup — ALREADY READS commitment COs | `lib/services/budgets.ts` ~lines 725–935 | Reads `commitments`, `commitment_lines`, `commitment_change_orders` (approved AND pending exposure), commitment-linked `vendor_bills`. Computes `committed_cents`, `committed_billed_cents`, `remaining_commitment_cents`. |
| Budget tab "remaining to buy" | `components/financials/budget-tab.tsx` (`remainingToBuyCents = max(0, budget − committed)`, ~line 793/1197) | Dollars of buyout already shown; procurement *status* is not. |
| Client CO lifecycle + budget posting | `lib/services/change-orders.ts` — approval posts budget revisions per line coded with `cost_code_id`/`budget_line_id`; portal + envelope + manual/offline approval paths | CO↔invoice linking via `metadata.source_change_order_id` is the linking pattern to copy. |
| Unified e-sign | `lib/esign/unified-contracts.ts` (entity enum), `lib/services/envelopes.ts`, `components/esign/envelope-wizard.tsx`, execution routing in `app/api/jobs/process-outbox/route.ts` | Existing per-entity execution handlers: `approveChangeOrderFromEnvelopeExecution`, `executeEstimateFromEnvelopeExecution`, `acceptProposalFromEnvelopeExecution`, `markCommitmentExecutedFromEnvelope`. |
| Compliance data layer (single source of truth) | `lib/services/compliance-documents.ts` (types, per-company requirements, waivers, upload, review, `getCompanyComplianceStatus[WithClient]`, `getCompaniesComplianceStatus`), org rules in `lib/services/compliance.ts`, reminders in `compliance-autopilot.ts` | UI is scattered (directory, company detail tab, payables, sub portal) but the data layer is already unified. Keep it. |
| Payment compliance gate (buggy, see 0.2) | `lib/services/vendor-bills.ts` ~lines 664–696 | Server-side block on paid/partial. |
| Sub portal | `app/s/[token]` + `components/portal/sub/*` | Subs see commitments, submit invoices, upload compliance docs, waivers. |
| Project vendors | `lib/services/project-vendors.ts`, written by bid award RPC + `components/projects/manage-team-sheet.tsx` | Thin; no permission checks on write (pre-existing; fix opportunistically). |

### 0.2 The gaps this gameplan closes

1. **`commitment_change_orders` + `commitment_change_order_lines` are DEAD tables.** Created in
   `supabase/migrations/20260617120000_commitment_budget_glow_up.sql` with full RLS, read by the
   budget rollup, but **no service, action, or UI writes them**. After any client CO, budget
   "committed" silently understates what we owe subs. (`commitment_sov_lines` and
   `vendor_bill_sov_allocations` from the same migration are also dead — those stay out of scope,
   see Non-goals.)
2. **Bids ↔ budget never touch.** `bid_packages` has no `cost_code_id`/`budget_line_id`. The budget
   line can't distinguish "not bid" from "out to bid" from "awarded, unsigned". No action to start
   a bid package or commitment from a budget line.
3. **Client CO ↔ sub CO severed.** No path from an approved client CO to the commitment CO(s) that
   buy the extra scope, in either direction.
4. **Compliance payment gate keyed off the wrong column.** `vendor-bills.ts:675-694` only resolves
   the company **through `commitment_id`**; a direct bill with `company_id` set but no commitment
   skips the doc check entirely.
5. **Two commitment birth paths with different data quality.** Bid award (rich, transactional) vs
   manual create on company page / project commitments page (title + total, no lines, no
   project_vendors upsert).
6. **No single per-project vendor view** joining project_vendors + commitments + compliance +
   billed/paid/retainage + waivers.
7. **Signing is portal-XOR-BYOD** with no way to ride the builder's own terms paper on an
   Arc-structured document.

### 0.3 Doctrine / invariants (enforce in review)

- Committed cost = executed/approved `commitments` + approved `commitment_change_orders`. Nothing else.
- One commitment-creation flow, used everywhere. Manual paths are the same form, not a lite version.
- Creating a commitment upserts `project_vendors`. The Vendors view must never miss a company with a commitment.
- Compliance status is always `getCompanyComplianceStatus*` from `compliance-documents.ts`, keyed by `company_id`. No parallel computation.
- Cost (commitment CO) and price (client CO) are separate documents. Arc links them and makes each a one-click consequence of the other; it never auto-creates one from the other.
- All new mutations: service in `lib/services/`, `requireOrgContext` → `requireAuthorization` → logic → `recordEvent` + `recordAudit` → mapped DTO. Actions return `{ success, error }`. Zod in `lib/validation/`. Every query `org_id`-scoped.
- Local dev hits PRODUCTION Supabase. Migrations via `supabase/migrations/` + MCP `apply_migration` only, with user approval. No test writes.

---

## Phase 1 — Compliance gate bug fix (ship first, independent)

**File:** `lib/services/vendor-bills.ts` (~lines 664–696, inside `updateVendorBill` status handling).

Change the paid/partial gate to resolve the company directly:

1. `companyId = existing.company_id`; if null and `existing.commitment_id` is set, fall back to the
   current commitment traversal (keeps legacy bills covered).
2. If `rules.block_payment_on_missing_docs` and a companyId resolved →
   `getCompanyComplianceStatusWithClient(supabase, orgId, companyId)`; throw
   `"Compliance documents required before payment"` when `!is_compliant`. Lien-waiver check unchanged.
3. Only gate companies that have requirements: `getCompanyComplianceStatus` already returns
   compliant when nothing is required, so no behavior change for suppliers with no requirements.
   Verify this by reading `getCompanyComplianceStatusWithClient` before shipping.
4. Mirror the same company resolution in the client-side `getPaymentBlockReason`
   (`components/payables/payables-workspace.tsx` ~line 1615) so UI and server agree.

**Verify:** unit-level reasoning + `pnpm lint`; manually: bill with company_id, no commitment,
missing required docs → payment blocked with real error message in toast.

---

## Phase 2 — Commitment change orders (activate the dead tables)

### 2.1 Validation — `lib/validation/commitment-change-orders.ts` (new)

```
commitmentChangeOrderLineInputSchema: {
  commitment_line_id?: uuid, cost_code_id?: uuid, budget_line_id?: uuid,
  description: string(min 2), quantity: number(>0, default 1), unit?: string,
  unit_cost_cents: int, sort_order?: int
}
commitmentChangeOrderInputSchema: {
  commitment_id: uuid, title: string(min 3), description?: string,
  lines: array(min 1)
}
```
Amounts can be negative (deductive COs). `amount_cents` per line = `round(quantity * unit_cost_cents)`
computed server-side; header `total_cents` = sum of lines. Match column names in
`supabase/migrations/20260617120000_commitment_budget_glow_up.sql` exactly (`amount_cents`,
`unit_cost_cents`, `quantity numeric`).

### 2.2 Service — `lib/services/commitment-change-orders.ts` (new)

Model on `lib/services/commitments.ts` + the lifecycle shape of `lib/services/change-orders.ts`.
Permissions: reuse `commitment.read` / `commitment.write` (already exist — verify in the
authorization service; do NOT invent a new permission unless approval needs to be separated later).

Functions:
- `listCommitmentChangeOrders({ commitmentId | projectId })` — header + lines + linked client CO
  (from `metadata.source_change_order_id`), plus company/commitment joins.
- `createCommitmentChangeOrder({ input })` — derives `project_id`/`company_id` from the parent
  commitment (never trust caller); inserts header + lines; status `draft`; event
  `commitment_change_order_created`.
- `updateCommitmentChangeOrder` / `deleteCommitmentChangeOrder` — draft/sent only; approved is immutable (void instead).
- `approveCommitmentChangeOrder({ id, note? })` — manual/offline approval: status → `approved`,
  `approved_at`, `approved_by`; event `commitment_change_order_approved`. **Do NOT mutate
  `commitments.total_cents`** — the budget rollup already reads approved CCO lines separately
  (`budgets.ts` ~782–935); adding to the commitment total would double count. Commitment DTO gets a
  derived `revised_total_cents` instead (see 2.4).
- `voidCommitmentChangeOrder({ id })` — status → `voided` (schema check constraint: draft/sent/approved/rejected/voided).
- `markCommitmentChangeOrderExecutedFromEnvelope(input)` — service-role client (no session), sets
  status `approved`, `executed_file_id`, `source_document_id`, `signature_envelope_id`,
  `metadata.executed_signature`, records audit + event. Copy
  `markCommitmentExecutedFromEnvelope` in `commitments.ts` nearly verbatim.

### 2.3 E-sign wiring

- Add `"subcontract_change_order"` to `unifiedSignableEntityTypeSchema` in
  `lib/esign/unified-contracts.ts`. Check whether the enum is mirrored in a DB check constraint or
  other zod schemas (`grep -rn "subcontract" lib/esign lib/validation supabase/migrations`) and update all mirrors + the
  signatures-hub label/route maps in `components/esign/signatures-hub-client.tsx`
  (route it to `/projects/[id]/commitments`).
- In the envelope-execution router in `app/api/jobs/process-outbox/route.ts`, add the
  `subcontract_change_order` case → `markCommitmentChangeOrderExecutedFromEnvelope`. Copy the
  existing `subcontract` case exactly (idempotency, error handling).

### 2.4 Derived revised totals

Wherever commitment totals are displayed, show `total_cents` (original) and
`revised_total_cents = total_cents + sum(approved CCO totals)`:
- `CommitmentSummary` DTO in `commitments.ts`: add `approved_change_orders_cents` +
  `revised_total_cents`, loaded via one `.in("commitment_id", ids)` query in both list functions
  (same pattern as the existing vendor-bill rollup there).
- Consumers to update: `components/commitments/project-commitments-client.tsx`,
  `components/companies/company-contracts-tab.tsx`, sub portal `sub-contracts-card.tsx` /
  commitments route under `app/s/[token]/commitments`, payables add-payable sheet if it shows
  commitment remaining.
- Vendor-bill over-billing checks (if any compare billed vs commitment total — grep
  `commitment_total_cents` in `vendor-bills.ts` and payables components) must use revised total.

### 2.5 UI — commitment detail, project workbench

In `components/commitments/project-commitments-client.tsx` (and its actions file
`app/(app)/projects/[id]/commitments/actions.ts`):
- Commitment detail gains a **Change orders** section: table (number/title, status, total, executed
  doc link), add-CO form matching the existing line-editor idiom used for commitment lines
  (cost code / budget line pickers, qty, unit cost).
- Row actions: Approve (manual), Send for signature (opens existing `EnvelopeWizard` with
  `source_entity: { type: "subcontract_change_order", id, project_id, title }` — copy the wiring
  at ~line 922 used for commitments), Void.
- Show Original / Approved COs / Revised in the commitment header.
- Empty/loading/error states + dark mode, density matching the page.

Sub portal: commitment view lists its COs read-only with executed doc links (extend the
data loader behind `app/s/[token]/commitments`).

### 2.6 The client CO ↔ sub CO bridge

Pattern to copy: CO↔invoice linking (`linkInvoiceToChangeOrder` in `change-orders.ts`,
`metadata.source_change_order_id`).

- Store `metadata.source_change_order_id` (client CO id) on commitment COs, and read it back in
  both directions. No schema change.
- Service: `listCommitmentChangeOrdersForClientCO({ changeOrderId })` and a
  `createCommitmentChangeOrderFromClientCO({ changeOrderId, commitmentId, lineOverrides })` helper
  that prefills lines from the client CO's lines (strip markup/tax: use raw
  `quantity × unit_cost` before `markup_percent`; amounts fully editable by the user before save).
- UI in `components/change-orders/change-order-detail-sheet.tsx`:
  - New "Sub cost" section: linked commitment COs with status/total; link-existing and
    create-new (pick commitment → prefilled lines) actions. Mirror the existing linked-invoices section.
  - After approval (and on viewing any approved CO), if CO lines touch cost codes/budget lines
    covered by an active commitment and no linked commitment CO exists → quiet inline notice:
    "Sold, not bought: no sub CO issued for this change." Derivation: client CO line
    `cost_code_id`/`budget_line_id` ∩ commitment line coding for non-cancelled commitments on the project.
  - Reverse direction: on an approved commitment CO, "Bill to client" action creates a **draft**
    client CO prefilled from its lines (user applies markup in the normal CO editor). Sets the same
    metadata link.
- Both directions create drafts only. Never auto-approve, never auto-send.

**Verify Phase 2:** `pnpm lint`; `pnpm test:financials`; manual: create CCO → approve → budget tab
committed for that line increases by CCO amount and pending CCOs show as pending exposure; envelope
path executes and flips status; client CO → issue sub CO → link visible both ways; voided CCO
drops out of committed.

---

## Phase 3 — Buyout on the budget page

### 3.1 Migration — `supabase/migrations/<ts>_bid_package_budget_link.sql`

```sql
alter table public.bid_packages
  add column if not exists cost_code_id uuid references public.cost_codes(id) on delete set null,
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;
create index if not exists bid_packages_budget_line_idx
  on public.bid_packages (org_id, budget_line_id) where budget_line_id is not null;
create index if not exists bid_packages_cost_code_idx
  on public.bid_packages (org_id, project_id, cost_code_id) where cost_code_id is not null;
```
Single-scope per package deliberately (matches trade packaging; a join table is a later upgrade if
multi-scope packages are demanded). Check `list_tables` for actual `bid_packages` columns before
writing; save SQL to the repo AND apply via MCP with user approval.

### 3.2 Service

- `lib/services/bids.ts`: accept + persist `cost_code_id`/`budget_line_id` on package
  create/update (extend the zod schema in `lib/validation/` for bids); include them in the
  package DTO.
- New `getProjectBuyoutStatus(projectId)` (put it in `bids.ts`): returns, per
  `budget_line_id`/`cost_code_id`: linked packages with `{ id, title, status, invited_count,
  submitted_count, awarded_commitment_id }`. One query over `bid_packages` + counts over
  `bid_invites` (+ `bid_awards`). Keep it cheap: this loads with the budget page.
- Derived per-line procurement status (compute in the component, do not store):
  `committed > 0` → Bought (Executed if the commitment has `executed_at`, else Awarded);
  else linked package with award → Awarded; open package with submissions → Leveling;
  open package sent → Out to bid (n of m in); else → Not bid. Lines with zero budget or
  non-buyout categories (labor burden etc.) show nothing — follow whatever category semantics
  the budget tab already has.

### 3.3 UI — `components/financials/budget-tab.tsx` + budget page data loader

- Load buyout status alongside the existing breakdown (`Promise.all` in
  `app/(app)/projects/[id]/financials/budget/page.tsx` or its `page-data`).
- Per-line: small status text/chip next to the existing committed/remaining-to-buy figures,
  linking to the bid package. Calm, text-first, color-for-state only.
- Row actions (kebab): **Start bid package** — routes to the existing new-bid-package flow
  (`app/(app)/projects/[id]/bids/`) with `budget_line_id`/`cost_code_id` + carried amount
  prefilled via search params; **Create commitment** — opens the unified commitment form
  (Phase 4) with one line prefilled from the budget line.
- Carried budget amount surfaces on the bid package detail + leveling view
  (`components/bids/bid-package-detail-client.tsx`) as "Budget: $X" next to submissions, with
  delta per submission. NOTE: both `bid-package-detail-client.tsx` and
  `bid-package-detail-client-new.tsx` exist — determine which is live, wire the live one, and
  **delete the dead one** in this phase (leave-no-trash rule).
- Prospect-born packages: when `awardBidSubmission` back-links a package to the project
  (`bids.ts` ~2213–2238), also map `cost_code_id → budget_line_id` if the project budget has a
  line for that code.

**Verify:** budget line → start package → invite → submit (portal) → award → line flips to
Awarded/Bought and committed matches; statuses correct for each stage; `pnpm test:financials`.

---

## Phase 4 — One commitment form + project Vendors view

### 4.1 Unify commitment creation

- Extract the create/edit commitment form out of `project-commitments-client.tsx` into
  `components/commitments/commitment-form-sheet.tsx`: project (fixed when launched from a
  project context), company, title, type, lines (cost code / budget line coded), retainage, dates,
  contract number, attach/send-for-signature.
- Use it from: project commitments page, budget-line "Create commitment" (Phase 3), company detail
  page (`components/companies/company-contracts-tab.tsx` — its current ad-hoc create UI is
  **deleted**, replaced by this sheet with a required project picker).
- `createCommitment` in `commitments.ts` upserts `project_vendors`
  (`role: 'subcontractor'` or derived from `companies.company_type`; skip if a row for
  org+project+company already exists). Bid-award RPC already does this — do not double-insert:
  check-before-insert on `(org_id, project_id, company_id)`.
- Opportunistic: add `requireAuthorization` to `project-vendors.ts` writes (it has none today).

### 4.2 Project Vendors view

Route: `app/(app)/projects/[id]/vendors/page.tsx` + nav entry in
`components/layout/project-nav-items.ts`. Read-mostly workbench-adjacent view; mutations deep-link
to their owners (commitments page, payables, company compliance tab).

Data: new `lib/services/project-vendor-overview.ts` — `getProjectVendorOverview(projectId)`:
one row per company on the project = union of `project_vendors` companies, commitment companies,
and vendor-bill companies. Per row: role/scope (project_vendors), commitments (count, original,
revised via Phase 2, executed?), compliance summary (`getCompaniesComplianceStatus` batch — one
call), billed / paid / retainage held (aggregate `vendor_bills`), waiver status counts, last
activity. All queries org+project scoped, batched (`Promise.all` + `.in(...)`), no N+1.

UI: dense table, one row per company; compliance as the same status treatment the directory uses;
money in tabular-nums; row expands or links: company → `/companies/[id]`, commitments →
commitments page filtered, bills → payables filtered. Empty/loading/error + dark mode.

**Verify:** company appears via each path (bid award, manual commitment, direct bill); numbers
reconcile with payables and commitments pages.

---

## Phase 5 — Compliance soft-gate at execution

- Org setting `warn_subcontract_execution_on_missing_docs` (extend `ComplianceRules` in
  `lib/services/compliance.ts` + settings UI where the other compliance rules live; default ON,
  warn-only. Add `block_...` variant default OFF).
- In the send-for-signature flows for commitments and commitment COs (EnvelopeWizard launch
  points), fetch compliance status for the counterparty company; if non-compliant: warn-mode shows
  an inline notice listing missing/expired docs with "send anyway"; block-mode disables send with
  the same list and a link to the company compliance tab. Server-side: enforce block-mode in the
  envelope-send action for these two entity types (client checks are advisory only).
- Surface compliance chip on commitment detail header (data already in Phase 4's batch service).

---

## Phase 6 — Exhibit-model signing (builder's own paper)

Prereq reading: `docs/esign-unified-system-gameplan.md`, `docs/esign-byo-docs-gameplan.md`,
`docs/documents-signatures-gameplan.md` — this phase must extend that system, not fork it.

- **Org contract templates:** storage = `documents`/`files` rows tagged via metadata
  (`{ contract_template_for: 'estimate' | 'change_order' | 'subcontract' | 'subcontract_change_order' }`)
  — check first whether org-level settings JSONB (the estimate-customization pattern) is a better
  fit than new columns; prefer whichever existing pattern the esign gameplans establish. Settings
  UI: "Contract templates" section, upload/replace/remove per type.
- **Assembly:** when sending a portal-signable entity (estimate, client CO) and a template exists
  for its type, the send flow offers "Attach standard terms" (default on once configured). The
  signing package = builder terms PDF + Arc-rendered structured exhibit
  (estimate/CO PDF renderers already exist — `renderEstimatePdfByToken` etc.). Signer sees both in
  one envelope/portal session; execution routes through the existing entity handlers so all
  automation still fires. Implementation detail depends on the portal-vs-envelope renderer: for
  portal signing, render the terms PDF inline above the exhibit; for envelope signing, concatenate
  or multi-document envelope per what `envelopes.ts` supports — investigate before committing.
- Same offer for subcontract / subcontract-CO envelopes (terms template + a rendered commitment
  exhibit; a minimal commitment PDF renderer may need to be added — keep it to the existing PDF
  stack).
- Explicitly NOT building: rich-text template editor, merge fields, clause library.

---

## Non-goals (do not build in this effort)

- SOV-based sub billing: `commitment_sov_lines` / `vendor_bill_sov_allocations` stay dormant until
  a customer needs pay-app-style sub billing. Do not delete them; note their dormancy here.
- Multi-scope bid packages (join table) — single scope link only.
- Auto-creation of sub COs from client COs or vice versa — drafts via explicit user action only.
- Per-project compliance requirement overrides — org+company level stays.
- New org-level desks. Everything lands in existing project workbenches + company/directory desks
  (scopes doctrine: `docs/navigation-scopes-refactor-gameplan.md`).

## Sequencing & verification gates

| Phase | Depends on | Gate before next |
|---|---|---|
| 1 Compliance keying fix | — | lint clean; manual payment-block check |
| 2 Commitment COs + CO bridge | — | `pnpm test:financials`; budget committed math verified incl. pending exposure; envelope execution path exercised |
| 3 Buyout on budget | 2 (revised totals) | full bid→award→budget-status manual pass |
| 4 Unified form + Vendors view | 2 (revised totals), ideally 3 | numbers reconcile across vendors/payables/commitments |
| 5 Execution soft-gate | 4 (batch compliance service) | warn + block modes exercised |
| 6 Exhibit signing | independent; after 2 for sub-CO coverage | portal + envelope executions still fire entity handlers |

Every phase: `pnpm lint` clean; empty/loading/error/dark-mode on new UI; mutations org-scoped +
permission-checked + event/audit; `{ success, error }` actions; anything replaced is deleted in the
same change. Migrations: write file in `supabase/migrations/`, apply via Supabase MCP
`apply_migration` **with explicit user approval** (production database).

## Key file map (quick reference)

```
lib/services/commitments.ts                      commitment CRUD, envelope execution, DTO (+revised totals)
lib/services/commitment-change-orders.ts         NEW — Phase 2
lib/services/change-orders.ts                    client CO lifecycle, budget posting, linking patterns
lib/services/conversions.ts                      bid award / proposal acceptance conversion runs
lib/services/bids.ts                             packages, invites, submissions, award (+buyout status)
lib/services/budgets.ts                          committed rollup (already reads commitment COs)
lib/services/vendor-bills.ts                     payment compliance gate (Phase 1 fix)
lib/services/compliance-documents.ts             compliance source of truth
lib/services/compliance.ts                       org compliance rules (+Phase 5 setting)
lib/services/project-vendors.ts                  project vendor registry (add authz)
lib/services/project-vendor-overview.ts          NEW — Phase 4
lib/esign/unified-contracts.ts                   signable entity enum (+subcontract_change_order)
app/api/jobs/process-outbox/route.ts             envelope execution router (+CCO case)
components/commitments/project-commitments-client.tsx   commitments workbench (+CO section)
components/commitments/commitment-form-sheet.tsx NEW — Phase 4 unified form
components/change-orders/change-order-detail-sheet.tsx  client CO sheet (+Sub cost section)
components/financials/budget-tab.tsx             budget workbench (+buyout status/actions)
components/esign/envelope-wizard.tsx             BYOD send flow (reuse as-is)
app/(app)/projects/[id]/vendors/                 NEW — Phase 4 Vendors view
supabase/migrations/20260617120000_commitment_budget_glow_up.sql   dormant schema being activated
```

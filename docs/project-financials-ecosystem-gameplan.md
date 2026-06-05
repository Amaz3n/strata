# Project Financials Ecosystem Gameplan

**Audience:** Future LLM implementation agents, founder/product review, and engineers working on Arc project financials.

**Purpose:** This is a current-state, repo-grounded plan for turning Arc financials into a trusted construction project financial operating system. It focuses on what Arc already offers, what must be improved, what is missing, what should be removed or de-emphasized, and how the pages/services need to integrate so a PM, GC, or controller would switch.

**Last reviewed from repo:** 2026-06-03.

---

## 0) Non-Negotiable Implementation Rules

Before changing financial code:

1. Read this document plus `docs/residential-financial-system-master-gameplan.md`.
2. Inspect current code. Several older docs are partially implemented and partially aspirational.
3. Treat money correctness as higher priority than UI polish.
4. Do not add a new financial page that computes its own truth if an existing ledger/service should own that truth.
5. Financial mutations must be org-scoped, project-scoped when applicable, permission-checked, audited, and evented.
6. Use integer cents for money.
7. Never edit billed/paid historical financial facts in place. Use adjustment, credit, revision, or void rows.
8. Every owner-facing billed cost must be traceable to source proof.
9. Every "ready to invoice" state must explain why the item is ready and why blocked items are not.
10. Avoid silent fallbacks that produce empty financial pages. Partial data must surface warnings.

---

## 1) Product Bar

Arc should make a financially responsible builder say:

> I can run job cost, AP, AR, cost-plus billing, fixed-price draws, forecasting, QBO handoff, and owner backup here without spreadsheets becoming the real source of truth.

The winning wedge is still **cost-plus / T&M billing with open-book proof**, but Arc must support the common residential models:

- Fixed price / lump sum.
- Cost plus percentage.
- Cost plus fixed fee / construction management fee.
- Cost plus GMP.
- Time and materials.

The strategic standard is not "has pages." The standard is **reconciles**.

---

## 2) Current Financial Surfaces

### 2.1 Project Financials Shell

Current routes:

- `/projects/[id]/financials`
  - Cost-driven workbench / Inbox.
  - Redirects fixed-price projects to billing-model landing page.
- `/projects/[id]/financials/budget`
  - Budget, commitments, forecast/WIP columns.
- `/projects/[id]/financials/payables`
  - Vendor bills, coding, approval, payment, QBO sync.
- `/projects/[id]/financials/receivables`
  - Invoices, draws, retainage.
- `/projects/[id]/cost-inbox`
  - Historical/parallel route still revalidated by Inbox actions.
- `/projects/[id]/time`
  - Time capture.
- `/projects/[id]/expenses`
  - Expense/receipt capture and QBO expense coding.
- `/financial-control`
  - Portfolio controller workspace.

Key files:

- `lib/financials/billing-model.ts`
- `app/(app)/projects/[id]/financials/page.tsx`
- `app/(app)/projects/[id]/financials/actions.ts`
- `app/(app)/projects/[id]/financials/page-data.ts`
- `components/cost-inbox/review-queue-table.tsx`
- `components/financials/budget-tab.tsx`
- `components/financials/payables-tab.tsx`
- `components/financials/receivables-tab.tsx`
- `components/financial-control/financial-control-client.tsx`

### 2.2 Existing Strengths

Arc already has meaningful financial foundation:

- Central billing-model helper with five target models.
- Cost Inbox states: blocked, needs review, awaiting client approval, ready to invoice.
- Unified `billable_costs` ledger for cost-plus sources.
- Time entries.
- Project expenses with receipt attachment and QBO expense sync metadata.
- Vendor bills with line coding, retainage fields, payment fields, lien waiver status, QBO fields.
- Commitments and commitment lines.
- Budgets, budget lines, budget revisions, cost-code progress, forecast columns.
- Draw schedules and retainage.
- Invoices, invoice lines, payments, payment links, AR/AP reports.
- Open-book portal invoice detail for billable-cost-backed invoice lines.
- Portfolio financial control page with AR, AP, ready-to-invoice, blocked, QBO exception queues.
- QBO connection/sync primitives for invoices, payments, bills, expenses.

### 2.3 Current Main Problem

Arc has many correct nouns, but not all pages derive from one coherent financial truth. The system is close enough that it can feel powerful, but it has split-brain risks:

- Budget actuals are primarily derived from approved/paid vendor bill lines, not the full cost-plus billable ledger.
- Time and project expenses can become billable ledger rows, but their relationship to Budget/WIP actuals is not clearly authoritative.
- Approved-cost invoice creation exists through multiple paths that are not fully normalized.
- Fixed-fee, GMP, paid-vs-incurred rules, billing backup packages, and period close are not first-class enough.

---

## 3) Source-Of-Truth Decisions

Implement these decisions before broad feature expansion.

### 3.1 Operational Project Financial Truth

Arc owns project financial operations:

- Contract billing model.
- Budget, commitments, cost codes, change-order financial impact.
- Cost capture and approval state.
- Billable cost ledger.
- Owner invoices and payment status.
- Job-cost forecast/WIP.
- Owner-facing proof.

QBO owns accounting close, tax/general ledger, and bank/account reconciliation unless a customer decides otherwise.

### 3.2 Ledger Truth By Domain

Use this source map:

| Domain | Authoritative Source |
|---|---|
| Owner billing from approved costs | `billable_costs` plus linked `invoice_lines` |
| Owner billing from draws | `draw_schedules` plus linked `invoices` |
| Owner billing from fee schedule | New fee ledger/schedule tables |
| Vendor/sub incurred cost | `vendor_bills` + `bill_lines` |
| Internal labor cost | `time_entries` and/or normalized job-cost ledger entries |
| Internal expense cost | `project_expenses` and/or normalized job-cost ledger entries |
| Job-cost actuals | A normalized cost actual ledger, or explicitly unified service over bills/time/expenses |
| Forecast | `project_cost_code_progress` or successor `forecast_lines` |
| Contract value | `contracts` + approved owner COs |
| Budget value | latest approved/active `budgets` + posted `budget_revisions` |
| Accounting sync state | local QBO IDs/status plus `qbo_sync_records` |

### 3.3 Required New Concept: Job Cost Actual Ledger

The existing `billable_costs` ledger is an owner-billing ledger. It should not be overloaded as the entire job-cost actual ledger because:

- Fixed-price projects need actuals without owner pass-through billing.
- Non-billable costs still matter for margin.
- Paid-vs-incurred rules matter.
- Time/expenses need to hit budget actuals even when not billable.

Add one of these:

Option A, preferred:

- `job_cost_entries`
  - `org_id`, `project_id`, `cost_code_id`
  - `source_type`: `vendor_bill_line`, `project_expense`, `time_entry`, `manual_adjustment`
  - `source_id`
  - `incurred_on`
  - `cost_cents`
  - `status`: `pending`, `approved`, `posted`, `voided`
  - `is_billable`
  - `billable_cost_id` nullable
  - `invoice_id` nullable
  - `metadata`

Option B:

- Keep separate source tables but create a single `getProjectCostActuals()` service and SQL view that unions approved vendor bills, approved expenses, approved/owner-approved time, and manual adjustments.

Do not keep Budget actuals dependent only on vendor bill lines.

---

## 4) Critical Current-State Findings

### 4.1 Billing Model Is Good But Not Complete

Current:

- `lib/financials/billing-model.ts` maps fixed, cost-plus percent, cost-plus fixed fee, cost-plus GMP, and T&M.
- `/projects/[id]/financials` uses the config to route fixed-price away from Inbox.
- Server actions block approved-cost invoicing for unsupported models in several paths.

Improve:

- Add explicit persisted project billing model rather than relying on `contracts.contract_type`, `gmp_cents`, and `contract.snapshot.billing_model`.
- Add project financial setup UI that validates model-specific required fields.
- Treat billing model as a rule layer for every action, not just routing and button visibility.

### 4.2 Cost Inbox Is The Right Centerpiece

Current:

- `loadFinancialsReviewQueueData` gathers cost-plus data, vendor bills, and cost codes.
- `ReviewQueueTable` combines time, expenses, vendor bills, and open billable costs into workflow states.
- Bulk coding, approval, rejection, client approval, and invoice creation exist.

Improve:

- Make "ready to invoice" stricter:
  - Approved by required party.
  - Cost coded.
  - Contractually billable.
  - Proof complete if contract requires proof.
  - Within open billing period.
  - Not already billed.
  - Paid by builder if contract requires paid-cost billing.
  - Not blocked by compliance/lien waiver rule if relevant.
- Show a reason column for every blocked and non-ready item.
- Add stable idempotency keys for invoice preview/confirm retries.
- Prefer a single authoritative approved-cost invoice service path.

### 4.3 Approved-Cost Invoice Creation Has Two Paths

Current:

- Inbox calls `generateInvoiceFromCostsAction` -> `generateInvoiceFromCosts`.
- Invoice composer can add "Approved costs" and then `createInvoice` calls `create_invoice_from_billable_costs_atomic`.
- Both rely on `billable_costs`.

Problems:

- Two code paths can drift in status, metadata, idempotency, QBO reservation, and portal visibility behavior.
- The application builds invoice preview totals and the RPC trusts the preview.
- Current schema snapshot and backup migration disagree on the RPC signature. Code calls extra params (`p_status`, `p_client_visible`, `p_notes`, `p_sent_to_emails`, `p_metadata`) from `lib/services/invoices.ts`, while `supabase/migrations/20260517092101_remote_schema.sql` shows the shorter signature. Verify live DB and migrations before touching this area.

Required work:

- Create one service for approved-cost invoices.
- Ensure the RPC recomputes or verifies line totals inside the transaction.
- Ensure the RPC signature in active migrations, `supabase/schema.sql`, and TypeScript callers match.
- Use stable idempotency keys.
- Add tests for double-submit, stale preview, cost already billed, and partial RPC failure.

### 4.4 Budget/WIP Is Not Yet Fully Trustworthy

Current:

- `getBudgetWithActuals` loads budget lines, approved commitments, approved/partial/paid vendor bills, sent/partial/paid/overdue invoices, approved COs, posted budget revisions, and project cost-code progress.
- It computes adjusted budget, committed, actual, invoiced, CTC, EAC, VAC, and gross margin.

Problem:

- Actuals are vendor bill lines. Approved time and approved project expenses are not clearly included unless they also became vendor bills or are represented elsewhere.
- Owner invoices are used for invoiced revenue, but cost-plus invoices include markup/fee; gross margin can be misleading if it compares owner billing against only vendor-bill actuals.
- Cost-plus billing ledger and job-cost actuals are not clearly reconciled.

Required work:

- Introduce `job_cost_entries` or a unified actuals service/view.
- Budget actuals must include approved vendor bills, approved expenses, approved time, and adjustments exactly once.
- Budget/WIP should separate:
  - Cost actuals.
  - Owner revenue billed.
  - Reimbursable cost billed.
  - Markup/fee billed.
  - Paid by owner.
  - Paid to vendors/subs.
- Add variance reason and forecast owner per cost code.

### 4.5 Cost-Plus Fixed Fee Is Mostly Missing

Current:

- `cost_plus_fixed_fee` exists in billing-model config and routes to Inbox.

Missing:

- Fixed fee amount.
- Fee billing schedule.
- Earned fee.
- Billed fee.
- Remaining fee.
- Fee invoice generation.
- Fee retainage if applicable.
- Fee forecast.

Required work:

- Add fee schedule tables and UI.
- Fee billing must be separate from reimbursable cost billing.
- Do not fake fixed fee as markup.

### 4.6 GMP Is Too Thin For Trust

Current:

- Contract has `gmp_cents`, savings split fields.
- `getGMPSnapshot` uses Budget EAC when available, else fallback over billable ledger/commitments.

Missing:

- Costs inside vs outside GMP.
- GMP-modifying vs non-GMP COs.
- Owner contingency and allowance rules.
- Exclusions.
- Paid/incurred treatment.
- Forecast confidence and risk.
- Savings/overrun handling by contract terms.

Required work:

- Add GMP classification to cost/CO/budget impacts.
- GMP forecast must use EAC, not simple actual/committed fallback except as a clearly labeled incomplete state.
- Show GMP warnings wherever users approve costs, COs, and invoices.

### 4.7 Open-Book Proof Exists But Is Not A Billing Package

Current:

- Client portal invoice page loads `listOpenBookCostDetailsForInvoice`.
- Portal invoice lines can show linked cost details, source type, source company, markup, status, and "Proof attached".

Missing:

- Downloadable billing backup package.
- Owner-facing proof file links directly from each line.
- Batch snapshot of what the owner saw.
- Excluded/non-billable items disclosure when appropriate.
- Prior-billed vs current-billed report.

Required work:

- Add billing package generation for cost-plus invoices:
  - PDF summary.
  - Source backup ZIP or packet.
  - Receipts/vendor bills/time tickets/photos.
  - Approval records.
  - Markup basis.
  - Cost code grouping.
- Store package metadata on invoice.

### 4.8 QBO Is Present But Needs Reconciliation Discipline

Current:

- QBO fields exist on invoices, vendor bills, project expenses.
- QBO sync records exist.
- Payables and expenses have QBO coding UI.
- Portfolio financial control surfaces QBO exceptions.

Improve:

- One reconciliation page/report:
  - Arc invoice vs QBO invoice status.
  - Arc payment vs QBO payment.
  - Arc vendor bill/expense vs QBO bill/expense.
  - Missing external IDs.
  - Sync errors.
  - Balance mismatches.
- Source-of-truth rule: QBO sync failures should not block field financial workflow, but should block "accounting clean" status.
- Store enough metadata to avoid duplicate pushes.

---

## 5) Absolutely Essential Features To Add

These are required for "hell yeah I can switch" financial confidence.

### 5.1 Project Financial Setup Wizard

Add a setup wizard reachable from project settings and Financials.

Sections:

- Billing model.
- Contract value and payment terms.
- Markup rules.
- Reimbursable rules.
- Owner approval rules.
- Open-book proof settings.
- Retainage/tax settings.
- Paid-vs-incurred billing rule.
- Fee setup for fixed-fee/CM projects.
- GMP setup for GMP projects.
- QBO class/customer/account mapping.

Acceptance:

- The wizard validates required fields by billing model.
- Financial pages show setup warnings until required fields are complete.
- Server actions enforce the same requirements.

### 5.2 Job Cost Actual Ledger

Add a job-cost actual source of truth.

Acceptance:

- Approved vendor bill line posts one actual.
- Approved project expense posts one actual.
- Approved time entry posts one actual.
- Voids/reversals create adjustment rows or void existing unbilled rows.
- Budget actuals use this source.
- No actual appears twice.

### 5.3 Billing Periods And Period Close

Add billing periods for cost-plus/T&M/GMP.

Fields:

- Project.
- Period start/end.
- Status: open, reviewing, invoiced, closed, reopened.
- Invoice IDs.
- Closed by/at.

Acceptance:

- Invoice from approved costs can target a period.
- Costs in a closed period cannot be edited in place.
- Late costs are flagged as late-to-period and can be included in next period or adjustment invoice.

### 5.4 Owner Approval Batches

Add cost approval batches beyond one-off time entry links.

Acceptance:

- PM selects costs/time/expenses and sends owner approval batch.
- Batch snapshot preserves descriptions, dates, amounts, markup, proof, and terms shown.
- Owner can approve/reject with comments.
- Approved batch releases rows to ready-to-invoice when contract requires owner approval.

### 5.5 Billing Backup Package

Add formal invoice backup.

Acceptance:

- Every cost-plus invoice can generate a backup packet.
- Owner portal can view and download backup.
- Packet includes receipt/vendor bill/time proof links or files.
- Packet records generation timestamp and package version.

### 5.6 Fee Billing

Add fixed-fee/CM fee functionality.

Tables:

- `project_fee_schedules`
- `project_fee_schedule_lines`
- `project_fee_billings` or invoice metadata links.

Acceptance:

- Fee invoice lines are separate from reimbursable costs.
- Fee schedule supports monthly, milestone, draw-based, percent complete, and manual.
- Financials show fee earned, billed, paid, remaining.

### 5.7 GMP Control Layer

Add GMP-specific financial controls.

Acceptance:

- Costs and COs can be classified inside/outside GMP.
- Forecast final cost is EAC-based.
- Savings/overrun calculations follow project contract settings.
- GMP burn visible in Budget, Inbox, CO approval, and Receivables.

### 5.8 Trust Center / Reconciliation

Add project-level "Trust Center" or "Financial Reconciliation" view.

Queues:

- Approved but unbilled costs.
- Costs billed without proof.
- Billable costs not reflected in job-cost actuals.
- Job-cost actuals not classified billable/non-billable.
- Vendor bills not tied to commitments.
- Payments not tied to invoices/bills.
- QBO sync errors.
- Budget actuals mismatch job-cost ledger.
- Retainage mismatch.
- Invoice totals mismatch line totals.

Acceptance:

- Each exception links to the source page.
- The page can reach zero exceptions.
- Portfolio financial control rolls these up across projects.

---

## 6) Features To Improve

### 6.1 Cost Inbox

Improve:

- Add "why blocked" reason model in the data service, not only client inference.
- Add proof completeness rules.
- Add paid-vs-incurred eligibility.
- Add billing period selection.
- Add client approval batch support.
- Add stable idempotency for invoice creation.
- Show recently billed with invoice link.

Remove/de-emphasize:

- Do not make Inbox the fixed-price landing page.
- Do not label ready-to-invoice as simply "approved"; approved is not the final billing state.

### 6.2 Budget

Improve:

- Use unified job-cost actuals.
- Add forecast ownership and last-updated metadata.
- Add manual CTC workflow that is not hidden in metadata.
- Separate internal cost actuals from owner invoiced revenue.
- Add over/under billing calculation by billing model.

Remove/de-emphasize:

- Avoid gross margin labels that imply accounting accuracy until cost/revenue sources are fully reconciled.

### 6.3 Payables

Improve:

- Make bill approval + job-cost post + billable-cost post transactional.
- Add commitment over-billing warnings.
- Add paid-cost billing eligibility when contract requires paid costs.
- Improve retainage release workflow.
- Strengthen lien waiver link to payments and releases.

### 6.4 Expenses

Improve:

- Approved expense should post to job-cost actuals and, when billable, billable-cost ledger.
- Add duplicate receipt detection.
- Add company-card import/bank feed later only after manual flow is solid.
- Make QBO coding optional for field approval but required for accounting clean state.

### 6.5 Time

Improve:

- Add labor rate tables:
  - Role rate.
  - Worker rate.
  - Cost rate.
  - Bill rate.
  - Burden.
  - Overtime/double time.
  - Effective dates.
- Approved time should post to job-cost actuals and, when billable, billable-cost ledger.
- Add weekly timesheet review.

### 6.6 Receivables

Improve:

- Normalize invoice-from-costs to one service.
- Add billing period and backup packet.
- Add fee schedule source.
- Add paid-vs-incurred warnings.
- Add owner approval snapshot links.

### 6.7 Change Orders

Improve:

- CO approval should always declare:
  - Contract value impact.
  - Budget impact.
  - Commitment impact.
  - Allowance impact.
  - GMP impact.
  - Billing status.
- Add explicit outside-GMP / inside-GMP classification.

### 6.8 Financial Control

Improve:

- Add trust-center exceptions.
- Add project forecast risk.
- Add costs paid but not billed.
- Add costs billed but owner unpaid.
- Add AP due before AR due.
- Add QBO balance mismatch, not only sync errors.

---

## 7) Features To Remove Or Avoid

Avoid:

- A generic financial overview that repeats Budget, AR, AP, and Inbox without decisions.
- Fixed-price projects using cost-plus Inbox as their default workflow.
- Markup-as-fixed-fee.
- Treating QBO as the UX model.
- Silent empty arrays on financial load failure.
- Editing billed cost rows directly.
- Using owner invoices as job-cost actuals.
- Using billable costs as the only actual-cost source for fixed-price projects.
- Building portfolio dashboards on weak project-level forecast math.

Consider cleanup:

- Retire or redirect older `/projects/[id]/cost-inbox` route if `/financials` is now the canonical Inbox.
- Consolidate approved-cost invoice creation into one service and one RPC.
- Rename ambiguous labels:
  - "Approved costs" -> "Ready to invoice" where applicable.
  - "Actuals" -> "Vendor bill actuals" until all actual sources are included.

---

## 8) Integration Map: How Pages Must Talk

### 8.1 Vendor Bill Flow

Target:

1. Vendor/sub submits bill or internal user creates payable.
2. Bill lines are coded to cost codes and commitment lines.
3. Approval posts job-cost actuals.
4. If billing model allows and line is billable, approval posts billable-cost rows.
5. Payables shows AP status.
6. Inbox shows billable rows as ready or blocked.
7. Budget shows actual cost.
8. Receivables can bill eligible rows.
9. QBO sync handles accounting.
10. Trust Center shows exceptions.

### 8.2 Expense Flow

Target:

1. Expense/receipt captured.
2. OCR suggests vendor/date/tax/amount/cost code.
3. PM approves.
4. Approval posts job-cost actual.
5. If billable, posts billable-cost row.
6. Inbox/Receivables can bill it.
7. QBO expense sync runs or remains accounting exception.

### 8.3 Time Flow

Target:

1. Worker/sub submits time.
2. Rates resolve by effective-date table.
3. PM approves.
4. Owner approval batch if required.
5. Approval posts job-cost actual.
6. If billable, posts billable-cost row.
7. Inbox/Receivables can bill it.

### 8.4 Cost-Plus Invoice Flow

Target:

1. Billing period opens.
2. Eligible approved costs accumulate.
3. Optional owner approval batch.
4. PM previews invoice.
5. Atomic invoice creation locks costs, creates invoice/lines, marks costs billed, stores backup snapshot.
6. Owner portal shows invoice + backup.
7. Payment updates AR and cash position.
8. QBO sync records accounting handoff.

### 8.5 Budget/WIP Flow

Target:

1. Budget starts as original.
2. COs post approved revisions.
3. Commitments create exposure.
4. Job-cost actuals update actual cost.
5. Forecast owner updates CTC/EAC.
6. Owner billings update revenue/over-under.
7. WIP report explains margin/cash risk.

---

## 9) Phased Implementation Plan

### Phase 0 - Verify Schema And RPC Drift

Goal: prevent agents from building on mismatched database assumptions.

Status as of 2026-06-03:

- Completed first pass against Supabase project `gzlfiskfkvqgpzqldnwk`.
- Confirmed live DB previously exposed only the old 15-argument `create_invoice_from_billable_costs_atomic` signature.
- Confirmed `lib/services/invoices.ts` calls the extended signature with `p_status`, `p_client_visible`, `p_notes`, `p_sent_to_emails`, and `p_metadata`.
- Added local migration `supabase/migrations/20260603190000_reconcile_approved_cost_invoice_rpc.sql`.
- Applied remote Supabase MCP migration `reconcile_approved_cost_invoice_rpc`.
- Verified live DB now exposes the extended 20-argument signature only.

Tasks:

- [x] Compare active `supabase/migrations`, `supabase/schema.sql`, and backup migrations for `create_invoice_from_billable_costs_atomic`.
- [x] Confirm whether live DB has the extended RPC signature.
- [x] Add a forward migration if active migrations do not define the extended signature used by `lib/services/invoices.ts`.
- Add tests around approved-cost invoice creation.

Acceptance:

- [x] Fresh DB migration produces RPC compatible with all TypeScript callers.
- [ ] Existing Inbox and invoice composer approved-cost paths both pass smoke tests.

### Phase 1 - Normalize Approved-Cost Invoice Path

Status as of 2026-06-03:

- Added shared service `lib/services/approved-cost-invoicing.ts`.
- Updated Inbox approved-cost invoice creation in `lib/services/cost-plus.ts` to call the shared service.
- Updated invoice composer approved-cost creation in `lib/services/invoices.ts` to call the shared service.
- Added local migration `supabase/migrations/20260603200000_verify_approved_cost_invoice_preview.sql`.
- Applied remote Supabase MCP migration `verify_approved_cost_invoice_preview`.
- Verified live RPC still exposes the extended 20-argument signature and now contains stale-preview, preview-cost-id, and recomputed-total guards.
- Local checks passed: `npm run db:schema:check`, `npx tsc --noEmit`.

Tasks:

- [x] Create `lib/services/approved-cost-invoicing.ts` or consolidate in `cost-plus.ts`.
- [x] Both Inbox and invoice composer call the same service.
- [x] RPC verifies/recomputes totals.
- [x] Stable idempotency key created at preview and reused at confirm.
- [x] Invoice status/client visibility/metadata behavior is identical across entry points.
- [ ] Add focused regression tests for double-submit, stale preview, and already-billed cost behavior.

Acceptance:

- [x] Double-click and network retry do not create duplicate invoices at the RPC/service layer.
- [x] Stale preview fails with a clear refresh message at the RPC layer.
- [x] Already-billed cost cannot be billed again at the RPC layer.
- [ ] UI smoke tests confirm Inbox and invoice composer render the new RPC errors cleanly.

### Phase 2 - Job Cost Actual Ledger

Status as of 2026-06-03:

- Added local migration `supabase/migrations/20260603210000_add_job_cost_entries.sql`.
- Applied remote Supabase MCP migration `add_job_cost_entries`.
- Added `job_cost_entries` with source-keyed idempotency, RLS, policy, indexes, and live backfill.
- Added service `lib/services/job-cost-actuals.ts`.
- Updated `lib/services/cost-plus.ts` so approval propagation posts job-cost actuals for vendor bills, expenses, and time; cost-plus/T&M projects still also post owner-billable costs.
- Updated `lib/services/vendor-bills.ts` so approved, partial, and paid vendor bills post actuals; reverting approved/partial/paid bills to pending voids job-cost entries.
- Updated `lib/services/budgets.ts` so Budget/WIP actuals use `job_cost_entries` instead of vendor bill lines only.
- Live verification found `job_cost_entries` table, RLS enabled, one access policy, indexes present, and no missing posted entries for eligible approved source rows.
- Live backfill produced posted actuals for vendor bill lines and project expenses. There were no eligible nonzero approved time entries in the current live data set.
- Local checks passed: `npm run db:schema:check`, `npx tsc --noEmit`.

Tasks:

- [x] Add `job_cost_entries` migration or SQL view + service.
- [x] Post actuals from vendor bill lines, expenses, and time.
- [ ] Add manual adjustment posting workflow.
- [x] Update Budget/WIP to use unified actuals.
- [x] Backfill from existing approved vendor bills, approved project expenses, approved time.

Acceptance:

- [x] Budget actuals equal job-cost ledger totals by cost code at the service layer.
- [x] Non-billable costs affect margin because Budget/WIP reads all posted job-cost entries, not only billable costs.
- [x] Billable costs reconcile to job-cost entries where applicable through `billable_cost_id`.
- [ ] UI smoke tests confirm Budget/WIP pages render expected actual totals after the source swap.

### Phase 3 - Financial Setup Wizard And Rule Enforcement

Status as of 2026-06-03:

- Added local migration `supabase/migrations/20260603220000_add_project_financial_settings.sql`.
- Applied remote Supabase MCP migration `add_project_financial_settings`.
- Added `project_financial_settings` with persisted `billing_model`, paid-cost rule, proof-required rule, client-cost-approval rule, open-book rule, RLS, policy, indexes, and backfill.
- Live backfill created one settings row per existing project (`43` projects, `43` settings rows).
- Live verification found no billing-model mismatches between financial settings and active contracts.
- Added `lib/services/project-financial-setup.ts`.
- Updated `lib/financials/billing-model.ts` so explicit project financial settings take priority over contract inference.
- Updated project create/update flow in `lib/services/projects.ts` so project billing settings upsert `project_financial_settings`.
- Updated shared approved-cost invoice service to enforce setup completeness, paid-cost billing rules, and proof-required billing rules before the atomic invoice RPC.
- Added `components/financials/financial-setup-status-banner.tsx`.
- Added `components/financials/financial-setup-wizard.tsx` and wired it into setup banners.
- Added setup status visibility to Financials Inbox, Budget, Payables, and Receivables pages.
- Local checks passed: `npm run db:schema:check`, `npx tsc --noEmit`, targeted `npx eslint` for financial setup files.

Tasks:

- [x] Add billing model setup UI surface/status.
- [x] Persist explicit billing model.
- [x] Add paid-vs-incurred rule.
- [x] Add proof-required rule.
- [x] Add setup completeness service.
- [x] Server actions enforce model-specific requirements for approved-cost invoicing.
- [x] Build a full dedicated financial setup wizard with editable paid-cost/proof/open-book settings.

Acceptance:

- [x] Each project has visible setup status on the main financial pages.
- [x] Unsupported approved-cost invoice actions are blocked server-side with actionable messages.
- [ ] UI smoke tests confirm setup banners and rule errors render correctly in browser.

### Phase 4 - Billing Periods And Cost Inbox Hardening

Status as of 2026-06-03:

- Added first-class `project_billing_periods` with org/project scoping, RLS, period status, invoice links, close/reopen metadata, and invoice/cost foreign-key links.
- Added billing-period FK indexes and verified live Supabase performance advisors no longer flag the new billing-period relationships as unindexed.
- Added billing-period service layer for period listing/creation, period eligibility checks, closed-period date enforcement, next-open-period lookup, and invoice-to-period linking.
- Cost-plus invoice generation can now target a billing period, uses that period as the default billing window, links generated invoices/costs back to the period, and still allows explicitly selected late costs outside the period date range.
- Financials review queue is now server-computed for proof-required, paid/incurred eligibility, billing-period state, late-cost carry-forward, recently billed invoice context, and fixed-price suppression.
- Cost Inbox UI now exposes billing-period selection/creation, ready/blocked/recently billed queues, late-cost indicators, blocking reasons, proof/paid status, and invoice links.
- Source approval actions now block edits into closed/invoiced periods unless handled as explicit late-cost adjustment workflow.

Tasks:

- [x] Add billing periods.
- [x] Add server-side review queue state computation.
- [x] Add proof and paid/incurred eligibility.
- [x] Add recently billed invoice links.
- [x] Keep fixed-price out of cost Inbox.
- [x] Support late-cost carry-forward into the next open billing period.
- [x] Add server-side guards for closed/invoiced billing-period source edits.

Acceptance:

- [x] PM can bill a monthly cost-plus cycle without spreadsheet tracking.
- [x] Late costs and closed periods are handled explicitly.
- [ ] Browser smoke tests confirm billing-period controls, late-cost labels, and blocking reasons render correctly.

### Phase 5 - Billing Backup Package And Owner Approval Batches

Tasks:

- [x] Add cost approval batches.
- [x] Add invoice backup package generation.
- [x] Add portal download/view support.
- [x] Store owner approval snapshots.
- [x] Add manifest hashing and audit/event trail for generated and shared packages.
- [x] Surface package status/actions from Receivables invoices.

Acceptance:

- [x] Owner invoice has a portal-visible, downloadable backup manifest with invoice, line, cost, proof-file, totals, controls, and approval-batch snapshots.
- [x] Internal team can generate/regenerate and share the owner backup package from the invoice row.
- [ ] Browser smoke tests confirm the Receivables actions and portal download flow render correctly.

Status as of 2026-06-03:

- Implemented additive schema over the existing `cost_approval_batches` table and added `invoice_backup_packages`.
- Remote Supabase migrations applied:
  - `20260603232000_add_owner_billing_packages.sql`
  - `20260603233000_add_owner_billing_package_fk_indexes.sql`
- RLS is enabled on both owner package tables, and every Phase 5 foreign key has a leading index.
- Backup package generation is manifest-first. The schema includes `invoice_file_id`, `package_file_id`, and `proof_file_ids`, but bundled PDF/ZIP generation is intentionally left for a later packaging/export pass.
- Supabase advisors still show inherited project-wide warnings unrelated to the new tables: mutable function search paths, public-schema extensions, broad SECURITY DEFINER execute grants, leaked-password protection disabled, and existing performance/index-policy noise.

### Phase 6 - Fee Billing

Tasks:

- [x] Add fee schedule schema/services/UI.
- [x] Add fee invoice source to Receivables.
- [x] Add fee earned/billed/remaining cards.
- [x] Tie fee to WIP/forecast.
- [x] Release fee billing links when a fee invoice is voided.
- [ ] Enhance fee schedule UI for milestone/manual fee schedules, multiple fee lines, custom earned rules, and richer schedule editing beyond the current single active fixed-fee schedule.

Acceptance:

- [x] Cost-plus fixed-fee project can bill reimbursable costs and CM fee separately.
- [x] Fee billing uses normal invoices and metadata, not a parallel AR object.
- [ ] Browser smoke tests confirm fee progress save, fee invoice creation, WIP cards, and invoice detail opening.

Status as of 2026-06-04:

- Added fee billing schema:
  - `project_fee_schedules`
  - `project_fee_schedule_lines`
  - `project_fee_billings`
- Remote Supabase migrations applied:
  - `20260604000000_add_project_fee_billing.sql`
  - `20260604001000_add_project_fee_billing_fk_indexes.sql`
- RLS is enabled on all fee billing tables, and every Phase 6 foreign key has a leading index.
- Added `lib/services/fee-billing.ts` to sync the active contract fixed fee into one active fee schedule, compute project percent-complete fee earned, save manual fee progress, create fee invoices through the standard invoice path, and record fee billing allocations.
- Receivables now has a Fee subtab for fixed-fee cost-plus projects with total/earned/billed/billable/remaining cards, fee progress update, and fee invoice generation.
- Budget WIP now receives fee summary data and shows total fee, earned fee, billed fee, billable now, and remaining fee.
- Fee invoices use `source_type = 'fee'`; voiding a fee invoice releases fee billing allocations back from `project_fee_schedule_lines` and voids the associated `project_fee_billings` row.
- Current UI is a first fixed-fee slice: one active contract-backed fee schedule with progress-based earning. The schema supports richer milestone/manual schedules, but the full schedule editor remains a planned enhancement.
- Supabase advisors still show inherited project-wide warnings unrelated to the new fee tables: mutable function search paths, public-schema extensions, broad SECURITY DEFINER execute grants, leaked-password protection disabled, existing performance/index-policy noise, and expected unused-index notices on brand-new fee indexes.

### Phase 7 - GMP Control

Tasks:

- Add inside/outside GMP classification.
- Add GMP impact to COs.
- Add GMP forecast warnings.
- Add savings/overrun report.

Acceptance:

- GMP report is EAC-based and contract-aware.

Status as of 2026-06-04:

- Added GMP control schema via `20260604002000_add_gmp_control.sql`:
  - `change_order_lines.gmp_classification`, `gmp_impact`, `gmp_delta_cents`
  - `budget_revision_lines.gmp_classification`, `gmp_impact`, `gmp_delta_cents`
  - `billable_costs.gmp_classification`, `gmp_exposure_cents`
  - `job_cost_entries.gmp_classification`
  - `project_gmp_snapshots` for contract-aware GMP forecast snapshots
- Added `lib/services/gmp-control.ts` to compute revised GMP, inside-GMP EAC, outside-GMP EAC, actual exposure, savings/overrun, owner/builder savings split, and warnings from the unified Budget EAC.
- Change orders now accept GMP classification/impact, persist it on CO lines, carry it into approval financial metadata, and post the same classification to budget revision lines.
- Budget shows a GMP Control report with revised GMP, inside/outside EAC, savings/overrun, savings split, and forecast warnings.
- Receivables shows the same GMP posture while billing work is happening.
- Change order list/detail surfaces now show inside/outside GMP and whether the CO increases/decreases the GMP.
- Caveat/enhancement task: legacy actuals and historical billable costs default to `inside_gmp`; add a reclassification workflow and audit trail so PM/accounting users can reclassify historical actuals line-by-line when a project already has outside-GMP costs.

### Phase 8 - Trust Center And Reconciliation

Tasks:

- [x] Add project Trust Center.
- [x] Add portfolio rollup.
- [x] Add QBO sync exception checks.
- [x] Add AR/AP/cash risk exceptions.
- [ ] Add true QBO balance mismatch checks against live QBO balances/CDC payloads, not only Arc-side sync statuses and sync-record errors.

Acceptance:

- [x] Controller can see project exceptions by queue with source links.
- [x] Portfolio Financial Control rolls project Trust Center exceptions up across active/planning/on-hold projects.
- [ ] Browser smoke tests confirm Trust Center nav, project queues, source links, and portfolio rollup render correctly.

Status as of 2026-06-04:

- Added `lib/services/trust-center.ts` as the project-level reconciliation engine.
- Added `lib/financials/trust-center-types.ts` shared queue/exception/rollup types.
- Added `components/financials/trust-center-tab.tsx` for the project Trust Center queue UI.
- Added `/projects/[id]/financials/trust-center` and wired it into desktop/mobile financial navigation.
- Added portfolio Trust Center rollup to `/financial-control` alongside AR/AP/ready/QBO controls.
- Implemented exception queues for:
  - approved but unbilled costs
  - billed costs missing required proof
  - billable costs missing job-cost entries
  - billable job-cost entries missing billable-cost links
  - vendor bills without commitments
  - unlinked payments
  - QBO sync errors/pending syncs
  - budget/job-cost actual mismatch
  - retainage records missing invoice links
  - invoice total vs line total mismatch, tax-aware
  - AP due before AR due cash risk
  - paid vendor costs not billed to owner
  - owner-billed invoices still unpaid
- Caveat/enhancement task: live QBO balance mismatch requires querying QBO balances or persisted CDC snapshots; Phase 8 currently flags QBO operational exceptions from Arc sync status and sync records, not external ledger-balance deltas.

---

## 10) Testing And Demo Scripts

Add automated tests where possible and keep manual demo scripts until full E2E exists.

Current automated command:

```bash
npm run test:financials
```

Required test cases:

- Fixed-price project cannot create approved-cost invoice.
- Cost-plus project can move time/expense/vendor bill from submitted/pending to billable ledger.
- Approved-cost invoice creation is atomic and idempotent.
- Budget actuals include vendor bills, expenses, and time exactly once.
- Voiding/reverting approved vendor bill creates/voids/reverses ledger rows correctly.
- Owner portal open-book detail respects `open_book = false`.
- QBO sync errors do not hide local financial truth.
- Closed billing period blocks in-place edits.

Required demo:

1. Create cost-plus GMP project.
2. Complete setup wizard.
3. Submit time, expense, and vendor bill.
4. Approve PM-side.
5. Send owner approval batch.
6. Create period invoice with backup package.
7. Pay invoice.
8. Pay vendor bill.
9. View Budget/WIP, GMP, Trust Center, and Financial Control.
10. Verify QBO exception queue is clear or explicitly shows pending syncs.

Manual operator script: [project-financials-demo-script.md](./project-financials-demo-script.md).

---

## 11) "Done" Definition

Do not call Arc project financials switch-worthy until:

- Cost Inbox cannot miss billable money silently.
- Every billed cost has source proof or an explicit missing-proof exception.
- Budget actuals reconcile to a unified job-cost source.
- Approved-cost invoices are atomic, idempotent, and backed by immutable cost links.
- Fixed fee is separate from markup.
- GMP forecast is EAC-based and contract-aware.
- Fixed-price billing runs through draws/COs/allowances, not costs.
- Trust Center can explain every financial exception.
- QBO sync has clear local-vs-accounting source-of-truth rules.
- A demo project can go from cost capture to invoice to payment to forecast update without spreadsheet sidecars.

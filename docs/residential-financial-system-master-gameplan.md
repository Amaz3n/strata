# Arc Residential Financial System Master Gameplan

**Audience:** Future implementation agents, product/design work, and founder review.

**Target customer:** Custom home builders, major remodelers, and design-build studios. The first wedge is residential project financial operations, not enterprise commercial accounting.

**North star:** Arc should be the project financial operating system for residential builders: contract model, budget, commitments, bills, owner invoices, collections, open-book proof, forecast, compliance, and accounting handoff all reconcile.

**Important companion docs:**
- `docs/cost-plus-residential-financials-gameplan.md` - original cost-plus/T&M phase plan.
- `docs/cost-plus-phase1-demo-checklist.md` - Phase 1 demo validation.
- `docs/financials-gameplan.md` - older broad financial primitives plan.
- `docs/qbo-integration-gameplan.md` - QuickBooks integration direction.
- `docs/stripe-connect-receivables-plan.md` - receivables/payment infrastructure.

---

## 0) LLM Implementation Rules

Before changing code:
1. Read this document and the relevant companion doc.
2. Inspect current repo state. Do not assume prior checklists are still accurate.
3. Prefer existing service/action/component patterns.
4. Land schema and service correctness before UI.
5. Add server-side guards for every UI restriction.
6. Do not silently swallow financial data-loading errors.
7. Money correctness beats dashboard polish.

Every financial mutation must:
- Be org-scoped.
- Enforce authorization.
- Validate input with zod or an existing schema.
- Record audit/event rows where the local pattern supports it.
- Use integer cents for money.
- Be idempotent when a user can retry or double-submit.
- Avoid modifying billed/paid historical rows in place; use adjustment rows.

---

## 1) Product Thesis

Arc should not be "cost-plus software" only. Arc should support the billing models residential builders actually use, while making cost-plus/GMP the sharpest, most differentiated workflow.

The billing model should determine:
- Which financial pages are primary.
- Which actions are available.
- Which setup fields are required.
- Which server actions are allowed.
- Which client-portal views are visible.
- Which forecast and reporting rules apply.

Do not implement billing model as UI hiding only. It is a workflow and business-rule layer.

---

## 2) Billing Models Arc Should Support

Use a normalized project billing model eventually. Existing code currently uses `contracts.contract_type` with `fixed`, `cost_plus`, and `time_materials`. The target model is more expressive:

```ts
type ProjectBillingModel =
  | "fixed_price"
  | "cost_plus_percent"
  | "cost_plus_fixed_fee"
  | "cost_plus_gmp"
  | "time_and_materials"
```

### 2.1 Fixed Price / Lump Sum

**Industry use:** Common for custom homes once scope is sufficiently defined. Builder owns margin risk.

**Primary workflow:**
Contract value -> draw schedule -> owner invoices -> payments.

**Primary pages/actions:**
- Budget
- Receivables
- Draw schedule
- Payables
- Change orders
- Allowances
- Internal job-cost reports

**Do not foreground:**
- Time page
- Expense page
- Cost Inbox
- Generate invoice from costs
- Client open-book cost drilldown

**Rules:**
- Actual costs are internal job-costing data, not owner billing basis.
- Owner billing comes from draws, milestones, approved change orders, and allowance adjustments.
- Client should not see raw vendor bills/time unless explicitly shared.

### 2.2 Cost Plus Percent

**Industry use:** Common when scope evolves, owner wants transparency, or builder does not want to carry undefined-scope risk.

**Primary workflow:**
Cost capture -> PM/client approval -> billable ledger -> markup rules -> owner invoice -> payment.

**Primary pages/actions:**
- Financials Inbox
- Time
- Expenses
- Payables
- Receivables
- Budget
- Markup rules
- Open-book client invoice detail

**Rules:**
- Reimbursable classification matters by cost code and line override.
- Markup resolution chain must be explicit: line override -> cost code -> contract -> org -> default.
- Billable costs must not be invoiced twice.
- Owner invoice lines must reconcile to underlying billable ledger rows.

### 2.3 Cost Plus Fixed Fee / Construction Management Fee

**Industry use:** Owner reimburses actual costs while builder earns a fixed fee, monthly fee, milestone fee, or earned percentage of fee.

**Primary workflow:**
Cost capture -> reimbursable cost invoice + separate fee billing schedule.

**Primary pages/actions:**
- Financials Inbox
- Payables
- Receivables
- Fee Billing
- Budget
- Open-book cost detail

**Rules:**
- Do not apply percentage markup to every cost unless contract allows it.
- Builder fee is its own billing stream.
- Fee can be billed by milestone, monthly schedule, draw-like schedule, or percent complete.

### 2.4 Cost Plus GMP

**Industry use:** Premium custom-home model when owner wants transparency plus budget protection.

**Primary workflow:**
Cost-plus workflow + GMP cap + EAC forecast + savings/overrun handling.

**Primary pages/actions:**
- Financials Inbox
- Forecast/GMP
- Budget
- Receivables
- Payables
- Time/Expenses
- Open-book cost detail

**Rules:**
- Require GMP amount.
- Require clear fee/markup setup.
- Surface forecast-at-completion everywhere financial decisions happen.
- Savings split and overrun warnings must be based on EAC, not naive committed/actual math.

### 2.5 Time & Materials

**Industry use:** Smaller projects, service work, preconstruction, unclear scope, extra work, or T&M change orders.

**Primary workflow:**
Time/material ticket -> approval -> detailed invoice.

**Primary pages/actions:**
- Financials Inbox
- Time
- Expenses/materials
- Receivables
- Payables if vendor cost pass-through exists

**Rules:**
- Labor rate tables and burden multipliers are core.
- Client approval/sign-off is often required before billing.
- Detailed invoice mode matters more than cost-code rollup.

---

## 3) Billing Model Routing

Create a central helper, not scattered checks:

```ts
getProjectFinancialFeatureConfig(projectOrContract): {
  billingModel: ProjectBillingModel
  landingPage: "inbox" | "receivables" | "budget" | "forecast"
  showInbox: boolean
  showTime: boolean
  showExpenses: boolean
  showGenerateFromCosts: boolean
  showOpenBook: boolean
  showDraws: boolean
  showGmpForecast: boolean
  requireCostApproval: boolean
  ownerBillingBasis: "draws" | "costs" | "costs_plus_fee" | "time_materials"
}
```

Initial mapping from current data:
- `contracts.contract_type = fixed` -> `fixed_price`
- `contracts.contract_type = cost_plus` and `gmp_cents is null` -> `cost_plus_percent`
- `contracts.contract_type = cost_plus` and `gmp_cents is not null` -> `cost_plus_gmp`
- `contracts.contract_type = time_materials` -> `time_and_materials`

Later, add an explicit `billing_model` field and backfill.

Server-side guards must block:
- Cost-generated invoices on fixed-price projects.
- GMP savings/burn logic on non-GMP projects.
- Client cost approval on fixed-price projects unless tied to a T&M/change-order flow.
- Open-book invoice detail when contract `open_book = false`.

---

## 4) Current Direction For Project Financial Pages

The financials overview page has been removed because it repeated other page data. The new direction is correct:

`/projects/[id]/financials` should be the **financial workbench**.

For cost-plus/T&M/GMP, it should be the Inbox:
- Needs review
- Blocked
- Ready to invoice
- Recently billed/approved if useful

For fixed-price, default landing should likely be:
- Receivables if the project is owner-billing heavy.
- Budget if the project is preconstruction or cost-control heavy.
- A fixed-price financial workbench later, centered around draws, COs, allowance decisions, and AP risk.

Do not bring back a generic summary overview unless it is decision-oriented.

---

## 5) Financial Inbox Workbench Requirements

The Inbox is the centerpiece for cost-plus/T&M projects.

### 5.1 Queue states

Use states that match user intent:

- `blocked`
  - Missing cost code.
  - Missing receipt.
  - Missing labor rate.
  - Missing bill-line coding.
  - Compliance/payment blocker if relevant.

- `needs_review`
  - Submitted time ready for PM review.
  - Submitted expense ready for PM review.
  - Pending vendor bill with sufficient coding.

- `awaiting_client_approval`
  - PM-approved T&M/time item requiring owner sign-off.

- `ready_to_invoice`
  - Approved billable ledger rows not yet invoiced.

- `billed`
  - Recently invoiced rows, optional short lookback only.

Avoid labeling ready-to-invoice costs as "Approved"; it hides the next action.

### 5.2 Required UI actions

Inbox must support:
- Assign cost code inline.
- Approve single item.
- Reject single item with reason.
- Bulk assign cost code.
- Bulk approve selected.
- Bulk reject selected.
- Create invoice from selected ready costs.
- Open source record.
- Show why blocked and how to fix.

### 5.3 Summary strip

Top strip should show:
- Needs review count.
- Blocked count.
- Ready-to-invoice total.
- Ready-to-invoice count.
- Missing receipt/rate/cost-code counts.
- GMP/EAC warning when applicable.

### 5.4 Data-loading rule

Do not return empty arrays when a financial service fails. A blank financial inbox can cause missed billing. Return partial data with visible warnings or fail loudly.

---

## 6) Cost-Plus/T&M Core: Finish The Loop

Already implemented in large part:
- `time_entries`
- `project_expenses`
- `markup_rules`
- `billable_costs`
- approval propagation into billable ledger
- invoice composer can load approved costs
- open-book invoice detail exists for client portal
- sub portal time/expense routes exist

Non-negotiable remaining work:

### 6.1 Atomic approved-cost invoice generation

Current flow locks billable costs, creates invoice, creates invoice lines, and marks costs billed across multiple calls. This must become one transactional operation.

Target:
- PostgreSQL RPC or equivalent transactional service.
- Input: project, cost IDs/date range, group mode, invoice metadata.
- Lock only open eligible costs.
- Insert invoice.
- Insert invoice lines.
- Mark ledger rows billed with invoice and line IDs.
- Store idempotency result.
- Roll back everything on failure.

### 6.2 Ready-cost invoice flow from Inbox

The primary cost-plus action should not live only inside the invoice composer.

Flow:
1. User selects ready-to-invoice costs in Inbox.
2. Clicks `Create invoice`.
3. Preview grouped by cost code or detail.
4. Confirm draft or send.
5. Ledger rows are billed atomically.

### 6.3 Cost proof completeness

For every owner-visible cost-plus invoice line, Arc must show:
- Date.
- Source type.
- Vendor/worker.
- Cost code.
- Description.
- Base cost.
- Markup/fee.
- Receipt/photo/bill/ticket where applicable.
- Approval status.

### 6.4 Client approval delivery

Current approval link copy is not enough for pilot excellence.

Add:
- Email delivery.
- SMS later if available.
- Approval reminder.
- Approval audit event.

---

## 7) Forecasting, WIP, P&L: The Controller Layer

This is the next major phase after cost-plus inbox cleanup.

### 7.1 Why this is non-negotiable

Cost capture and billing tell the builder what happened. Forecasting tells them whether the job is healthy.

Arc cannot be a serious financial system without:
- Cost-to-complete (CTC).
- Estimate-at-completion (EAC).
- Variance-at-completion.
- Earned revenue.
- Over/under billing.
- Project P&L.

### 7.2 Required model

Add cost-code progress/forecast state:

```sql
project_cost_code_progress
project_id
cost_code_id
percent_complete
basis -- manual | cost_to_cost | schedule_linked
estimate_remaining_cents
notes
recorded_by_user_id
recorded_at
```

Allow PM/controller override. Do not rely only on formulas.

### 7.3 Budget page additions

Budget page should gain:
- Original budget.
- Approved CO adjustments.
- Revised budget.
- Committed.
- Actual.
- Pending exposure.
- Percent complete.
- Cost to complete.
- EAC.
- Variance at completion.
- Notes/assumptions.

### 7.4 WIP report

Single-project first:
- Contract value.
- Approved COs.
- Revised contract.
- Percent complete basis.
- Earned revenue.
- Billed revenue.
- Over/under billing.
- Actual cost.
- Estimated final cost.
- Forecast gross profit/margin.

Portfolio WIP comes later.

### 7.5 GMP forecast rule

GMP burn must use EAC, not `max(actual, committed)`.

Show:
- GMP.
- Actual cost to date.
- Committed exposure.
- EAC.
- Projected overrun/savings.
- Owner/builder savings split.
- Unapproved CO exposure.
- Allowance exposure.

---

## 8) Fixed-Price Financial Workflow

Fixed-price deserves its own workflow, not a disabled cost-plus workflow.

### 8.1 Core loop

Contract -> draw schedule -> invoice -> payment -> budget/margin tracking.

### 8.2 Required features

- Contract value and revised contract value.
- Draw schedule builder.
- Generate invoice from draw.
- Allowance tracking.
- Change orders that update contract and budget.
- Internal budget vs committed vs actual.
- Retainage if configured.
- AR aging and payment status.
- AP aging and commitment/bill tracking.

### 8.3 Hidden or secondary features

Time and expenses can exist as internal cost capture, but should not be primary navigation unless enabled by org/project setting.

Cost Inbox is not the default fixed-price financial landing page.

---

## 9) Change Orders, Allowances, And Budget Revisions

This is a non-negotiable financial control area.

### 9.1 Change order approval must update money in multiple places

On approval:
- Contract revised value changes.
- Budget revision is created.
- Cost-code distribution is recorded.
- Forecast is updated.
- Billing eligibility is created if owner-billable.

### 9.2 Target tables

```sql
budget_revisions
budget_revision_lines
```

Each approved CO should create a durable budget revision. Do not only store a total.

### 9.3 Allowances

Allowances must show:
- Budget allowance.
- Selected/actual amount.
- Over/under.
- Owner-billable overage rule.
- Invoice linkage.
- Forecast exposure.

---

## 10) Receivables

Receivables must support all billing models.

Required:
- Draft/sent/partial/paid/overdue/void lifecycle.
- Manual invoice.
- Draw invoice.
- Change-order invoice.
- Approved-cost invoice.
- Payment links.
- Manual payments.
- Balance recalculation.
- AR aging.
- Reminder/late-fee settings.
- Client portal view.

Cost-plus-specific:
- Generate from ready costs.
- Open-book drilldown.
- Markup/fee transparency.

Fixed-price-specific:
- Draw schedule prominence.
- Contract/draw progress.
- Change-order billing.

---

## 11) Payables

Payables must support:
- Vendor bills.
- Bill lines by cost code.
- Commitment/subcontract linkage.
- Remaining commitment balance.
- Over-billing/over-commitment warning.
- Approval status.
- Payment status.
- AP aging.
- Retainage/lien waiver/compliance blockers where configured.

For cost-plus projects, approved coded bill lines should flow to the billable ledger.

Important trap:
Do not flatten multi-line vendor bills into one cost code casually. If the bill has multiple lines/codes, preserve that structure.

---

## 12) Compliance And Trust

### 12.1 Sub/vendor compliance

Essentials:
- W-9.
- General liability COI.
- Workers comp COI.
- License where relevant.
- Expiration tracking.
- Compliance status per company.
- Payment gate or warning.

Existing compliance document infrastructure appears to exist. Prefer extending it over creating parallel tables.

### 12.2 Lien waivers

For serious construction financial workflows:
- Conditional waiver on invoice/payment request.
- Unconditional waiver after payment clears.
- Track waiver status per vendor bill/payment where applicable.
- Block or warn on payment if waiver required.

---

## 13) QBO And Bank Feed Strategy

Do not try to become QuickBooks.

### 13.1 Source-of-truth rule

Arc is source of truth for project financial operations:
- Project budget.
- Commitments.
- Owner invoices created in Arc.
- Billable cost ledger.
- Draw schedule.
- Change-order financial impact.

QBO is source of truth for accounting close/tax/general ledger unless the customer decides otherwise.

### 13.2 Near-term QBO scope

Do:
- Push Arc-originated invoices.
- Push payments for Arc-originated invoices.
- Pull payment status back for Arc-originated invoices.
- Show sync errors and retry/ignore controls.
- Add account/item mapping.

Avoid early:
- Broad two-way bill mutation.
- General ledger editing.
- Unbounded sync that changes Arc financial history.

### 13.3 Bank feed

Only add after Arc owns enough AR/AP flow to make matching valuable.

Initial use:
- Match deposits to invoice payments.
- Match outgoing payments to vendor bills.
- Surface unmatched transactions.

---

## 14) Portfolio Financials

After project-level math is trustworthy:

Global financial center should include:
- AR aging by project/client.
- AP aging by vendor/project.
- Cash-flow forecast, ideally 13 weeks.
- Projects over forecast/budget.
- Ready-to-invoice costs across projects.
- Blocked billing items across projects.
- Expiring compliance docs.
- QBO sync errors.

Do not build portfolio dashboards on weak project forecasts.

---

## 15) Field Capture And Mobile/PWA

Field adoption determines cost-plus success.

Required:
- Camera-first receipt capture.
- Fast time ticket entry.
- Saved crews.
- Labor rate defaults.
- Receipt thumbnails.
- Upload retry.
- Offline draft queue later.
- Sub portal parity.

Do not start native mobile until PWA limits are proven.

---

## 16) Senior PM / GC Essentials To Move From Procore To Arc

This section is written from the lens of a senior PM/GC who is financially accountable for jobs.

I would not move from Procore to Arc financially unless Arc gives me these essentials:

### 16.1 Trustworthy job cost report

I need one report by cost code that shows:
- Original budget.
- Approved budget revisions.
- Revised budget.
- Committed.
- Pending commitments.
- Actual cost.
- Pending bills.
- Cost to complete.
- Forecast final cost.
- Variance at completion.

If this report is wrong, I cannot trust the system.

### 16.2 Commitment control

I need to know:
- What each sub/vendor is committed for.
- What they have billed.
- What remains.
- Whether a bill exceeds commitment.
- Whether a cost code is overcommitted.

### 16.3 Change-order financial control

I need every approved CO to:
- Update contract value.
- Update budget by cost code.
- Show owner-billable status.
- Show pending exposure before approval.
- Be traceable from estimate/request to approval to invoice.

### 16.4 Forecast-at-completion

I need EAC/CTC by cost code and project total.

The system must allow my judgement. A formula-only forecast is not enough.

### 16.5 WIP / over-under billing

I need to know if I am:
- Overbilled.
- Underbilled.
- Ahead/behind on earned revenue.
- Forecasting margin erosion.

Even residential builders need this once jobs are large enough.

### 16.6 Payables aging and approval workflow

I need:
- What bills are pending approval.
- What bills are due this week.
- What bills are blocked.
- Which bills are missing lien waivers or compliance docs.
- Who approved what and when.

### 16.7 Receivables and cash clarity

I need:
- What invoices are unpaid.
- What is overdue.
- What draws are upcoming.
- What is ready to bill right now.
- Whether the client has viewed/paid.
- What payment reminders have gone out.

### 16.8 Audit trail

For financial trust, I need to answer:
- Who changed this amount?
- Who approved this bill?
- Why was this cost excluded?
- When did this become billable?
- What invoice claimed this cost?

### 16.9 Attachments and proof

Every cost needs proof:
- Vendor bill.
- Receipt.
- Time ticket.
- Photo.
- Approval.
- Cost-code assignment.

No attachment/proof trail, no trust.

### 16.10 Export and accounting handoff

I need to get clean data to accounting:
- QBO sync or clean exports.
- AR/AP aging export.
- Job cost export.
- WIP export.
- Payments ledger.
- Change-order log.

### 16.11 Permission model

I need roles:
- PM can approve project costs.
- Accounting can pay/post.
- Field can submit but not approve.
- Client can approve only token-scoped items.
- Subs can see only their own submissions.

### 16.12 Speed and usability

If it takes longer than Procore for daily PM work, I will not switch.

The killer daily workflow:
1. Open Financials Inbox.
2. Clear blocked items.
3. Approve bills/time/expenses.
4. See ready-to-invoice total.
5. Generate invoice.
6. See updated forecast.

---

## 17) Sequencing Recommendation

### Phase A - Normalize billing model and route financial UX

**Status:** Implemented in repo on 2026-05-15.

Implemented:
- Central billing-model compatibility layer in `lib/financials/billing-model.ts`.
- Five project billing models exposed in project create/edit settings:
  - `fixed_price`
  - `cost_plus_percent`
  - `cost_plus_fixed_fee`
  - `cost_plus_gmp`
  - `time_and_materials`
- Current `contracts.contract_type` remains backward-compatible while `contracts.snapshot.billing_model` stores the more specific model.
- `/projects/[id]/financials` routes by billing model:
  - cost-plus / T&M / GMP -> Inbox workbench
  - fixed price -> Receivables
- Approved-cost invoice UI now uses the central billing-model helper.
- Server-side invoice creation blocks approved-cost invoicing for unsupported billing models.

Deliver:
- Billing model helper/config.
- Project settings mapping.
- Fixed-price vs cost-plus/T&M landing behavior.
- Server-side action guards.
- Hide/de-emphasize irrelevant pages.

Acceptance:
- Fixed-price project does not land on cost-plus inbox.
- Cost-plus/T&M project lands on inbox.
- Generate-from-costs is unavailable on fixed-price server-side and UI.

### Phase B - Finish Financial Inbox

**Status:** Implemented in repo on 2026-05-15.

Implemented:
- Inbox queue states now distinguish `Blocked`, `Needs Review`, `Client Approval`, and `Ready to Invoice`.
- Open billable ledger rows are no longer labeled "Approved"; they surface as `Ready to Invoice`.
- Inbox has a summary strip for needs-review count, blocked count, client-approval count, and ready-to-invoice dollars.
- Financial data load failures are returned as visible warnings instead of silently becoming an empty queue.
- Bulk toolbar supports:
  - bulk cost-code assignment for selected assignable rows
  - approve selected
  - reject selected
  - create invoice from selected ready-to-invoice ledger rows
- Cost-plus invoice generation accepts explicit `billableCostIds` so selected Inbox rows can be invoiced exactly.

Deliver:
- Rename Approved -> Ready to Invoice.
- Add queue states.
- Add summary strip.
- Add bulk toolbar.
- Add selected ready-cost invoice flow.
- Stop swallowing load errors.

Acceptance:
- PM can clear a realistic cost-plus inbox from blocked -> reviewed -> ready to invoice.
- Ready costs can become an invoice from the Inbox.

### Phase C - Make cost-to-invoice atomic

**Status:** Implemented in repo on 2026-05-15.

Implemented:
- Added transactional PostgreSQL RPC in `supabase/migrations/20260515110000_costplus_invoice_atomic_rpc.sql`.
- Non-dry-run `generateInvoiceFromCosts` now calls `create_invoice_from_billable_costs_atomic`.
- The RPC locks selected open billable costs, creates the invoice, creates invoice lines, marks ledger rows billed, updates QBO invoice-number reservation when present, and writes idempotency response in one transaction.
- Dry-run preview remains in TypeScript and still uses the existing markup/grouping logic.
- Selected-cost invoicing from the Inbox benefits from the same atomic path.

Deliver:
- Transactional RPC/service for approved-cost invoicing.
- Idempotency.
- Rollback behavior.
- Tests for partial failure and concurrent generation.

Acceptance:
- Cannot double-bill costs.
- Cannot strand locked costs.
- Invoice lines reconcile to ledger rows.

### Phase D - Job-cost forecast and WIP

**Status:** Implemented in repo on 2026-05-15.

Implemented:
- Added `project_cost_code_progress` schema for tracking `percent_complete` and `estimate_remaining_cents` by cost code.
- Added `CostCodeProgressEditor` component within the `BudgetBucketSheet` allowing the PM/controller to update completion percentage and CTC manually.
- Upgraded `getBudgetWithActuals` to calculate Estimate At Completion (EAC), Cost to Complete (CTC), and Variance At Completion (VAC).
- Added `Project WIP & Forecast` summary to the top of `BudgetTab`, calculating earned revenue using cost-to-cost `% complete` (Actuals / EAC) and calculating over/under billing compared to invoiced revenue.
- Added forecast columns (Original, Approved CO, Revised, Committed, Actual, CTC, EAC, VAC, % Comp) to the detailed desktop Budget table.
- Upgraded `getGMPSnapshot` to consume EAC from the budget engine instead of naively comparing actuals vs commitments.

Deliver:
- Progress/forecast schema.
- Budget page forecast columns.
- Project P&L.
- Single-project WIP.
- GMP gauge driven by EAC.

Acceptance:
- PM/controller can update CTC/EAC by cost code.
- WIP over/under billing is accurate for sample projects.

### Phase E - CO, allowance, compliance hardening

**Status:** Implemented in repo on 2026-05-15.

Implemented:
- Hardened change-order approval so a CO cannot be financially approved unless every line is distributed to a cost code.
- Added approved CO financial posting metadata, including budget revision distribution, allowance draw totals, billing status, posting timestamp, and posting actor.
- Added per-line CO metadata for budget revision cents and allowance draw cents, and updated the budget engine to prefer posted revision metadata while preserving the older fallback calculation.
- Added the financial posting summary to the change-order detail sheet so PM/accounting can see how the CO hit budget and allowances after approval.
- Added explicit AP payment gates to Payables: payment rows now show whether compliance/lien-waiver requirements are clear or blocked.
- Disabled payment posting from the Payables UI when compliance documents or required lien waivers are missing, matching the server-side payment guard.

Deliver:
- CO -> budget revision distribution.
- Allowance over/under billing workflow.
- Compliance gates on payables.
- Lien waiver status integrated with payments.

Acceptance:
- Approved CO updates contract, budget, forecast, and billing status.
- Payment workflow flags missing compliance/waivers.

### Phase F - Portfolio financial center

**Status:** Implemented in repo on 2026-05-15.

Implemented:
- Added global `/financial-control` route as a company-level controller workspace, intentionally separate from project-scoped `/projects/[id]/financials`.
- Added `getPortfolioFinancialControlData` service to aggregate AR, AP, ready-to-invoice costs, blocked payment/coding items, QBO exceptions, aging buckets, and 30-day net cash-flow signal.
- Added Financial Control UI with summary metrics, AR/AP aging, ready-to-invoice queue, blocked risk queue, and QBO sync exception queue.
- Added global sidebar entry named `Financial Control` so users do not confuse it with project Financials.
- Every row links back to its source project financial page or integrations area.

Deliver:
- Global AR aging.
- Global AP aging.
- Ready-to-invoice across projects.
- Blocked financial items across projects.
- Cash-flow forecast.
- QBO sync exceptions.

Acceptance:
- Owner can see company financial risk without opening each project.

### Phase G - Field capture polish

**Status:** Implemented in repo on 2026-05-15.

Implemented:
- Added employee labor-rate defaults to memberships: cost rate, bill rate, burden multiplier, and billable-by-default.
- Added Team settings edit controls for each employee's labor defaults.
- Time entry creation now resolves the logged-in employee's saved labor defaults automatically when they submit their own time.
- Crew time entry is now available from the time-entry form for users who can manage crew time.
- Crew entries can be built from active team members, pulling saved cost rates, burden multipliers, and billable defaults instead of retyping rates.
- Crew time still supports manual workers, cost-code assignment, shared attachments, and mobile drawer capture.
- Existing expense capture remains camera-first with receipt attachment and extraction support.

Deliver:
- Camera-first receipts.
- Saved crews/rates.
- Better mobile time/expense flows.
- Offline drafts later.

Acceptance:
- Field can submit receipt or T&M ticket in under 30 seconds.

---

## 18) Non-Negotiable Checklist

Do not call the financial system "solid" until these are true:

- [ ] Billing model controls page routing and server permissions.
- [ ] Cost-plus/T&M inbox supports blocked, needs review, awaiting client approval, and ready-to-invoice states.
- [ ] Approved-cost invoice creation is atomic.
- [ ] Billable ledger reconciles to invoice lines.
- [ ] Fixed-price billing works through draws/COs/allowances, not costs.
- [ ] Budget page has CTC/EAC/VAC by cost code.
- [ ] GMP forecast uses EAC.
- [ ] WIP/over-under billing exists at project level.
- [ ] Approved COs create budget revisions by cost code.
- [ ] Payables show commitment remaining and over-bill warnings.
- [ ] AR/AP aging reports exist and export.
- [ ] Compliance/waiver blockers are visible before payment.
- [ ] QBO sync has clear source-of-truth and error handling.
- [ ] Financial data-loading errors are visible, never silently blank.
- [ ] Demo project passes end-to-end from cost capture to invoice to payment to forecast update.

---

## 19) Things To Defer

Defer unless a pilot demands them:
- AIA G702/G703.
- Certified payroll.
- Prevailing wage.
- Surety/bonding reports.
- Full native mobile app.
- Full two-way accounting sync.
- Multi-currency.
- Enterprise custom ERP integrations.

These may matter later, but they are not required to win the residential custom-builder wedge.

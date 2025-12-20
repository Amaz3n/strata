# Strata Financials Gameplan (Competitive Core, LLM-Optimized)

Goal: Make Strata’s financial system competitive with Procore/Buildertrend at a local scale by shipping a **complete money loop** that builders can actually run their business on:

- **Contract → Draw schedule (progress billing) → Invoices → Payments → Receipts**
- **Budget → Cost codes → Commitments (subcontracts/POs) → Vendor bills → Payables → Variance**
- **Change orders** that flow into contract value, billing, and budget impact
- **Lien waivers / compliance** that reduce risk and speed payments

This plan is intentionally “construction financial ops,” not a full accounting replacement. QuickBooks Online remains the accounting system of record for many customers; Strata must be the system of record for **project financial operations**.

---

## 0) Current State (Repo Reality)

### 0.1 Database tables already exist (from `supabase/schema.sql` + migrations)

**Core financial primitives (already in schema)**
- Contracts: `contracts`
- Change orders: `change_orders`, `change_order_lines`
- Allowances: `allowances`
- Budgets: `budgets`, `budget_lines`, `budget_snapshots`, `variance_alerts` (+ DB lock guards)
- Cost codes: `cost_codes`
- Commitments (subs/POs): `commitments`, `commitment_lines`
- Vendor bills (AP): `vendor_bills`, `bill_lines`
- Client invoices (AR): `invoices`, `invoice_lines`
- Payments (AR + AP): `payments`, `payment_intents`, `payment_links`, `payment_methods`, `payment_schedules`
- Collections automation: `reminders`, `reminder_deliveries`, `late_fees`, `late_fee_applications`
- Progress billing: `draw_schedules`
- Retainage: `retainage`
- Lien waivers: `lien_waivers`
- Receipts: `receipts`

**QBO integration foundation (from `supabase/migrations/20241206_qbo.sql`)**
- `qbo_connections`, `qbo_sync_records`, `qbo_invoice_reservations`
- invoice columns: `invoices.qbo_id`, `invoices.qbo_synced_at`, `invoices.qbo_sync_status`

### 0.2 Services and key behaviors already exist

These are important because many “missing features” are often missing **UI/workflow**, not missing backend capability.

- Budgets with actuals/variance calculation: `lib/services/budgets.ts`
- Commitments: `lib/services/commitments.ts`
- Vendor bills (including sub-portal submission): `lib/services/vendor-bills.ts`, `app/s/[token]/submit-invoice/*`
- Invoices: `lib/services/invoices.ts` + portal/public views (`app/i/[token]`, `app/p/[token]/invoices/[id]`)
- Payments (Stripe intents, pay links, invoice balance recalculation, lien waiver trigger hook): `lib/services/payments.ts`
- Draw invoicing: `lib/services/draws.ts`
- Retainage: `lib/services/retainage.ts`
- Lien waivers: `lib/services/lien-waivers.ts`
- Invoice reminders + late fees jobs: `app/api/jobs/reminders/route.ts`, `app/api/jobs/late-fees/route.ts`
- QBO sync pipeline: `lib/services/qbo-sync.ts`, `app/api/qbo/*`

### 0.3 Known “schema drift” risk (must be handled in Phase 0)

`supabase/schema.sql` does not appear to include every column/table referenced by financial services (e.g., some invoice fields and views tracking). The plan below includes a **Schema Audit & Reconciliation** step to ensure the repo migrations match the production DB and code expectations.

---

## 1) Product Principles (How to Beat Procore/BT Locally)

1) **Make money clarity immediate**
   - Builders should answer “am I on budget, and what’s my exposure?” in under 30 seconds.
2) **Make progress billing frictionless**
   - Most local builders care about draws more than “invoicing features.”
3) **Make payables predictable**
   - Commitments + bills + waivers should reduce surprises and vendor friction.
4) **Make clients feel confident**
   - A client financial dashboard that is understandable (not accounting jargon) increases trust and reduces calls.
5) **Don’t become an accounting system**
   - You can integrate with QBO, but don’t let QBO dictate your UX model.

---

## 2) UX Architecture: Where Financials Live

### 2.1 Recommended navigation shape

**A) Global Financial Center**
- Introduce a global `/financial` (or expand existing “Financial” group) with these top-level sections:
  - **Receivables (AR)**: invoices, payment links, aging, reminders/late fees
  - **Payables (AP)**: vendor bills, approval queue, payment recording
  - **Costing**: budgets, commitments, variance alerts, snapshots
  - **Reports**: AR aging, AP aging, budget vs actual, CO log, draw status
  - **Settings**: payment methods, reminder rules, late fee rules, QBO connection status

**B) Project Financials**
- Expand the existing project “Financials” tab into a sub-nav:
  - Contract (prime contract)
  - Draw schedule (progress billing)
  - Invoices + payments (client billing history)
  - Budget & variance (job costing lite)
  - Commitments + bills (subcontracts/POs and vendor invoices)
  - Retainage
  - Lien waivers (project-specific)

### 2.2 Why not keep everything in separate pages only
- Procore/BT win by combining “project view” (how PMs work) with “global accounting view” (how office works).
- Strata should have both; otherwise customers keep spreadsheets because global reporting is too hard.

---

## 3) Competitive Essentials (What We Must Ship)

This is the minimum set to compete at local scale. Everything else is a differentiator or Phase 2+.

### 3.1 Receivables (AR)
- Invoice lifecycle: draft → sent → partial → paid → overdue → void
- “Send invoice” that is real (email + portal link), tracked (sent_at, recipients, views)
- Payment collection (Stripe) + manual payment recording
- Automatic balance recalculation and status updates
- Receipts issued and stored
- Automated reminders + late fees configurable by org/project

### 3.2 Progress Billing (Draws)
- Draw schedule builder (SOV-lite): % or amount per draw, due dates/triggers, milestone linking
- “Generate invoice from draw” (already partially exists in services)
- Partial draw billing and partial payments handled cleanly
- Client view: upcoming draws, what’s paid, what’s next

### 3.3 Job Costing Lite (Budget + Commitments + Bills)
- Budget builder tied to cost codes (import templates, lock/approve)
- Commitments (subcontracts/POs) with line items tied to cost codes
- Vendor bills tied to commitments with remaining-to-bill and overage flags
- Variance reporting: budget vs committed vs actual vs invoiced, by cost code and rollups
- Variance alerts surfaced and acknowledged

### 3.4 Risk / Compliance
- Retainage handling for client billing
- Lien waiver request + signature + storage
- Basic “compliance gates” for payables (COI/W9/waiver required) — can start as warnings and become enforcement

---

## 4) Phase 0 — Schema Audit & Reconciliation (Non-Negotiable)

Before building more UX, ensure DB and code agree.

### 4.1 Inventory what code expects
- `lib/services/invoices.ts` expects invoice fields (token, title, notes, client_visible, sent_to_emails, viewed_at, sent_at, subtotal/tax, etc.)
- It also references `invoice_views` (table not present in `supabase/schema.sql`)
- QBO sync expects `qbo_sync_records` (exists in migration)

### 4.2 Reconcile schema in repo
- Ensure every column used in services exists in migrations (use `add column if not exists`).
- Ensure every table used in services exists (e.g., `invoice_views`).
- Update `supabase/schema.sql` (or add migrations) so the repo is a reliable source of truth.

### 4.3 Migration checklist (likely needed)
Create a migration like `supabase/migrations/2025xxxx_financial_schema_reconcile.sql` that:
- Adds missing invoice columns used by the app, with `if not exists` guards
- Adds `invoice_views` (and indexes), if missing
- Adds any indexes required for AR/AP reports (org+status+date)

Acceptance criteria:
- Running the migrations on a clean DB yields a schema compatible with current services without runtime query failures.

---

## 5) Phase 1 — Receivables That Actually Collect (AR End-to-End)

Outcome: A builder can generate/send an invoice, collect payment via portal/public link, and see accurate status/aging with minimal manual work.

### 5.1 Features
- Invoice lifecycle + sending (email + “copy link”)
- Payment link creation rules (expiry, single-use vs multi-use)
- Stripe pay flow (already exists): card + ACH where configured
- Manual payment recording (for checks/wires)
- Payment reconciliation:
  - balance_due updates
  - status transitions (sent/overdue/partial/paid)
  - payment receipts
- Reminders + late fees:
  - UI to configure rules per org/project
  - delivery log visibility (reminder_deliveries)

### 5.2 DB changes (if missing)
- `invoice_views` table (token view tracking)
- Invoice columns required by UI/services:
  - `token` (or token_hash model)
  - `title`, `notes`, `client_visible`
  - `subtotal_cents`, `tax_cents`
  - `sent_at`, `sent_to_emails`
  - `viewed_at` (optional; views table may replace)
  - `status` should support: `draft`, `sent`, `overdue`, `paid`, `void`, `partial` (if not already standardized)

### 5.3 UI placement
- Global: Financial → Receivables
  - invoices table + filters
  - invoice detail drawer with: lines, payments, reminder history, QBO sync badge
- Project: Financials → Invoices
  - same components, project-filtered

### 5.4 Acceptance criteria
- Create invoice → send → pay → status becomes paid automatically
- Reminder job sends email and records delivery
- Late fee job adds line item and updates totals without breaking payment flow

---

## 6) Phase 2 — Progress Billing (Draw Schedule → Invoice → Payment)

Outcome: Strata is excellent for residential draw-based billing (the most common local need).

### 6.1 Features
- Draw schedule builder UI
  - amount or % of contract
  - due date and/or milestone trigger
  - status tracking (pending/invoiced/partial/paid)
- Generate invoice from draw
  - uses existing `lib/services/draws.ts` as the backend
  - ensure invoice is client-visible and linked back to draw
- Client “upcoming payments” experience
  - next draw, schedule overview, payment history

### 6.2 DB enhancements
- Consider adding:
  - `draw_schedules.invoiced_amount_cents` (for partial invoicing) or compute from linked invoice lines
  - `draw_schedules.paid_amount_cents` (if partial payments can occur across one invoice)
  - `draw_schedules.retainage_cents` (if retainage withheld per draw)
- Add indexes for dashboard queries:
  - `(org_id, project_id, status, due_date)`

### 6.3 UI placement
- Project: Financials → Draw schedule
  - table + “Generate invoice” action
  - quick view of invoiced vs paid progress
- Client portal:
  - show next draw + schedule + status

### 6.4 Acceptance criteria
- A draw can be invoiced with 1 click and appears in:
  - project invoices
  - client portal docs/invoices
- Payment updates draw status correctly

---

## 7) Phase 3 — Budget & Cost Codes Become Real (Job Costing Lite)

Outcome: Builders can set a budget and see variance with minimal overhead.

### 7.1 Features
- Budget builder UI:
  - start from cost code templates (NAHB-style already exists elsewhere in settings)
  - lock/approve budgets (DB already has lock guard triggers)
  - show budget versions (draft vs locked)
- Budget actuals/variance dashboard:
  - budget vs committed vs actual vs invoiced
  - by cost code + rollups
  - variance alerts (acknowledge/resolve)
- Change order integration:
  - approved change orders should adjust budget/contract totals appropriately (decide rules)

### 7.2 DB enhancements
- Ensure budget-related features are queryable:
  - Add `approved_at`, `approved_by` to budgets (if desired beyond `status`)
  - Add indexes:
    - `budget_lines.cost_code_id`
    - `budgets(project_id, status, version)`
- Variance snapshots:
  - ensure a scheduled job creates `budget_snapshots` (daily/weekly)

### 7.3 UI placement
- Project: Financials → Budget
  - editable grid for draft budgets
  - locked budgets read-only with “new version” flow
- Global: Financial → Costing
  - portfolio variance, top overages, active alerts

### 7.4 Acceptance criteria
- A PM can see which cost codes are over budget and why (commitments vs bills vs COs)
- Variance alert can be acknowledged with an audit trail

---

## 8) Phase 4 — Commitments + Vendor Bills (Payables That Don’t Surprise You)

Outcome: Subs submit invoices, office approves, and the system tracks remaining contract value and overages.

### 8.1 Features
- Commitments UI (subcontracts/POs)
  - create commitment, line items, cost code assignment
  - status flow: draft → approved → complete/canceled
  - “remaining” calculation vs billed
- Vendor bills UI (AP)
  - approval queue
  - bill-to-commitment matching
  - over-budget flags
  - payment recording and bill status transitions
- Sub portal invoice submission:
  - already exists; expand visibility for builder office to review/approve

### 8.2 DB enhancements (likely)
Current vendor bills store some info in `metadata` (e.g., paid_at/payment_reference). Promote the most important fields to columns:
- `vendor_bills.approved_at`, `approved_by`
- `vendor_bills.paid_at` (if not using payments table for AP)
- Optional: `vendor_bills.amount_paid_cents` for partial payments

Consider an allocation table if partial payments or split payments become important:
- `payment_applications`
  - `payment_id`, `invoice_id` and/or `bill_id`, `amount_cents`
This prevents overloading `payments` when one payment applies to multiple bills (later).

### 8.3 UI placement
- Global: Financial → Payables
  - list bills, filters (pending approval, due soon, overdue)
  - bill detail: attachments, lines, commitment comparison
- Project: Financials → Commitments/Bills

### 8.4 Acceptance criteria
- Sub submits a bill → builder sees it, approves it, records payment, and:
  - commitment remaining updates
  - project variance updates
  - audit + events are recorded

---

## 9) Phase 5 — Retainage + Lien Waivers as Workflows (Not Just Data)

Outcome: Reduce risk and speed closeout; match what owners and subs expect.

### 9.1 Features
- Retainage visibility:
  - how much held, released, invoiced, paid (client side and internal)
- Lien waiver workflow:
  - request signature (public link), reminders, status tracking
  - attach signed waiver PDFs to payments/projects
- Compliance gates (start as warnings):
  - “cannot mark vendor bill paid until waiver collected” (optional enforcement later)

### 9.2 DB enhancements
- Add “delivery/reminder” tracking for waivers:
  - `lien_waivers.last_reminded_at`, `reminder_count`, `requested_to_email` (or store in metadata)
- If needed, add `retainage.bill_id` for sub retainage (or separate table)

### 9.3 UI placement
- Project: Financials → Retainage / Waivers
- Global: Financial → Reports → Waivers outstanding

---

## 10) Phase 6 — Reporting & Exports (The Spreadsheet Replacement)

Outcome: Office/admin can export standard reports and stop maintaining parallel spreadsheets.

Minimum report set:
- AR aging (invoices due, overdue, paid)
- AP aging (bills due, overdue, paid)
- Budget vs committed vs actual vs invoiced (per project and portfolio)
- Change order log (approved/pending impact)
- Draw schedule status report
- Payments ledger (client payments and vendor payments)

Export formats:
- CSV exports for accounting workflows
- PDF summaries for client/lender updates (optional in v1)

---

## 11) “Killer Features” (Differentiators Worth Doing After Core Works)

Pick 2–3 that match your target customers and execute well.

- **Client financial transparency dashboard** (homeowner language)
  - “Contract total, approved changes, paid to date, remaining, next draw”
- **Progress billing autopilot**
  - upcoming draw notifications → generate invoice → remind → collect
- **Sub compliance autopilot**
  - invoice submission requires W9/COI/waiver status to be “ready to pay”
- **Variance early warning**
  - alert when commitments + bills exceed budget by threshold, with clear drilldown

---

## 12) Open Decisions (Decide Early)

1) **Strata as source of truth vs QBO**
   - Recommendation: Strata = operational truth; QBO = accounting ledger.
2) **Partial payments complexity**
   - If common, plan for `payment_applications` earlier.
3) **Budget adjustment rules**
   - Do approved COs automatically adjust budgets? If so, how (by cost code line mapping)?
4) **Commitment types**
   - Single `commitments` table can represent subcontract vs PO; decide if a `commitment_type` column is needed.

---

## 13) Next Step (Start Here)

Start with Phase 0 + Phase 1:
- Reconcile schema so invoices/payments/QBO flows are solid and query-safe.
- Make Receivables fully end-to-end with reminders/late fees surfaced in UI.
- Then ship Draw schedule UI (Phase 2) because it directly drives “get paid faster” and client trust.


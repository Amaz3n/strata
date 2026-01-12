# Combined Project Money Loop Plan (SWFL MVP + Financials Gameplan)

Intent: Merge the SWFL MVP scope with the financials gameplan into one staged, project-loop-first execution plan. This keeps Strata as the operational finance system while QBO remains the accounting ledger. This plan is LLM-optimized: explicit stages, concrete deliverables, and acceptance checks.

Important prerequisite: Any DB changes require a complete DB scan using Supabase MCP to compare live schema vs repo migrations. MCP is not available in this environment, so DB scan steps are defined but not executed here.

---

## Stage 0 - Database Scan and Schema Reconciliation (Non-Negotiable)

Goal: Ensure code and schema align so financial flows do not fail at runtime.

Prerequisite (must be done first):
- Run a full DB scan with Supabase MCP to compare:
  - Live DB schema
  - `supabase/schema.sql`
  - `supabase/migrations/*`
- Identify drift, missing tables, missing columns, mismatched types, missing indexes.

Changes to make after DB scan:
- Add missing invoice columns used by services:
  - `token`, `title`, `notes`, `client_visible`, `sent_at`, `sent_to_emails`, `subtotal_cents`, `tax_cents`, `viewed_at`
- Add `invoice_views` table + indexes for view tracking.
- Add indexes for AR/AP/draw queries:
  - `invoices(org_id, status, due_date)`
  - `vendor_bills(org_id, status, due_date)`
  - `draw_schedules(org_id, project_id, status, due_date)`
- Confirm `reminder_deliveries` and `late_fee_applications` exist and match usage.

Acceptance:
- Clean DB can run invoices and payments flows without missing column/table errors.

---

## Stage 1 - Project Money Loop (Draw -> Invoice -> Payment)

Goal: Builders can bill draws and get paid end-to-end, with portal visibility.

Deliverables:
- Draw schedule builder UI:
  - Create/edit draws with amount or percent, due date, and description.
- Generate invoice from draw:
  - Use `draw_schedules` to create an invoice and link to draw.
- Payment updates draw status:
  - When invoice is paid (or partially paid), update draw status and paid/invoiced amounts.
- Client portal:
  - Upcoming draws and payment history visible on the portal home.

Changes:
- Service integration: connect invoice payment events to draw updates.
- UI integration: project financials tab exposes draw schedule and quick invoice actions.

Acceptance:
- Draw created -> invoice generated -> payment received -> draw status updates.

---

## Stage 2 - Receivables (AR) Completion

Goal: Invoices actually collect, track status, and surface reminders.

Deliverables:
- Invoice lifecycle: draft -> sent -> partial -> paid -> overdue -> void.
- Sending workflow:
  - Email + portal link + view tracking.
- Reminders + late fees UI:
  - Configure rules per org/project.
  - Surface reminder history in invoice details.
- Receipts:
  - Auto-generate or attach receipt data to payment records.

Changes:
- Ensure balance recalculation respects partial payments.
- Add partial status logic when balance remains.
- Ensure invoice detail UI shows payments, reminders, and view history.

Acceptance:
- Send invoice -> receive partial -> status is partial -> final payment -> status paid.

---

## Stage 3 - Job Costing Lite (Budget -> Commitments -> Bills -> Variance)

Goal: Provide simple variance clarity without accounting complexity.

Deliverables:
- Budget builder:
  - Start from template or proposal lines.
  - Lock/approve budget versions.
- Variance dashboard:
  - Budget vs committed vs actual vs invoiced.
  - Variance alerts (non-blocking).
- Cost codes:
  - Required for budget lines, commitment lines, bill lines.

Changes:
- Ensure cost code linkage and rollups are query-safe and indexed.
- Surface variance summary on project financials.

Acceptance:
- PM can see cost code overages and total variance quickly.

---

## Stage 4 - Payables (AP) Workflow

Goal: Track subcontract/vendor bills and approvals at project level.

Deliverables:
- Commitments UI (project-level):
  - Create, line items, status flow, remaining calculation.
- Vendor bills UI (project-level):
  - Approval queue, mark paid, payment reference.
- Sub-portal invoice submission:
  - Flow into AP queue with attachments.

Changes:
- Promote key AP fields from metadata to columns:
  - `vendor_bills.approved_at`, `approved_by`, `paid_at`.
- If partial payments are common, add `payment_applications` table for AP/AR split allocation.

Acceptance:
- Sub submits bill -> office approves -> payment recorded -> commitment remaining updates.

---

## Stage 5 - Retainage + Lien Waivers (Basic Workflow)

Goal: Reduce risk and improve closeout readiness.

Deliverables:
- Retainage creation + release:
  - Track held, released, invoiced, paid.
- Lien waiver workflow:
  - Request -> sign -> store -> link to payments.
- Optional compliance gating:
  - Warnings now, enforce later.

Changes:
- Add waiver reminder tracking fields if needed.
- Add retainage linkage to vendor bills if required.

Acceptance:
- Waiver status is visible on payments and project financials.

---

## Stage 6 - Global Financial Views and Reports

Goal: Replace spreadsheets with simple, exportable views.

Deliverables:
- Global financial center:
  - AR aging, AP aging, payments ledger.
- CSV exports for:
  - AR, AP, variance, draw status, payments.

Changes:
- Add UI routes and tables for global views.
- Ensure required indexes for fast list queries.

Acceptance:
- Office admin can export aging and payments without spreadsheets.

---

## Stage 7 - Attachments Everywhere (Consistency)

Goal: Every core workflow has artifacts and history.

Deliverables:
- Attachments for:
  - Tasks, daily logs, punch items.
- Consistent `file_links` usage.

Acceptance:
- All core entities support attach/remove/download.

---

## Stage 8 - Notifications and MVP Polish

Goal: Demo-ready product with reliable workflows.

Deliverables:
- In-app notifications for approvals, payments, and portal actions.
- Email reminders surfaced in settings and invoice detail.
- Portal QA pass (client + sub portals).
- Seed demo project script for consistent walkthroughs.

Acceptance:
- Demo loop: proposal -> contract -> draw -> invoice -> paid -> portal update.

---

## Stage 9 - QBO Alignment (Ops First)

Goal: Keep QBO as ledger while Strata is ops source of truth.

Deliverables:
- Define sync boundaries and status visibility.
- Add error and retry surfaces for sync failures.

Acceptance:
- QBO sync is transparent, optional, and never blocks project loop.

---

## Open Questions

1) How common are partial/split payments for your builders?
2) Do you need sub retainage in v1 or can it be deferred?
3) Do you need lender-ready draw exports in MVP?


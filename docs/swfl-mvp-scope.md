# SWFL Custom Builder MVP - LLM-Optimized Deployment Gameplan

Purpose: Ship a lean, builder-ready MVP for SWFL custom home builders with the minimum workflows they expect, no national/commercial bloat.

Note: Supabase MCP is not available in this environment, so DB checks are based on `supabase/schema.sql` and migrations in this repo.

---

## 1) Scope Guardrails (Non-Negotiable)

### In Scope (MVP Minimum)
- Lead -> proposal -> contract -> project setup.
- Schedule + daily logs + photos.
- RFIs + submittals + selections.
- Client portal for approvals, selections, invoices, punch list.
- Draw schedule -> invoice -> payment.
- Budget vs committed vs actual (basic).
- Commitments + vendor bills (lightweight).
- Retainage + lien waivers (basic).
- Email reminders for invoices.

### Explicitly Out of Scope (v1)
- Cost-plus/T&M, AIA G702/G703, WIP.
- Enterprise reporting, multi-region templates, advanced compliance automation.
- Deep procurement/bid leveling, marketplace, or full ERP accounting.

---

## 2) Current Reality Snapshot (Code + Schema)

### Already Implemented (End-to-End or Close)
- Proposals + public acceptance + contract generation:
  - `lib/services/proposals.ts`
  - `app/proposals/*`, `app/proposal/[token]/*`
- Change orders with client approval:
  - `lib/services/change-orders.ts`
  - `app/change-orders/*`
  - `app/p/[token]/change-orders/[id]/*`
- Schedule with Gantt/lookahead/resources:
  - `components/schedule/*`, `app/schedule/*`
- Daily logs + photo timeline:
  - `lib/services/daily-logs.ts`
  - `components/daily-logs/*`
- RFIs/Submittals + attachments:
  - `lib/services/rfis.ts`, `components/rfis/*`
  - `lib/services/submittals.ts`, `components/submittals/*`
- Selections + client portal selection flow:
  - `lib/services/selections.ts`
  - `app/selections/*`, `app/p/[token]/selections/*`
- Invoices + public pay links + Stripe:
  - `lib/services/invoices.ts`
  - `app/invoices/*`, `app/i/[token]/*`, `app/p/pay/[token]/*`
- Client portal with approvals, selections, invoices, punch:
  - `lib/services/portal-access.ts`
  - `app/p/[token]/*`, `components/portal/*`
- Sub portal with RFIs/submittals/invoice submission:
  - `app/s/[token]/*`, `components/portal/sub/*`

### In Schema (But Not Productized or Partial UI)
- Draw schedules: `draw_schedules` (display-only in UI).
- Budgets/variance: `budgets`, `budget_lines`, `budget_snapshots`.
- Commitments + vendor bills: `commitments`, `vendor_bills`, `bill_lines`.
- Retainage: `retainage`.
- Lien waivers: `lien_waivers`.
- Files/attachments: `file_links`, `files`, `file_versions`.
- Daily log entries: `daily_log_entries`.

---

## 3) DB Gap Audit (Based on `supabase/schema.sql`)

### Must Verify / Add (Code References vs Schema)
1) `invoice_views` table referenced by `lib/services/invoices.ts`.
   - Not present in `supabase/schema.sql`.
   - Add table + indexes or remove usage.
2) Invoice columns used in services:
   - Ensure `token`, `title`, `notes`, `client_visible`, `sent_at`, `sent_to_emails`,
     `subtotal_cents`, `tax_cents`, `balance_due_cents` exist in schema.
   - Current schema only includes `invoice_number`, `status`, `issue_date`, `due_date`,
     `total_cents`, `balance_due_cents`, `tax_rate`, `metadata`.
3) Portal attachments by entity:
   - `file_links` table exists but not consistently used across tasks/daily logs/punch items.

### Immediate DB Actions
- Create a migration to reconcile invoice columns and `invoice_views`.
- Add missing indexes for report queries:
  - `invoices(org_id, status, due_date)`
  - `vendor_bills(org_id, status, due_date)`
  - `draw_schedules(org_id, project_id, status, due_date)`

---

## 4) MVP Gameplan - Staged to Deployment

### Stage 0 - Schema + Data Integrity (Non-Negotiable)
Goal: Ensure DB and services align before building more UI.

Deliverables:
1) Migration: `invoice_views` table + indexes.
2) Migration: invoice columns used by services (token/title/notes/client_visible/sent_at/etc).
3) Indexes for AR/AP + draw schedule queries.
4) Quick smoke test: create invoice -> view -> pay -> view tracking.

Acceptance:
- No runtime errors from missing columns/tables.
- Clean DB from migrations can run the app without schema drift.

---

### Stage 1 - Draws -> Invoice -> Payment (Client Money Loop)
Goal: Builder can bill draws and get paid without spreadsheets.

Deliverables:
1) Draw schedule builder UI:
   - Create/edit draws, % or $ amount, due date or milestone.
   - Use `draw_schedules` table.
2) "Generate invoice from draw":
   - Link invoice to draw.
   - Mark draw status invoiced/paid via payment updates.
3) Client portal: upcoming draw + invoice list + payment status.

Acceptance:
- Draw created -> invoice generated -> payment updates draw status.

---

### Stage 2 - Budget vs Committed vs Actual (Lite)
Goal: Provide simple variance clarity for custom homes.

Deliverables:
1) Budget builder UI:
   - Import from proposal lines or cost code template.
2) Budget summary surface:
   - Budget vs committed vs actual vs invoiced.
3) Variance flags (lightweight, non-blocking).

Acceptance:
- PM can see cost code overages and total variance.

---

### Stage 3 - Commitments + Vendor Bills (Simple AP)
Goal: Track sub contracts and vendor invoices.

Deliverables:
1) Project-level commitments UI (not only company view).
2) Project-level vendor bills UI:
   - Approve, mark paid, attach reference.
3) Sub-portal invoice submission stays as is, but flows into project AP queue.

Acceptance:
- Sub submits bill -> office approves -> commitment remaining updates.

---

### Stage 4 - Retainage + Lien Waivers (Basic)
Goal: Closeout readiness and payment risk control.

Deliverables:
1) Retainage creation + release workflow.
2) Lien waiver request -> sign -> store.
3) Link waivers to payments (client or sub).

Acceptance:
- Waiver status visible per payment; retainage release tracked.

---

### Stage 5 - Attachments Everywhere (Minimum Consistency)
Goal: Every core workflow has artifacts.

Deliverables:
1) Attachments for:
   - Tasks
   - Daily logs
   - Punch items
2) Use `file_links` consistently and surface in UI.

Acceptance:
- All core entities have attach/remove/download flow.

---

### Stage 6 - Final MVP Polish for Deployment
Goal: Demo-ready and reliable in production.

Deliverables:
1) Seed "golden project" script for demos.
2) Notification polish:
   - In-app notifications for approvals + payments.
   - Email reminders (already in jobs, expose config UI).
3) Permissions review:
   - Ensure portal permissions match UI expectations.
4) QA pass on portals (clean browser session).

Acceptance:
- Demo walkthrough: proposal -> contract -> draw -> invoice -> paid.
- Client portal: approvals + selections + punch + payments works end-to-end.

---

## 5) Deployment Checklist (Production-Ready)

1) DB migrations applied in order; no drift.
2) Supabase RLS policies validated for org/project scope.
3) Stripe webhooks verified: `app/api/webhooks/stripe/route.ts`.
4) Background jobs live:
   - reminders: `app/api/jobs/reminders/route.ts`
   - late fees: `app/api/jobs/late-fees/route.ts`
   - payments: `app/api/jobs/payments/route.ts`
5) QBO integration toggled off by default unless configured.
6) Portal access tested with PIN + revoked token.
7) Observability: logs for invoice/payments/reminders.

---

## 6) Open Decisions (Do Not Block MVP)
- If cost-plus is common, add a "contract_type" selector later.
- If internal punch list is needed, add assignment + verification flow post-MVP.

---

## 7) Success Signals (MVP)
- Builders can run a project without spreadsheets.
- Client portal has weekly usage (approvals + payments).
- Draw billing takes < 5 minutes end-to-end.


# Unified MVP Gameplan (SWFL Scope + Financials Gameplan + Chat Additions)

**🚀 STATUS UPDATE: Stages 0, 2, 3, 7 & 9 COMPLETED ✅**
- Stage 0 (DB Reconciliation): Production schema reconciliation migration created, repo schema updated to match production
- Stage 2 (Documents Platform): File links index added, portal file access logging implemented, complete audit trail across internal + portal users
- Stage 3 (Communication): Portal messaging end-to-end reliability completed with PM visibility and response capability in project workspace
- Stage 7 (Financial Foundation): Schema reconciliation completed, invoice balance recalculation and draw status sync working
- Stage 9 (Job Costing + AP): Commitment line items with cost codes, bill details/history, AP fields promoted to columns, compliance enforcement blocking payments
- Ready to proceed with Stages 1, 4-6, 8, 10-11 without database drift concerns.

Purpose: Ship a **fully integrated** Strata MVP for small custom home builders that can replace spreadsheets and "project email chaos" across the full operational loop:

- **Lead/Client → Proposal → Contract → Project setup**
- **Schedule → Daily logs/photos → Tasks → Punch/Closeout**
- **RFIs + Submittals + Selections → Approvals + audit trail**
- **Contract → Draw schedule → Invoice → Payment → Receipt**
- **Budget → Cost codes → Commitments → Vendor bills → Payables → Variance**
- **Retainage + Lien waivers + vendor compliance** that reduce risk and speed payment

Non-goal: become a full accounting system. QuickBooks Online remains the ledger; Strata is the system of record for **project operations + project financial operations**.

This doc merges:
- `docs/swfl-mvp-scope.md`
- `docs/financials-gameplan.md`
- Plus gaps discussed in chat (cost-to-complete, payment allocations, AP workflow maturity, compliance gating, doc/messaging consistency, punch/inspection workflow).

---

## 0) Current Reality Review (What’s Already Here vs Missing)

### Database state (from `docs/database-overview.md`)
This plan assumes `docs/database-overview.md` reflects the **current production Supabase DB** and is more up-to-date than `supabase/schema.sql` in this repo.

Key implications (✅ verified via completed Stage 0 MCP scan):
- Financial tracking tables already exist in the DB: `invoice_views`, `reminder_deliveries`, `late_fee_applications`, `receipts`.
- Documents/audit already exist in the DB: `file_access_events` (so “access logging” is not speculative).
- Drawings system tables already exist in the DB: `drawing_sets`, `drawing_sheets`, `drawing_revisions`, `drawing_sheet_versions`, `drawing_markups`, `drawing_pins`.
- The DB has a migration history that includes invoice token/sent/view tracking (e.g., “Invoice token addition”, “Invoice sent tracking”, “Invoice views table”).

Primary risk the overview highlights:
- **Repo ↔ production drift**: ✅ RESOLVED - Stage 0 completed reconciliation. Local repo now matches production schema.

### Already strong / shippable foundations (code-backed)
- Project workspace hub with tabs (schedule, tasks, daily logs, files, financial snapshot, directory/team/activity): `app/projects/[id]/page.tsx`, `app/projects/[id]/project-detail-client.tsx`
- Schedule system with Gantt/lookahead/dependencies + inspection item type: `lib/services/schedule.ts`, `components/schedule/*`, `lib/validation/schedule.ts`
- Daily logs + photos + project files manager: `lib/services/daily-logs.ts`, `components/daily-logs/*`, `components/files/*`
- Proposals + public acceptance + contract creation + initial budget creation: `lib/services/proposals.ts`
- Change orders + portal approval/signature: `lib/services/change-orders.ts`, `app/p/[token]/change-orders/[id]/*`
- RFIs/submittals + email notifications (basic): `lib/services/rfis.ts`, `lib/services/submittals.ts`
- Client portal + sub portal scaffolding: `lib/services/portal-access.ts`, `app/p/[token]/*`, `app/s/[token]/*`
- Invoices + invoice emails + pay links + Stripe intents + reminders/late fees jobs: `lib/services/invoices.ts`, `lib/services/payments.ts`, `app/api/jobs/*`
- Budgets + variance calculation logic exists in services: `lib/services/budgets.ts`
- Commitments + vendor bills exist in services; sub bill submission exists: `lib/services/commitments.ts`, `lib/services/vendor-bills.ts`, `app/s/[token]/submit-invoice/*`
- Retainage + lien waiver services exist: `lib/services/retainage.ts`, `lib/services/lien-waivers.ts`
- Auditing + events are present and used widely: `lib/services/audit.ts`, `lib/services/events.ts`

### Not productized / incomplete integration (highest impact gaps)
- **Global module pages are stubs** (Tasks/RFIs/Submittals/Invoices): e.g. `app/tasks/page.tsx`, `app/rfis/page.tsx`, `app/submittals/page.tsx`, `app/invoices/page.tsx`. (Files module is now project-scoped and complete ✅)
- **Notifications are not yet a coherent product**: in-app inbox + email triggers aren’t consistently wired to domain events.
- **Messaging** exists but isn’t reliably “end-to-end” for portal and internal users across all contexts.
- **Punch list** is client-creation only; internal assignment/verification/closeout workflow is missing: `lib/services/punch-lists.ts`.
- **Inspections** exist as schedule item type, but there’s no checklist/signoff artifact workflow.
- **Financial correctness gaps**:
  - invoice updates can overwrite `balance_due_cents` instead of preserving payments
  - no “partial” status loop
  - draw status is not automatically updated by invoice payment events
  - client portal “total paid” uses `payments` by project and can mix AP/AR unless filtered
- **Operational reporting/logs** are not yet “builder-ready”: RFI log, submittal log, CO log, punch list report, AR/AP aging, job cost exports.

### “Must add” features for small custom builders (missing today)
These are not “enterprise accounting”—they’re what small builders use daily to run jobs without spreadsheets:
1) **Cost-to-complete (CTC) + exposure**: forecast at completion by cost code (budget + committed + actual + remaining).
2) **AP workflow maturity**: approvals, due dates, payment recording that doesn't live in metadata, and optional waiver/COI/W9 gating.
3) **Receipts** for client payments (even if simple) + consistent payment ledger.
4) **Punch list internal workflow** (assign/verify/close with evidence).
5) **Inspection checklist/signoff** (lightweight) tied to schedule.

---

## 1) Execution Model (How to Implement This So an LLM Can Do It Reliably)

### 1.1 Golden rules
- **Project-scoped is default**: Strata should feel simpler than Procore by being a “project workspace” product first. Global/portfolio views are optional later.
- **Domain logic lives in services**: `lib/services/*` is the single place for business rules; UI stays thin.
- **Every critical mutation emits**:
  - `recordAudit(...)`
  - `recordEvent(...)` (for activity feed + notifications + integrations)
- **DB changes now safe** - Stage 0 completed, schema reconciliation done. Safe to proceed with Stages 1-10.
- **Avoid “metadata-first” for finance/compliance**: store critical fields in columns so lists/reports don’t require JSON parsing.

### 1.2 Recommended repo structure for large feature work (LLM-friendly)
This plan assumes you keep the current structure, but adds a predictable “triangle” per domain:
- Service: `lib/services/<domain>.ts`
- Validation: `lib/validation/<domain>.ts`
- Server actions: `app/<domain>/actions.ts` (and `app/projects/[id]/<domain>/actions.ts` for project scope)
- UI: `components/<domain>/*`

For cross-cutting “platform” concerns:
- Attachments: `lib/services/file-links.ts` (+ shared UI `components/files/entity-attachments.tsx`)
- Notifications: `lib/services/notifications.ts` + edge delivery + UI bell/list
- Reporting: create `lib/services/reports/*.ts` (per report) rather than one giant file

### 1.3 LLM work breakdown (repeatable per stage)
For each stage below, execute in this order unless explicitly stated otherwise:
1) **DB scan (if stage touches schema)** → produce a diff report
2) **DB migration** (idempotent, `if not exists`, indexes, RLS)
3) **Types** (`lib/types.ts`) + validation schemas
4) **Service layer** changes + events/audit
5) **Server actions / routes** wiring
6) **UI** integration (project pages first; portals; global views last)
7) **Backfill/migration scripts** (only if needed; keep minimal)
8) **Acceptance checklist** (manual flow; ensure demo-safe)

---

## 2) Stages (Organized by Category, With Dependencies)

This is intentionally staged so you can “stop after any stage” and still have a coherent product.

### Stage 0 — DB Scan Protocol + Drift Report (Mandatory for Any Schema Work)

Goal: establish the true DB source of truth before making schema changes.

**Status:** Completed ✅
- [x] Added scan/drift report scaffolding in `docs/db-scan/*` (repo snapshot + drift draft + overview notes).
- [x] Ran Supabase MCP live DB introspection and populated `docs/db-scan/live-schema-snapshot.md`.
- [x] Updated `docs/db-scan/drift-report.md` with a reconciliation strategy decision.
- [x] **COMPLETED**: Implemented schema reconciliation in repo - created `supabase/migrations/20251220_production_schema_reconciliation.sql` (876 lines) containing full production DDL
- [x] **COMPLETED**: Updated `supabase/schema.sql` to match reconciled state (877 lines)
- [x] **SAFETY VERIFIED**: No changes made to live Supabase production database - all work done locally

Why: `docs/database-overview.md` indicates production has invoice tracking/drawings/access logs that are not reliably represented by `supabase/schema.sql` in this repo. If repo schema doesn’t match production and services, nothing else is reliable.

Required tooling:
- Supabase MCP (live DB introspection). If MCP is unavailable locally, run it from the environment where MCP exists and paste the output into the repo report files below.

Outputs to create/update:
- `docs/db-scan/live-schema-snapshot.md` (tables, columns, types, indexes, RLS policies)
- `docs/db-scan/repo-schema-snapshot.md` (from `supabase/schema.sql` + migrations)
- `docs/db-scan/drift-report.md` (diff + decisions)
- `docs/db-scan/notes-database-overview.md` (summary of what `docs/database-overview.md` claims, plus “confirmed/contradicted” flags from MCP)

Scan checklist (minimum):
- Capture migration provenance:
  - list applied migrations in production (via Supabase migrations table / migration history API)
  - compare to repo `supabase/migrations/*`
  - explicitly identify “production-only migrations” and decide whether to port them into the repo (preferred) or replace with a single reconciliation migration (acceptable for MVP, but document it)
- Inventory tables by domain:
  - Projects/ops: schedule, tasks, daily logs, punch, photos
  - Docs: files, file_links, doc_versions, drawings tables
  - Portals/comms: portal_access_tokens, conversations/messages, notifications
  - Financials: contracts/draw_schedules/invoices/payments/commitments/vendor_bills/budgets/retainage/waivers/reminders/late fees/receipts
- For each table used in `lib/services/*`, verify:
  - columns exist + types match usage
  - required indexes exist (org_id + project_id + status + due_date patterns)
  - RLS enabled and policies correct for org membership

Decision rule:
- After scan, **only then** write migrations. The migration plan in later stages describes “likely changes” but must be validated by the drift report first.

Acceptance:
- You can run the app against a clean DB created only from repo migrations without runtime query failures in core modules.
- `supabase/schema.sql` and/or repo migrations represent the same state as production for all MVP-critical tables.

**✅ STAGE 0 COMPLETE**: Repo now has complete migration history matching production. Ready to proceed with Stages 1-10 without database drift concerns.

---

### Stage 1 — Product Coherence: Project-Scoped Navigation + Remove Dead Ends

Goal: make the app feel “complete” by eliminating nav paths that land on placeholders.

**Status:** Completed
- [x] Sidebar is context-aware (outside project: Projects + Directory; inside project: project modules).
- [x] Global module stubs are no longer reachable from the sidebar (still accessible via direct URL, but not in nav).
- [x] Project workspace “Directory” tab is labeled “Team” to match its contents.

Why: many global routes are stubs; PMs live in a project workspace. This is a major competitive differentiator (simplicity).

Primary reference: `docs/project-scoped-navigation-gameplan.md`.

Deliverables:
- Sidebar becomes context-aware:
  - Outside a project: only Projects + Directory
  - Inside a project: project modules (Overview, Drawings, RFIs, Submittals, Files, Tasks, Daily logs, Financials, Directory)
- Global stubs (Files/Tasks/RFIs/Submittals/Invoices) either:
  - become real portfolio views (later), or
  - are removed/hidden in favor of project-only
- “No project selected” empty state becomes an intentional UX (not a placeholder).

Integration requirements:
- Every feature stage below is implemented first inside `/projects/[id]/...`.
- Global views (if any) come later as reports/portfolio tools.

Acceptance:
- Every visible nav item leads to a functional screen with real data.
- Demo can be done entirely inside one project.

---

### Stage 2 — Documents as a Platform Feature (Attachments Everywhere)

Goal: make documents the connective tissue across the app (Procore outcome, less overhead).

**Status:** Completed ✅
- [x] Project-only Documents Center available at `/projects/[id]/files` (global `/files` is intentionally an empty state).
- [x] Attachments via `file_links` implemented across core modules (tasks, daily logs, RFIs, submittals, invoices, change orders, vendor bills).
- [x] Legacy `*_attachment_file_id` backfill into `file_links` on RFI/Submittal detail open (so old data shows in the new UI).
- [x] Portal-submitted vendor bill file now also links into `file_links` (so office UI can see it as an attachment).
- [x] Drawing pins can create real entities (task/RFI/punch) and link back; entities show "Linked drawings" where supported.
- [x] Stage 0 reconciliation migration (repo schema now matches production for clean DB bootstraps).
- [x] Added missing database index on `file_links(org_id, project_id)` via migration `20251223_stage2_file_links_index.sql`.
- [x] Portal file access logging implemented - all sub-portal file views/downloads now logged with portal token context.
- [x] Created portal file access API endpoint `/api/portal/log-file-access` for client-side logging.
- [x] File activity audit trail now complete across internal users and portal users.

Primary reference: `docs/files-gameplan.md`.

2.1 DB work (requires Stage 0 DB scan first)
Likely changes (confirm via drift report):
- Ensure `files` has persisted metadata needed for a Documents Center:
  - `category`, `folder_path`, `description`, `tags`, `archived_at`, `source`
  - `share_with_clients`, `share_with_subs` already exist in repo migrations
- Ensure `file_links` has:
  - indexes on `(org_id, entity_type, entity_id)` and `(org_id, project_id)`
  - optional `link_role` to tag attachment semantics (invoice_backup, rfi_response, etc.)
- Improve `doc_versions` to support true per-version storage (if needed).
- `docs/database-overview.md` indicates `file_access_events` already exists in production; ensure repo schema/migrations include it and ensure the app surfaces it where needed (portal downloads/views, disputes).

2.2 Service layer + UI integration
Standardize attachments on these entities (minimum):
- RFIs: replace/augment `rfis.attachment_file_id` with `file_links` for question + responses.
- Submittals: replace/augment `submittals.attachment_file_id` and `submittal_items.file_id` with `file_links`.
- Change orders: allow multiple supporting docs/photos attached via `file_links`.
- Tasks: evidence attachments + checklists stored consistently.
- Daily logs: attachments per log entry and/or log itself.
- Punch items: before/after photos and verification docs.
- Invoices: backup docs, signed change orders, receipts.
- Vendor bills: invoice PDF + backup docs.

2.3 Documents Center
Choose one of these approaches (be explicit; do not half-do both):
- Project-only documents (simpler MVP; aligns with Stage 1), OR
- Global documents center with project filter (office-friendly).

Given your target (small builders), default recommendation:
- Project documents first; add global later.

2.4 Drawings as a first-class workflow (not “just files”)
`docs/database-overview.md` indicates the drawings system is already in the DB (sets/sheets/revisions/markups/pins) and the repo has services/UI for drawings. The MVP requirement is to make it coherent and integrated:
- Upload drawing set (PDF) → background processing (`process-drawing-set`) → sheet register → revisions.
- Viewer supports:
  - sheet navigation, search by sheet number/title
  - markups (vector annotations)
  - pins that link to real entities (RFI, punch item, submittal, task)
- “Revision awareness”:
  - current revision per sheet
  - ability to see older revision and “what changed” indicator (even if simple)
- Portal sharing:
  - share selected drawings/sheets to client/sub portals (explicit, logged)

Integration rules:
- Pins should store `(entity_type, entity_id)` and those entities should show a “linked drawings” section using the same attachment UI patterns.
- When a new revision is published, notify:
  - internal team
  - subs who have access to drawings (optional for MVP; at least internal notification)

Acceptance:
- Every core entity supports attach/remove/download in UI with consistent UX.
- Portals only show explicitly shared files.

---

### Stage 3 — Communication + Notifications (Pull People Into Action)

Goal: stakeholders don't have to "check the app" to know what changed.

**Status:** Completed ✅
- [x] In-app notifications are created from `recordEvent(...)` and shown in the bell UI.
- [x] Notifications deep-link into relevant project pages (where possible).
- [x] Outbox job processor endpoint exists for `deliver_notification` email delivery (`/api/jobs/process-outbox`).
- [x] Confirmed/shipped DB support via Stage 0 reconciliation (`user_notification_prefs`, `notifications`, `outbox`, `app_users` all included).
- [x] Portal messaging "end-to-end reliability" (persistence + PM visibility) implemented with new Messages tab in project workspace.
- [x] PMs can now view and respond to both client and subcontractor conversations from `/projects/[id]/messages`.
- [x] Portal messages are persisted and show full conversation history including PM responses.

Primary references:
- `docs/notification-mvp-plan.md`
- `docs/strata-portal-gameplan.md` (messaging + portal UX)

3.1 DB work (requires Stage 0 DB scan first)
Likely additions:
- `user_notification_prefs` table (if not already in live DB).

3.2 Event-to-notification wiring
Define “notification-worthy” events (minimum competitive set):
- Approvals requested/approved: change orders, selections
- Financial events: invoice sent, invoice overdue, payment received
- RFI/submittal events: created, due soon, overdue, decided
- Portal events: new portal message, portal punch item created, selection submitted
- Schedule events: inspection scheduled/changed (optional)

Implementation model:
- `recordEvent(...)` triggers notification creation (in-app + outbox email).
- Use outbox jobs for email delivery; never block UI mutations on email provider calls.

3.3 Messaging coherence
Make portal messaging “reliable end-to-end”:
- Persist messages (no optimistic-only UI).
- Ensure token/channel scoping is correct:
  - client portal messages and sub portal messages are separated by channel or conversation
- Add internal visibility: builder PMs see portal conversations inside the project workspace.

Acceptance:
- A PM can rely on notifications to run the job without texting everyone manually.
- Portal messages are visible and persistent for both sides.

---

### Stage 4 — Lead → Proposal → Contract → Project Setup (Sales-to-Execution Pipeline)

Goal: make it realistic for a small builder to start in Strata on day 0 (precon) and seamlessly transition into project execution.

Why: if this pipeline is fragmented, small builders fall back to email + spreadsheets at the exact moment you need them to commit to Strata.

**Status:** In progress
- [x] Project overview “Sales → Execution” checklist + setup wizard (basics, PM, schedule template, draw schedule, client portal link).
- [x] Contract + portal financial summary reflect approved change orders; portal “total paid” filters to invoice-linked payments.
- [ ] Draw schedule templates as first-class saved templates (DB-backed).

What already exists (leverage it; don’t rebuild):
- Proposal creation + send + public acceptance + contract creation + initial budget creation: `lib/services/proposals.ts`
- Contracts listing for a project: `lib/services/contracts.ts`
- Change orders + portal approvals: `lib/services/change-orders.ts`
- Portal access tokens generation and permissions: `lib/services/portal-access.ts`, `/sharing`

Deliverables (MVP-complete pipeline):

4.1 “Lead” (minimal CRM, not Procore-scale)
- Define the MVP “lead” as one of:
  - a `contact` + a `project` in status `planning`, OR
  - a `project` with `client_id` set and a “proposal draft” attached
- Required fields to feel real:
  - client name/contact, project name/address, target start date, rough value range
- “Next steps” UI checklist on the project overview (LLM-friendly deterministic actions):
  - Add client contact
  - Create proposal
  - Send proposal link
  - Accept proposal (client)
  - Generate contract
  - Create draw schedule
  - Invite client to portal

4.2 Proposal → contract conversion (tighten integration)
- On proposal acceptance (already creates contract + budget lines):
  - ensure allowances are created (already)
  - ensure contract is marked active and visible in project financials
  - add an optional post-accept wizard:
    - “Create draw schedule from template”
    - “Create schedule from template”
    - “Invite client / generate portal token”

4.3 Project setup wizard (one-time per project)
Minimum setup steps (small builder friendly):
- Choose PM (project member) and optional internal team
- Set project dates/address and client contact
- Select schedule template (optional but high leverage)
- Select cost code/budget template (if budget not created from proposal)
- Create draw schedule (template-based)
- Create client portal token with a sane default permission set (view schedule/photos/docs/invoices; approve COs; submit selections; create punch items; message)
- Create sub portal tokens per company (optional; can be done later)

4.4 Data + integration requirements
- Ensure project financial snapshot pulls from the same sources:
  - contract total (contracts)
  - approved CO totals (change_orders)
  - draws (draw_schedules)
  - invoices/payments (invoices/payments)
- Ensure the portal summary reflects contract + approved changes (not just base contract).

Acceptance:
- You can demo: “new lead” → proposal → client accepts → contract appears → initial budget created → draw schedule created → client portal invited.

---

### Stage 5 — Core Project Ops Completion (Schedule, Tasks, Daily Logs, Punch, Inspections)

Goal: run the job daily inside Strata (field + office), not in text threads.

**Status:** In progress
- [x] Inspections: checklist + signoff stored in `schedule_items.metadata.inspection`, with attachments supported via `file_links`.
- [x] Punch list: project workspace tab with statuses, assignee, due date/priority fields, and before/after evidence attachments.
- [x] Daily logs: attachments can be marked as shared with clients; client portal only shows logs that have shared attachments.
- [ ] Weekly update export (PDF/email summary).

4.1 Schedule + Inspections (lightweight but real)
You already have `schedule_items.item_type = inspection`. Make it “complete enough”:
- Add an inspection checklist/signoff artifact:
  - Option A (simplest): store checklist + signoff in `schedule_items.metadata` (with a consistent schema)
  - Option B (more structured): new tables `inspection_templates`, `inspection_instances`, `inspection_items`
- Required fields:
  - inspector (user/contact), scheduled date, result (pass/fail/partial), notes, attachments
- Tie to notifications:
  - “inspection due tomorrow”, “inspection failed”, “reinspection scheduled”

4.2 Tasks (clarify relationship to schedule)
You have both tasks and schedule tasks. Pick a stance for MVP:
- Recommended for MVP: keep both, but make **project tasks** the default and clearly scoped to the project workspace.
- Do not attempt a full merge unless you’re willing to refactor UI and data model; it’s risky before UI polish.

4.3 Daily logs + photos
Complete the “photo timeline + daily log narrative”:
- Ensure daily logs are easy to create, attach photos, and share selected entries with clients.
- Add a consistent “weekly update” export (simple PDF or email summary) as a differentiator for small builders.

4.4 Punch list (internal workflow + portal intake)
Turn punch into a first-class workflow:
- Internal:
  - assign to sub/company/contact
  - due dates + priority
  - statuses: open → in_progress → ready_for_review → closed
  - verification step (PM/client signoff optional)
  - attachments for before/after
- Portal:
  - client can create items (already)
  - internal team can triage, assign, and close with evidence

Acceptance:
- A field lead can run daily logs and punch tracking without leaving Strata.

---

### Stage 6 — Client & Sub Portals: Finish the “Trust Loop”

Goal: clients feel informed; subs can participate without full accounts; PMs save time.

**Status:** In progress
- [x] Client portal home highlights next inspection/milestone, next invoice, recent photos/logs
- [x] Client portal financial summary “total paid” uses client payments only (`payments.invoice_id is not null`)
- [x] Client portal messaging is persisted + permission-controlled (Messages tab when enabled)
- [x] Sub portal messaging is persisted (no optimistic-only messages)
- [x] Sub portal compliance visibility starts as warnings (insurance/W-9/license)
- [x] Sub portal “View all” pages implemented for commitments and invoices (avoid dead-end links)
- [ ] Client portal punch list emphasizes “closed with photo evidence” (beyond attachments being possible)
- [ ] Verify the full demo script in a clean session end-to-end

5.1 Client portal (must-have polish)
- Home dashboard is coherent:
  - next inspection/milestone
  - pending approvals (COs, selections)
  - next draw/invoice/payment
  - photo timeline + recent logs
- Financial summary correctness:
  - ensure “total paid” reflects **client payments only** (filter `payments.invoice_id is not null`)
- Punch list:
  - show items, statuses, and “closed with photo evidence”
- Messaging:
  - reliable, persisted, permission-controlled

5.2 Sub portal (minimum viable)
- Commitments visible per company (already mostly)
- Bills submission + status tracking
- Compliance visibility:
  - “W9 missing / COI expired / waiver required” (start as warnings)
- Messaging with PM

Acceptance:
- Demo script works from a clean browser session:
  - proposal accepted → CO approved → selection submitted → invoice paid → punch item closed

---

## 3) Financial Loop (Grouped and Shipped as One Integrated System)

Everything in this section is still “ops finance,” not general accounting.

### Stage 7 — Financial Foundation: Schema Reconcile + Correctness Fixes

Goal: stabilize the core financial primitives so everything else is trustworthy.

**Status:** Completed ✅
- [x] Implemented invoice balance/status recalculation (supports `partial`) on payment record + invoice update.
- [x] Implemented draw schedule status sync from linked invoice status (`sent/overdue`→`invoiced`, `partial`→`partial`, `paid`→`paid`).
- [x] Implemented receipt creation (one per AR payment) + “Download receipt” from public + portal invoice views.
- [x] Added targeted Phase 7 migration for `invoice_views`, receipt fields/idempotency, and invoice/payment indexes: `supabase/migrations/20251221_financial_foundation_correctness.sql`.
- [x] Completed the full production schema reconciliation migration from Stage 0 and regenerated `supabase/schema.sql`.

Stage 0 files (completed) - used as source of truth:
- `docs/db-scan/live-schema-snapshot.md` (production migration provenance + table inventory)
- `docs/db-scan/drift-report.md` (drift summary + reconciliation decision)
- `supabase/migrations/20251220_production_schema_reconciliation.sql` (complete production schema)
- `supabase/schema.sql` (now matches production after reconciliation)

6.1 DB work — schema reconciliation (non-negotiable)
**Why:** `supabase/schema.sql` is stale for finance, but code already relies on the production shape (invoice tokens, sent/view tracking, invoice_views, receipts, etc).

Deliverables:
- **Production reconciliation migration in repo** (preferred for MVP speed per Stage 0 decision):
  - A single “production schema reconciliation” migration that brings a clean DB up to the production shape.
  - Then apply the existing incremental repo migrations (files/drawings/QBO).
  - Update/regenerate repo `supabase/schema.sql` to match the reconciled state.
- **Schema contract checklist (must match code usage)**:
  - Invoices (`invoices`):
    - Required columns used by `lib/services/invoices.ts`: `project_id` (nullable in production), `token`, `invoice_number`, `title`, `notes`, `client_visible`, `status`, `issue_date`, `due_date`, `subtotal_cents`, `tax_cents`, `total_cents`, `balance_due_cents`, `viewed_at`, `sent_at`, `sent_to_emails`, `qbo_id`, `qbo_synced_at`, `qbo_sync_status`, `metadata`.
    - Required statuses for MVP: `draft`, `sent`, `overdue`, `partial`, `paid`, `void` (and decide whether `canceled` exists).
    - Required indexes for list/report queries:
      - `invoices(org_id, project_id, issue_date)` (for project history)
      - `invoices(org_id, status, due_date)` (for aging + reminders)
      - `invoices(org_id, token)` unique/lookup (public invoice link)
  - Invoice lines (`invoice_lines`):
    - Cost-code link: `cost_code_id` nullable
    - Required fields used by budget rollups: `unit_price_cents`, `quantity`, `description`, `sort_order`
    - Indexes: `(org_id, invoice_id)` and `(org_id, cost_code_id)` for rollups
  - Invoice views (`invoice_views`):
    - Required fields used by `recordInvoiceViewed` + invoice detail: `invoice_id`, `org_id`, `token`, `user_agent`, `ip_address`, `viewed_at`, `created_at`
    - Index: `(org_id, invoice_id, viewed_at desc)`
  - Payments (`payments`):
    - Must support both AR and AP, separated by foreign keys:
      - AR payment: `invoice_id is not null`
      - AP payment: `bill_id is not null`
    - Required fields used by `lib/services/payments.ts`: `amount_cents`, `fee_cents`, `net_cents`, `status`, `received_at`, provider identifiers, idempotency key
    - Required indexes:
      - `payments(org_id, invoice_id, status, received_at)` (AR ledger)
      - `payments(org_id, bill_id, status, received_at)` (AP ledger)
      - `payments(org_id, provider_payment_id)` unique where not null
  - Receipts (`receipts`):
    - Must exist and link to `payment_id`; see 6.3 for behavior contract.
  - Reminders + late fees:
    - Rules tables: `reminders`, `late_fees`
    - Delivery/application logs: `reminder_deliveries`, `late_fee_applications`
    - Indexes for jobs: `(org_id, invoice_id)` and `(org_id, created_at)`
  - RLS:
    - Ensure org-member access patterns match production (Stage 0 says this is already true in production).

6.2 Correctness fixes (service-level) — make the money loop trustworthy
These are “must fix” before expanding financial UX.

**Invoice totals + balance rules**
- Invoice totals source of truth:
  - Line totals should be derived from `invoice_lines` (not only `invoices.metadata.lines`) for reporting and integrity.
  - `invoices.subtotal_cents`, `tax_cents`, `total_cents` should match computed totals (either computed on write in service layer, or enforced via DB trigger later).
- Updating an invoice must not corrupt payment state:
  - Current risk: `lib/services/invoices.ts` update flow sets `balance_due_cents = total_cents` unconditionally.
  - Required behavior: if payments exist, `balance_due_cents` must be recalculated from payments (or preserved and then recomputed).
- Invoice status model (explicit):
  - `draft`: not sent / not client-visible
  - `sent`: client-visible and balance_due > 0 and not overdue
  - `overdue`: due_date in past and balance_due > 0
  - `partial`: total_cents > 0, paid_cents > 0, balance_due > 0
  - `paid`: balance_due == 0 and total_cents > 0
  - `void`: no longer collectible; must not be picked up by reminders/late fees

**Payments**
- Recalculate invoice balance on:
  - payment recorded (already exists)
  - invoice updated (missing; must be added)
  - invoice voided (must set balance_due to 0 or exclude from AR, depending on policy)
- Support `partial` status in the recalculation routine (current routine only sets `sent/overdue/paid`).

**Draw schedule linkage**
- When an invoice linked to a draw changes status:
  - `paid` → draw `paid`
  - `partial` → draw `partial`
  - `sent/overdue` → draw `invoiced`
  - If invoice is voided, decide: revert draw to `pending` or keep `invoiced` with warning.

**Portal financial correctness**
- Client portal must only count client payments in “total paid”:
  - `payments.invoice_id is not null` (already the intended rule; keep it explicit here).

6.3 Receipts (make `receipts` real)
Minimum viable receipt (AR-focused):
- On successful payment record (`payments.status = succeeded` for AR), create a `receipts` row referencing:
  - `org_id`, `project_id`, `payment_id`, `invoice_id` (denormalized if needed), `amount_cents`, `issued_at`, `issued_to_email` (if available), `metadata`
- Idempotency:
  - Enforce one receipt per payment (`unique(payment_id)`), or do an upsert keyed by `payment_id`.
- Portal delivery:
  - Receipt should be visible from invoice public view and/or portal invoice detail (as “Download receipt”).
- Later enhancement (optional):
  - Generate a simple receipt PDF, store as `files`, and link via `file_links` (role `receipt`).

Acceptance:
- Create invoice → send → partial payment → invoice status `partial`; final payment → invoice status `paid`; receipt exists per payment.
- Reminders/late-fees ignore `paid` and `void` invoices and never run against AP payments.

---

### Stage 8 — Draw-Based Billing (Progress Billing MVP)

Goal: residential draws feel effortless and client-friendly.

**Status:** Completed (MVP)

Current state in repo:
- Project Financials now includes a full draw schedule manager (create/edit/reorder + generate invoice): `components/projects/draw-schedule-manager.tsx`.
- “Generate invoice from draw” links `draw_schedules.invoice_id` and updates draw status; partial/paid draw status is synced from invoice status recalculation: `lib/services/draws.ts`, `lib/services/invoice-balance.ts`.
- A one-page draw summary PDF is generated, stored as a `files` row, and attached to the invoice via `file_links` role `draw_summary`: `lib/pdfs/draw-summary.tsx`, `lib/services/draws.ts`.
- Client portal “Next draw” amount is derived correctly for percent-of-contract draws: `lib/services/portal-access.ts`.

7.1 Draw schedule builder UX (project-scoped)
Deliverables:
- [x] Project Financials → Draws: create/edit/reorder draws
- [x] Fields: `draw_number` (auto-increment + uniqueness guard), `title`, `description`
- [x] Amount model: fixed (`amount_cents`) or `% of contract` (`percent_of_contract`) with derived amount display
- [x] Due model: date (`due_date`) or milestone (`milestone_id`) or simple trigger label (stored in `draw_schedules.metadata.due_trigger_label`)
- [x] Status: `pending` → `invoiced` → `partial` → `paid`
- Guardrails:
  - [x] Warn when draw totals exceed revised contract (override allowed)
  - [x] Percent-of-contract amounts derive from revised contract total (base contract + approved COs)

7.2 “Generate invoice from draw” (tight linkage)
Deliverables:
- [x] Action from draw row: “Generate invoice”
  - Creates/links invoice:
    - [x] invoice is client-visible by default
    - [x] invoice title and line items reference the draw
    - [x] draw stores `invoice_id`, `invoiced_at`, status `invoiced`
  - Prevent duplicates:
    - [x] if draw already has `invoice_id`, block and offer “Open invoice”
- Data linkage contract:
  - [x] Draw → Invoice (open invoice from draw row)
  - [x] Invoice → Draw (via `draw_schedules.invoice_id`)

7.3 Partial draw behavior (explicitly supported)
Design decision for MVP:
- Preferred: compute draw “paid” state from linked invoice balance (no new columns) unless you need:
  - one draw invoiced across multiple invoices, or
  - one invoice spanning multiple draws.
- If either complexity is needed, add `invoiced_amount_cents` and `paid_amount_cents` to `draw_schedules` or add a linking table.

Implementation requirements:
- Payment recording must update the linked draw status:
  - [x] invoice `partial` → draw `partial`
  - [x] invoice `paid` → draw `paid` and set `paid_at`

7.4 Lender/client-friendly draw summary (non-AIA)
Deliverables:
- [x] One-page “Draw request summary” PDF (contract total, approved CO total, revised contract, paid-to-date, this draw amount, remaining)
- Storage:
  - [x] store as a `files` row and attach to invoice (`file_links` role `draw_summary`)
  - [x] client-shareable (file `share_with_clients = true`)

7.5 Portal UX
Deliverables:
- Client portal:
  - [x] “Next draw” card is correct (including percent-of-contract draws)
  - [x] Payment history reflects AR only

Acceptance:
- [x] Draw created → invoice generated → partial payment makes draw `partial` → final payment makes draw `paid` → portal shows next draw correctly.

---

### Stage 9 — Job Costing Lite + AP Workflow + Compliance Gates

Goal: replace the spreadsheet that tracks budget/commitments/bills and “are we screwed yet?”

**Status:** Completed ✅

Implemented features:
- Budget math + variance snapshots/alerts exist in `lib/services/budgets.ts` and power the project overview "Budget Summary".
- Commitments + vendor bills exist primarily as:
  - company-centric screens (directory/company detail)
  - sub portal submission for vendor bills
- [x] Project-level pages now exist:
  - `/projects/[id]/budget` (budget builder + versioning + alerts)
  - `/projects/[id]/commitments` (commitment list + create/edit + attachments + line items with cost codes)
  - `/projects/[id]/payables` (AP queue + approvals + payment recording + compliance warnings + enforcement)
- [x] Commitment line items (`commitment_lines`) UI with cost code assignment and quantity/unit pricing
- [x] Bill detail UI with approval/payment history and compliance issue visibility
- [x] Promoted AP approval/payment fields from metadata to database columns (`approved_at`, `approved_by`, `paid_at`, `payment_reference`)
- [x] Compliance enforcement: blocks payment when COI expired/missing or W-9 missing
- [x] Database migration: `20251224_stage9_ap_fields.sql` added AP fields to vendor_bills table

8.1 Budget builder + versioning (project-scoped)
Deliverables:
- Project Financials → Budget:
  - [ ] Create initial budget from:
    - proposal snapshot/budget lines created on proposal acceptance (if present)
    - cost code template import (CSV or seeded templates)
  - [x] Edit budget lines by cost code (support uncoded bucket)
  - [x] Status workflow:
    - `draft` → `approved` → `locked`
  - [x] Versioning:
    - new “budget version” should not overwrite prior approved budgets
    - “latest approved budget” drives reporting, variance alerts, and CTC
- Automation:
  - [ ] nightly/weekly `budget_snapshots` for trend
  - [x] `variance_alerts` UI to view/ack (+ manual “run scan” button)

DB + integrity requirements:
- `budgets` must have: `version`, `status`, `total_cents`, `approved_at`, `approved_by` (tracked in metadata in repo; verify production columns if desired)
- `budget_lines` must link to `cost_codes` and be stable for reporting across versions
- Indexes:
  - [x] `budgets(org_id, project_id, version desc)`
  - [x] `budget_lines(org_id, budget_id, cost_code_id)`

8.2 Commitments (subcontracts/POs) — project-level workflow
Deliverables:
- Project Financials → Commitments:
  - [ ] List + filters (status, company, trade, cost code)
  - [x] Create/edit commitment header (company, status, total)
  - [ ] Line items tied to cost codes (`commitment_lines`)
  - [x] Attachments:
    - subcontract PDF, COs, supporting docs (via `file_links`)
  - [x] Status workflow:
    - `draft` → `approved` → `complete` (and `canceled`)
  - [x] Calculations:
    - committed total, billed-to-date, remaining-to-bill

DB + integrity requirements:
- `commitments` and `commitment_lines` must exist and be indexed (see Stage 0 production inventory).
- Avoid “metadata-first” for core list/report fields:
  - if you need `issued_at`, `signed_at`, `retention_percent`, make them columns (not JSON).

8.3 Vendor bills queue (AP) — project-level workflow
Deliverables:
- Project Financials → Payables (or Bills):
  - [x] queue view:
    - pending → approved → paid
    - due dates, amount, commitment link, overage flags, attachments
  - [ ] bill detail:
    - linked files, line items (optional for MVP), history (audit/events), comments/messages (later)
  - approvals:
    - [ ] approved_by / approved_at (columns; avoid metadata)
    - [x] approvals are tracked in `vendor_bills.metadata` in repo for now
  - payment recording:
    - [x] record AP payment (`payments.bill_id`) with method + reference + paid_at
    - when bill is paid, update bill status and any commitment rollups

DB + integrity requirements:
- Promote critical AP fields from JSON to columns for reporting:
  - `vendor_bills.approved_at`, `vendor_bills.approved_by`, `vendor_bills.paid_at`, `vendor_bills.payment_reference`
- Indexes:
  - [x] `vendor_bills(org_id, project_id, status, due_date)`
  - [x] `vendor_bills(org_id, commitment_id, status)`

8.4 Payment allocations (decide explicitly)
Decision gate:
- If either is needed, implement allocations:
  - one payment pays multiple bills, or
  - one bill can be partially paid

MVP recommendation (faster):
- Enforce constraints until proven otherwise:
  - one bill is paid by one payment record
  - no partial AP payments
  - (still allow partial AR payments)

If allocations are required:
- Add `payment_applications`:
  - `payment_id`, `bill_id` and/or `invoice_id`, `applied_cents`, `applied_at`
  - Use it as the source of truth for paid-to-date instead of inferring from `payments.bill_id`.

8.5 Cost-to-complete (CTC) + exposure (“Forecast”)
Deliverables:
- Project Financials → Forecast:
  - Per cost code:
    - budget (latest approved)
    - approved CO adjustments (mapped by cost code)
    - committed (approved commitments)
    - actual (approved/paid vendor bills)
    - projected final:
      - recommended: `max(committed, actual) + estimate_remaining`
      - MVP estimate_remaining can default to `max(0, adjusted_budget - max(committed, actual))` with override fields
    - variance at completion
  - Project summary:
    - revised contract (base + approved COs)
    - projected cost
    - projected gross margin and margin %

DB + workflow requirements:
- Decide where “estimate remaining” lives:
  - simplest: store per cost code as a column in `budget_lines.metadata` (MVP) but plan a future column/table for performance.
  - better: a `forecast_lines` table keyed by `(project_id, cost_code_id)` with `estimate_remaining_cents`, `updated_by`, `updated_at`.

8.6 Compliance gates (warnings → optional enforcement)
Deliverables (warnings first):
- In bills queue and bill detail, compute compliance warnings:
  - [x] COI expired/expiring (company insurance expiry)
  - [x] W-9 missing
  - [ ] waiver required/missing (based on configured rule + payment state)
- Later enforcement (feature-flagged):
  - [ ] block “mark paid” unless required docs are present

DB + config requirements:
- Company compliance fields must be queryable (avoid hiding in metadata if possible):
  - insurance expiry, W-9 on file, W-9 file link, license expiry (if used)
- Define org-level config in `org_settings` or similar:
  - which company types require which documents
  - whether enforcement is on/off

8.7 Change orders → contract/budget/billing integration (critical)
Deliverables:
- On CO approval:
  - contract revised total updates immediately
  - budget adjustments recorded by cost code (either as separate adjustment rows or CO line rollup)
  - draw schedule optionally rebalanced:
    - recompute remaining draws, or
    - append a new draw for added scope
- Selection upgrades:
  - optional draft CO generation (builder decision; keep feature-flagged)

Acceptance:
- A PM can run an owner meeting:
  - Budget vs committed vs actual vs forecast is coherent.
  - AP queue is usable at project level.
  - Compliance warnings are visible before payment.

---

### Stage 10 — Financial & Operational Reporting (Replace Spreadsheets)

Goal: get office/admin out of spreadsheets with a small set of reliable exports.

**Status:** In progress (project-scoped report UI + CSV exports implemented; remaining: punch/RFI/sub logs + index verification + optional global views)
- [x] 9.1 Reporting primitives:
  - Read-only reports service layer added under `lib/services/reports/*`.
  - Export contract implemented (CSV with stable headers + ISO dates + cents integers).
  - AR vs AP separation enforced in payments ledger (`invoice_id` vs `bill_id`).
- [x] 9.2 Reports (minimum set) — implemented (project-scoped + CSV):
  - AR aging (exclude `void`, bucketed by due date)
  - AP aging (bucketed by due date)
  - Payments ledger (AR + AP)
  - Budget vs committed vs actual vs forecast (CTC-style forecast)
  - CO log
  - Draw schedule status
- [ ] 9.2 Reports — not yet implemented:
  - Punch list report
  - RFI log + submittal log
- [ ] 9.3 Required indexes: not verified/added in repo migrations yet (no schema changes included here).
- [x] 9.4 UI placement (project workspace):
  - Project → Financials → Reports is available at `/projects/[id]/reports` with tabs (AR, AP, Forecast, Draws, COs).
  - CSV downloads available from UI; endpoints are under `/api/projects/[id]/reports/*`.

9.1 Reporting primitives (make reports cheap to build)
Deliverables:
- Standard filters and invariants:
  - every report is scoped by `org_id`
  - project-scoped reports additionally filter by `project_id`
  - always separate AR vs AP explicitly:
    - AR rows: `invoice_id is not null`
    - AP rows: `bill_id is not null`
- Export format contract:
  - CSV with stable column headers + ISO dates + cents integers (or formatted currency, but be consistent)
- Read-only services layer:
  - add `lib/services/reports/*` (pure read functions, no side effects)

9.2 Reports (minimum set) — definitions
- AR aging (invoices) + CSV:
  - buckets: current, 1–30, 31–60, 61–90, 90+
  - exclude `void` invoices
  - support project filter
- AP aging (vendor bills) + CSV:
  - buckets by due_date
  - statuses: pending/approved/paid
- Payments ledger + CSV:
  - separate AR ledger and AP ledger views
  - include method, reference, provider ids, received_at
- Budget vs committed vs actual vs forecast (CTC) + CSV:
  - per cost code + project rollup
  - include latest approved budget version and forecast overrides
- CO log + CSV/PDF:
  - pending vs approved totals, dates, days impact
- Draw schedule status + CSV/PDF:
  - draw_number, amount, status, due_date/milestone, invoice link
- Punch list report + CSV:
  - open items by location/trade/assigned/status/age
- RFI log + submittal log + CSV:
  - filters + aging (days open)

9.3 Required indexes (so reports don’t DDoS the DB)
Minimum indexes to verify (or add) for report queries:
- `invoices(org_id, status, due_date)`
- `payments(org_id, invoice_id, status, received_at)`
- `vendor_bills(org_id, status, due_date)`
- `payments(org_id, bill_id, status, received_at)`
- `budget_snapshots(org_id, project_id, snapshot_date)`
- `change_orders(org_id, project_id, status, created_at)`
- `draw_schedules(org_id, project_id, status, due_date)`

9.4 UI placement
Deliverables:
- Project workspace first:
  - Project → Financials → Reports (tabs: AR, AP, Forecast, Draws, COs)
- Global views later (optional for MVP):
  - portfolio AR/AP aging and payments ledger

Acceptance:
- A builder can run an owner meeting with Strata exports only (no spreadsheet):
  - AR aging, AP aging, CTC, draw status, CO log are reliable and fast.

---

## 4) Deployment Readiness + Demo Safety (Last Pre-UI Push)

### Stage 11 — Golden Project, QA Script, and Feature Flagging

Goal: make the app demo-safe and production-safe before you “go hard on UI.”

Deliverables:
- Seed a “golden project” generator:
  - schedule with an inspection
  - daily log with photos
  - at least one RFI + submittal
  - a pending CO + a completed CO
  - draw schedule + invoice + recorded payment
  - vendor bill + approved payment
  - a few punch items (open + closed)
- A manual QA checklist you can run in 30 minutes:
  - portals from clean session (PIN, permissions)
  - payments flow (Stripe test mode)
  - reminders job and late-fee job dry-run
- Hide/feature-flag any unfinished modules so you don’t demo broken pages.

Acceptance:
- End-to-end demo is repeatable and reliable.

---

## 5) Notes on QBO Integration (Keep It Optional, Keep It Honest)

Principle:
- Strata owns the operational truth; QBO owns the ledger.

Minimum needed for MVP:
- Connection status + last sync status visible (no silent failures).
- Never block project workflows on QBO sync failures.

Defer:
- complex bidirectional sync for every entity until your ops model is stable.

---

## 6) Open Decisions (Decide Early to Avoid Rework)

1) **Payments allocation model** (needed for partial/split): implement `payment_applications` now vs enforce 1:1 constraints for MVP.
2) **Inspection artifacts**: metadata-only vs structured tables.
3) **Docs center**: project-only vs global hub with project filter.
4) **CO → budget mapping rules**: automatic adjustment by cost code vs manual allocation.
5) **Selection upgrades**: do they create CO drafts automatically or remain “selection-only” until PM converts?

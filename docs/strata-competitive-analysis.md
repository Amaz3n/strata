# Strata Competitive Analysis vs Procore & Buildertrend (Local-Scale)

## Executive Summary

Strata is already a credible “project hub + portals + approvals + payments” product with strong technical foundations. However, it is not yet competitive with Procore/Buildertrend on the minimum essentials because core workflows are not consistently connected end-to-end:

1) **Documents as a system** (attachments + versioning + audit trail across RFIs/submittals/COs/tasks/logs)
2) **Communication + notifications** (so stakeholders don’t have to “check the app”)
3) **A complete money loop** (budget → commitments/vendor bills → actuals/variance → progress billing/draws → payments)

The fastest path to early local customers is not matching all Procore/BT modules. It’s making the essentials feel “real,” consistent, and demo-safe.

---

## What Strata Already Has (Code-Backed)

### Internal Builder App (shipped UI)
- Dashboard with onboarding + activity feed
- Projects list + project detail hub:
  - schedule (including Gantt/lookahead/dependencies)
  - tasks (project-level tasks are richer than the global tasks page)
  - daily logs with weather selection + photo attachments
  - project file manager (upload/list/view/download + sharing hooks)
  - financial snapshot (contract, draws, retainage, budget summary)
  - team/directory + project vendors
- RFIs (basic create/list/status)
- Submittals (basic create/list/status)
- Proposals + public acceptance (signature)
- Change orders + client approval (signature)
- Invoices + public pay links (Stripe) + view tracking
- Directory (companies/contacts) + team management
- Cost code manager UI
- QBO integration plumbing (connection + sync scaffolding)

### Portals (shipped UI)
- Client portal (`/p/[token]`) with PIN protection, progress/lookahead, approvals (COs), selections, punch list entry, invoices/payment access
- Sub portal (`/s/[token]`) framework with docs + RFIs/submittals + invoice submission flow

### Automation/integrations (exists at least partially)
- Invoice reminders + late fees exist as job endpoints (email reminders are real; SMS is not implemented)
- Lien waiver service exists (create + sign flows), but is not fully productized in UI/workflows

---

## Competitive Baseline: What’s Missing vs What’s Not Productized Yet

This replaces blanket “missing” lists with a clearer breakdown to prevent rebuilding things that already exist.

### Already implemented (in UI today)
- Draw schedules + retainage + budget summary appear in project financials
- Daily logs include weather + photo attachments (not text-only)
- Schedule supports inspection-type items (but not a full inspection workflow)
- Automated invoice reminders and late fee application exist (email reminder delivery; SMS stubbed)

### Exists in services/schema but not a coherent product workflow yet
- Commitments/vendor bills/budgets: core services exist, but the workflow/UX is not yet “end-to-end obvious” and reportable
- Lien waivers: services exist, but collection/automation/UI are incomplete
- Notifications: activity feed exists, but a unified “notifications inbox + email delivery for key events” is not yet a product feature

### Actually missing at a minimum-competitive quality bar
- Attachments + versioning + audit trail consistently across RFIs/submittals/COs/tasks/daily logs
- Progress billing UX: “draw → generate invoice → notify client → pay → payment history”
- Punch list as a first-class internal workflow (assignment, verification/closeout evidence, reporting)
- Construction “logs” and exports that builders expect (RFI log, submittal log, CO log, invoice aging, punch list)

---

## Critical Gaps: Why You’re Not Minimum-Viable Competitive Yet

### 1) Documents are not consistently first-class across modules
**Impact:** Procore/BT become the “source of truth” because every process has artifacts attached and tracked.

**Minimum essentials needed:**
- Attachments for RFIs/submittals/COs/tasks/logs with a visible audit trail
- Basic versioning/revisions for submittals (and ideally key documents)

**Demo credibility risk:**
- The top-level Files page currently reads as unfinished even though project-level files exist.

### 2) Communication + notifications are below baseline
**Impact:** Without reliable notifications, adoption stalls because people keep working in email/text and only “visit the app occasionally.”

**Minimum essentials needed:**
- In-app notification inbox + email notifications for:
  - portal messages
  - approvals requested/approved (COs, selections)
  - RFI/submittal created, due soon, overdue
  - invoices sent/paid/overdue (unify with the existing reminder machinery)
- Messaging that is reliably persisted end-to-end for both client and sub portals

### 3) Financial operations need a full loop (not just invoices)
**Impact:** Builders buy Procore/BT because they can answer “Am I making money and what’s the risk?” quickly.

**Minimum essentials needed:**
- Budget setup tied to cost codes/categories
- Commitments/subcontracts/POs tied to budget lines
- Vendor bills tied to commitments/cost codes with overage warnings
- Simple but trustworthy budget vs committed vs actual vs invoiced variance reporting
- Progress billing workflow that turns draw schedules into invoices and client-facing upcoming payments

### 4) Construction workflows feel present but not complete
**Impact:** Users like the UI but still run jobs in spreadsheets/text.

**Minimum essentials needed:**
- Punch list internal workflow (create/assign/verify/close with photo evidence)
- Inspection workflow layer (checklists/signoff/attachments/reminders), not only schedule labeling
- RFI/submittal “log quality” (filters, aging, ownership, due date enforcement, escalation rules)

---

## Demo Readiness (What to Fix or Hide Before Client Meetings)

### Safe to demo (strong narratives)
- Project detail hub: schedule → daily logs/photos → tasks → financial snapshot
- Client portal: PIN → progress/lookahead → CO approval/signature → invoice pay
- Sub portal: invoice submission + docs access (only if stable end-to-end)

### Avoid demoing until it’s real
- Any unfinished primary nav destination (especially global Files)
- Any messaging surface that isn’t persisted end-to-end (avoid “optimistic-only” experiences)
- Any placeholder module that conflicts with richer project-level experiences

### Pre-demo checklist
- Every sidebar item leads to a polished, functional screen
- One “golden project” seeded with:
  - schedule items (including an inspection)
  - daily log photos
  - a change order pending approval
  - draw schedule + at least one invoice + a recorded payment
- Portals tested from a clean browser session (token, PIN, approval, payment)

---

## What You Need to Be Minimum-Viable Competitive (Local Scale)

To compete credibly with Procore/Buildertrend at a smaller/local scale, Strata needs:

1) **Documents everywhere:** attachments + basic versioning + audit trail across core entities
2) **Unified notifications:** in-app inbox + email for approvals/messages/due dates
3) **Progress billing flow:** draw → invoice → notify → pay → history
4) **Light job costing loop:** budget + commitments + vendor bills → variance reporting
5) **Punch list workflow:** internal tracking + client-submitted items unified

Everything else (AI, predictive analytics, full offline, benchmarking) is a later differentiator, not table stakes for first customers.

---

## Roadmap (Focused on Connecting What’s Already Built)

### Phase 1 — Make it coherent (2–4 weeks)
1. Remove/hide unfinished nav endpoints for demos; eliminate obvious “coming soon” surfaces.
2. Ship unified notifications: in-app inbox + email delivery for top triggers (approvals/messages/RFI-submittal due dates/invoice events).
3. Make portal/sub messaging fully end-to-end reliable.

### Phase 2 — Docs as a platform feature (3–6 weeks)
1. Attachments for RFIs/submittals/COs/tasks/daily logs.
2. Lightweight version history + audit trail.

### Phase 3 — Complete the money loop (4–8 weeks)
1. Budget → commitments → vendor bills → variance dashboard.
2. Draw → invoice generation + client upcoming payment schedule + payment history.
3. Expand QBO sync to match the “money loop” entities you actually productize.

### Phase 4 — Operational depth (4–8 weeks)
1. Punch list internal workflow + reporting.
2. Inspection workflow (checklists/signoff/attachments/reminders).
3. Field speed improvements (photo flow, offline-tolerant patterns).

---

## Why Procore/Buildertrend Win (And What Matters Most)

They win because they make three things feel inevitable and automatic:
- **Artifacts** are attached to every process (documents/photos/approvals)
- **People** get pulled into action via notifications and logs
- **Money** is traceable from budget to payables/receivables with real variance visibility

Strata can win locally by achieving those outcomes with less overhead and a cleaner UX.

---

## Unique Advantages (If You Execute)

1. Modern UX and speed (a real differentiator vs legacy tools)
2. Strong portals story (client + sub) that can outperform incumbents for local builders
3. Local compliance automation wedge (Florida-specific) if it becomes a product workflow, not just a plan
4. Lower price point + simpler implementation, targeting builders who find Procore/BT too heavy

---

## Success Metrics (Early)

- Time from invoice sent → paid
- % of projects with draw schedule + invoices + recorded payments
- % of projects with budget + commitments + vendor bills connected
- Portal weekly active users (client and sub)
- Approval cycle time (COs/selections)
- RFI/submittal on-time closure rate

---

## Competitive Positioning (Draft)

**Target market:** small-to-medium builders/remodelers who want Procore/BT outcomes without Procore/BT complexity and cost.

**Positioning:** “Procore outcomes without Procore overhead.”

**Go-to-market:** start with a narrow workflow demo (portal + approvals + payments + docs + a simple financial story) and expand once trust is earned.

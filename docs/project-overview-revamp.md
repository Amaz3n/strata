# Project Overview Revamp Plan (LLM-Optimized)

Goal: Redesign `/projects/[id]` (currently `app/projects/[id]/page.tsx` + `app/projects/[id]/project-detail-client.tsx`) into a **single “project command center”** that:
- Summarizes the full app (planning, docs, comms, field, financials, closeout) without duplicating feature pages
- Answers “what needs attention?” and “what should I do next?” in under 30 seconds
- Remains fast, mobile-friendly, and maintainable (favor RSC and server-side aggregation; minimize `use client`)

This plan assumes **no single target persona** today, so the Overview must be broadly useful and optionally adaptive (by project stage + user role).

---

## 0) Repo Reality (Current State)

### 0.1 Current “overview” is already a dashboard
The current Overview is the base project route:
- Route: `app/projects/[id]/page.tsx` (server fetch) → `ProjectDetailClient` (client UI)
- UI: `app/projects/[id]/project-detail-client.tsx`

What it shows today (high level):
- Timeline health (elapsed vs schedule completion)
- Sales → Execution checklist (`ProjectPipelineChecklist`)
- Budget summary
- KPI grid (tasks/schedule/milestones/field activity)
- Recent activity feed
- “Coming Up” schedule items
- “Attention Required” schedule items (at-risk)

### 0.2 Project sub-pages exist and are project-scoped
Navigation is already project-scoped and grouped in the sidebar:
- Source: `components/layout/app-sidebar.tsx` (`buildProjectNavigation`)
- Sections: Planning (Schedule, Tasks), Documentation (Drawings, Files), Communication (Messages, RFIs, Submittals, Decisions), Field (Daily Logs, Punch), Closeout (Closeout, Warranty), Financials (Financials, Proposals, Change Orders)

### 0.3 Data currently loaded for overview is heavy
`app/projects/[id]/page.tsx` loads a lot in parallel:
- `getProjectStatsAction`, `getProjectTasksAction`, `getProjectScheduleAction`, `getProjectTeamAction`, `getProjectActivityAction`, `listPortalTokens`, vendors/companies, contract/draws/retainage/proposals, approved change orders total.

This is convenient, but it does not scale well as the overview expands (RFIs/submittals/warranty/closeout/messages).

---

## 1) Problem Statement

We want `/projects/[id]` to “encompass it all,” but without becoming:
- A slow page that loads full datasets for every module
- A duplicate of each feature page (schedule/tasks/financials/etc.)
- A hard-to-maintain mega-client component

The Overview should be an **index + triage + quick actions** layer:
- Surface **alerts** (overdue / blocked / pending approvals / aging items)
- Show **what’s next** (next 7 days, next draw, next milestone, next due submittal)
- Provide **one-click actions** (create, capture, share) and deep links into the correct page/tab/filter

---

## 2) Design Principles (Lock These In)

1) **Triage-first**
- Show “attention required” at the top (only what is actionable).

2) **Preview, then deep link**
- Overview shows *top N items* (3–7) per module.
- Every module preview has a “View all” link into the dedicated page.

3) **No duplication of full workflows**
- No full schedule editor, no full task board, no full financial charts on Overview.
- Only summaries + “create” entry points.

4) **Server aggregation by default**
- Add a single `getProjectOverviewAction(projectId)` that returns an aggregated DTO with counts + top items.
- Avoid loading full tasks/schedule arrays just to compute counts.

5) **Progressive disclosure**
- Collapsible sections, “show more,” and compact variants.

6) **Mobile-first**
- Single-column flow on mobile with sticky “Quick actions” and “Attention required.”

7) **Adaptive but not magical**
- If we adapt the layout, do it by explicit rules (project status/stage) and allow users to pin/reorder later.

---

## 3) Proposed Information Architecture (Layout)

### 3.1 Top-level structure (recommended)

**A) Project header (identity + actions)**
- Project name, status, address, dates, days remaining
- Primary actions (icons + labels):
  - Add task
  - Add schedule item / open schedule
  - Upload file
  - New daily log
  - Share portal link
  - Open financials

**B) Health strip (4 cards max, always clickable)**
- Schedule health (progress %, at-risk count) → `/schedule`
- Budget health (variance %, trend) → `/financials`
- Comms health (RFIs + Submittals pending/overdue) → `/rfis`, `/submittals`
- Field/Closeout health (punch open/overdue, warranty open) → `/punch`, `/warranty`

**C) Attention Required (priority queue)**
Ordered list combining:
- Overdue tasks
- At-risk/blocked schedule items
- RFIs due/overdue or awaiting decision
- Submittals due/overdue or pending review
- Punch items due/overdue (if due_date exists)
- Closeout missing items (only when project status is `completed` or within X days of end_date)

**D) Coming Up (next 7 days)**
Merged timeline list of:
- schedule items with start/end within 7 days
- tasks due within 7 days
- next draw due (if exists)
- upcoming milestones

**E) Financial snapshot (executive summary, not a dashboard)**
- Contract total (base + approved COs)
- Budget used % + variance
- Invoiced/paid (if available)
- Next draw (amount + due trigger/date)
- Retainage held/released (if available)
Deep link: `/financials` (and possibly to a specific tab)

**F) Recent activity + recent docs**
- Recent activity feed (existing)
- Recent uploads (files) (top 5) → `/files`
- Recent drawing updates (if available) (top 3) → `/drawings`

**G) Setup checklist (contextual)**
Existing `Sales → Execution` checklist:
- Shown expanded if setup < 100%
- Collapsed by default if setup complete (still accessible)

---

## 4) Section Specs (What Each Widget Shows)

For each widget below, keep to: **(1) what it tells you, (2) what you can do, (3) where it links.**

### 4.1 Attention Required (global queue)
- **Purpose**: One place to see anything overdue, blocked, or waiting.
- **Data**:
  - Tasks: status != done AND due_date < today
  - Schedule: status in (`at_risk`, `blocked`) OR end_date < today AND status not completed
  - RFIs: status in (`open`, `in_review`) AND due_date < today OR decision pending (if used)
  - Submittals: status in (`pending`, `submitted`, `in_review`, `revise_resubmit`) AND due_date < today
  - Punch: status != `closed` AND (due_date < today if present)
  - Warranty: status in (`open`, `in_progress`)
  - Closeout: items status != `complete` (only near closeout)
- **Interactions**:
  - Row click opens module page filtered to the item (initially just opens module page; later deep link with query)
  - Optional quick actions later: “Mark done”, “Assign”, “Set due date”

### 4.2 Comms summary (RFIs + Submittals)
Grounded in existing schemas:
- **RFIs** (`lib/validation/rfis.ts`): status ∈ `draft | open | in_review | answered | closed`, due_date, last_response_at, decision_status
- **Submittals** (`lib/validation/submittals.ts`): status includes `pending/submitted/in_review/approved/...`, due_date, last_item_submitted_at, decision_status

Widget output:
- “Open RFIs: X” + “Overdue: Y”
- “Pending Submittals: X” + “Overdue: Y”
- Top 3 “waiting” items (closest due date first)

Links:
- `/projects/[id]/rfis`
- `/projects/[id]/submittals`
- `/projects/[id]/messages` (optional: show last message timestamp per channel)

Note: internal “unread” is not currently modeled for portal messages. If we want unread, we’ll need a read state per user (future).

### 4.3 Field snapshot
- Daily logs: “Last log date”, “Missing today?” (if project is active and it’s a weekday) (future rule)
- Photos: count last 7 days (if photos table supports timestamps)
- Punch: open count, overdue count

Links:
- `/projects/[id]/daily-logs`
- `/projects/[id]/punch`

### 4.4 Closeout snapshot
Closeout exists and has a small default checklist:
- Statuses: `missing | in_progress | complete` (items) and package status auto-updates
- Show only when: project status is `completed` OR within a configured window of end_date

Links:
- `/projects/[id]/closeout`
- `/projects/[id]/warranty` (post-closeout servicing)

### 4.5 Financial snapshot
Do not rebuild the Financials page; just summarize.
- Source of truth is already consolidated under `/projects/[id]/financials` with `components/financials/*`.
- On overview: show 4–6 numbers and link out.

Links:
- `/projects/[id]/financials`
- `/projects/[id]/change-orders`
- `/projects/[id]/proposals`

---

## 5) Data Layer Plan (Fix at the Cause)

### 5.1 Introduce an aggregated Overview DTO
Create a new server action (and backing service) that returns exactly what the overview needs:

**New**
- `app/projects/[id]/overview/actions.ts` (or add to `app/projects/[id]/actions.ts` if preferred)
- `getProjectOverviewAction(projectId: string): ProjectOverviewDTO`

`ProjectOverviewDTO` should include:
- `project` header fields
- `health` counts:
  - tasks: open/overdue
  - schedule: progress %, at-risk count
  - rfis: open/overdue
  - submittals: pending/overdue
  - punch: open/overdue
  - warranty: open
  - closeout: missing/total (conditional)
  - financial: budget variance %, contract total, next draw
- `previews` (top N lists):
  - attentionRequired: unified list (typed union)
  - comingUp: unified list (typed union)
  - recentFiles (top 5)
  - recentActivity (top 10–20)

### 5.2 Query shape: counts + top items, not full arrays
Instead of fetching full tasks/schedule items and filtering in JS:
- Use Postgres filters + `limit`
- Use `select(..., { count: "exact", head: true })` for counts
- Prefer server-side sorting by due_date/end_date

### 5.3 Keep permissions + RLS consistent
All overview queries must:
- Be scoped by `org_id` + `project_id`
- Use `requireOrgContext()` (like existing `app/projects/[id]/actions.ts`)
- Avoid service-role reads unless absolutely necessary (follow existing patterns)

### 5.4 Events/audit are already implemented for many modules
We should keep overview “Recent Activity” driven by events:
- Source: `events` via `getProjectActivityAction(projectId)`
- Potential upgrade: standardize event payloads so the overview can deep-link reliably.

---

## 6) UI Architecture Plan (Reduce `use client`)

### 6.1 Break the mega client into a Server-first page
Target end state:
- `app/projects/[id]/page.tsx` becomes the orchestrator:
  - fetch `ProjectOverviewDTO`
  - render mostly server components
  - render small client components only for interactive actions/sheets

Suggested structure:
- `app/projects/[id]/overview/page.tsx` (optional alias) or keep at `page.tsx`
- `components/projects/overview/*`:
  - `project-overview-header.tsx` (mostly server)
  - `project-overview-actions.tsx` (client: opens sheets/modals)
  - `project-overview-health-strip.tsx` (server)
  - `project-overview-attention.tsx` (server)
  - `project-overview-coming-up.tsx` (server)
  - `project-overview-financial-snapshot.tsx` (server)
  - `project-overview-recent.tsx` (server)

### 6.2 Use existing sheets, don’t re-invent
Reuse existing patterns/components already in the overview:
- Share sheet (`AccessTokenGenerator`, `AccessTokenList`)
- Project settings sheet
- Setup wizard sheet
- Contract detail sheet

The overview should trigger these, not re-implement their internals.

---

## 7) Responsive Behavior

### 7.1 Mobile
- Single column order:
  1) Header + quick actions (sticky)
  2) Attention Required
  3) Coming Up
  4) Health strip
  5) Financial snapshot
  6) Recent activity + recent docs
  7) Setup checklist (collapsed if complete)

### 7.2 Desktop
- Two-column grid:
  - Left: Attention Required, Coming Up, Financial snapshot
  - Right: Health strip, Recent activity, Recent docs, Setup checklist

---

## 8) Rollout Plan (Phased, Safe)

### Phase 0 — Spec + Inventory ✅
- This doc

### Phase 1 — Data consolidation (fast + safe)
- Implement `getProjectOverviewAction()` returning counts + preview lists
- Keep existing UI but replace heavy `Promise.all([...])` fetches with a single DTO fetch
- Acceptance:
  - Overview renders with same content as today
  - Fewer queries and smaller payloads

### Phase 2 — UI refactor (decompose mega client)
- Split `ProjectDetailClient` overview into server-first components
- Keep the same look/sections initially
- Acceptance:
  - Minimal `use client` surface
  - No regressions in existing sheets/actions

### Phase 3 — Add cross-module “comms + closeout + warranty” summaries
- Add Comms card (RFIs/Submittals) and Closeout/Warranty cards to health strip
- Add those items into “Attention Required” queue
- Acceptance:
  - Overdue/pending comms visible without opening module pages

### Phase 4 — “Coming Up” becomes a unified next-7-days list
- Merge schedule + tasks + draws + key comms deadlines
- Acceptance:
  - Clear next actions for the week

### Phase 5 — Optional personalization (later)
- Allow pin/reorder/hide sections per user and/or org defaults
- Store as user preference (e.g., `user_settings.overview_layout_json`)

---

## 9) Acceptance Criteria (Definition of Done)

### 9.1 Experience
- Opening `/projects/[id]` answers:
  - **What’s on fire?** (Attention Required)
  - **What’s next?** (Coming Up)
  - **Are we on track?** (Health strip)
  - **Can I act immediately?** (Quick actions)

### 9.2 Performance
- The overview loads without fetching full lists from every module by default.
- Queries are limited and indexed on:
  - `(org_id, project_id, status, due_date)` where applicable

### 9.3 Maintainability
- Overview UI is composed of small components (no single 1500+ line client file).
- Server action/service returns a stable DTO for the UI.

### 9.4 Security
- All data access respects org/project scoping (RLS + `requireOrgContext()`).

---

## 10) Open Questions (Optional, but Useful)

1) Should the overview display **client-facing vs internal-facing** indicators separately (e.g., “pending client decision”)?
2) Should “Attention Required” include only **overdue**, or also **due soon** (next 48h)?
3) Do we want the overview to show “last client message” and “last sub message” timestamps (unread is not supported today)?





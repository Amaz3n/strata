# Navigation & Scopes Refactor — Gameplan

**Status:** Implemented in this workspace on 2026-07-04
**Scope:** Workspace (org-level) and project-level sidebar restructure, the desk/workbench scope rule, org-level "desk" pages, orphan-route cleanup, and nav mechanics fixes.
**Companion plan:** `docs/financials-trust-and-modes-refactor-gameplan.md`. Dependency: the project Financials Summary page (that plan, Phase 4.1) is the new Financials landing here — build it there first or land this plan with the landing pointed at the existing behavior behind a flag.

---

## Implementation progress — 2026-07-04

Completed:
- Added the scope doctrine to `CLAUDE.md`.
- Extracted shared project nav decisions into `components/layout/project-nav-items.ts`; desktop and mobile now use the same project item builder.
- Reworked workspace nav to Home, My Work, Projects, Pipeline, plus an Office group for Billing, Payables, Schedule, Directory.
- Reworked project nav to Overview / Plan / Build / Financials / Close, with Tasks and Time under Build, Summary as the Financials landing, Review renamed and badge-ready, and Trust Center removed from nav.
- Added segment-based project section matching and nested nav badges.
- Added server-side navigation badge counts for My Work, ready-to-bill, and project Review counts.
- Added `app/(app)/my-work/page.tsx`, `app/(app)/payables/page.tsx`, and expanded `app/(app)/billing/page.tsx` into an org Billing desk while retaining the WIP report.
- Added `lib/services/my-work.ts`, `lib/services/org-payables.ts`, `lib/services/org-billing-desk.ts`, and `lib/services/navigation-badges.ts`.
- Added `time.read` / `time.write` permission options and moved project time read/write gates to those permissions.
- Applied Supabase migration `20260704182750_navigation_scope_time_permissions` remotely and added its local migration file.
- Converted legacy/orphan surfaces: `/tasks` redirects to `/my-work`, `/change-orders` and `/payments` redirect to `/billing`, `/documents` and `/selections` redirect to `/projects`, and project Financials Trust Center redirects to Summary.
- Left dashboard/search/feature-linked org aggregate pages functioning with `desk-rule` comments: Drawings, RFIs, Submittals, Signatures, Estimates.

Validation:
- `./node_modules/.bin/eslint .` passed.
- `git diff --check` passed.
- `pnpm lint` was attempted, but pnpm aborted before running lint because it wanted to purge/reinstall `node_modules` without a TTY (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Direct ESLint was run to validate the same script target without triggering pnpm install behavior.
- Supabase advisors were checked after the migration; returned inherited warnings unrelated to this navigation permission migration.

Notes:
- The My Work "Assigned elsewhere" section is intentionally deferred per the v1 plan; no new assignee indexes were added.
- Existing linked org aggregate pages remain out of workspace nav by design.

---

## The scope rule (adopt as doctrine — add to CLAUDE.md)

Add this section to `CLAUDE.md` verbatim (trimmed as needed):

> **Scopes: workbenches, desks, and My Work.**
> - **Project pages are workbenches** — where actions/mutations happen. Every mutation has exactly ONE home, and it is project-scoped.
> - **Org pages are desks** — read-mostly aggregations answering a ROLE's cross-project question ("what's ready to bill everywhere?"). Desks rank/aggregate and deep-link into project workbenches. A desk may expose one-click completions of safe actions ONLY by calling the same server action the workbench uses.
> - **A feature earns an org desk only if a person's JOB is that feature across all projects** (controller → billing, bookkeeper → payables, ops → schedule). Never build an org view for symmetry.
> - **"My Work" is the personal scope**: things waiting on ME across projects (approvals, tasks). It absorbs the demand for org-wide tasks/RFIs/etc. pages.

This rule is the deliverable that stops the recurring scope debates.

---

## Current state (verified)

`components/layout/app-sidebar.tsx`:
- **Workspace mode** (`buildWorkspaceGroups`, ~159–213): Home, Projects, Pipeline (badge), Directory, [Platform, Issues].
- **Project mode** (`buildProjectGroups`, ~245–311): Overview / Plan (Documents, Drawings, Bids, Signatures) / Build (Schedule, Daily Logs, Punch, RFIs, Submittals, Decisions) / Financials (Inbox, Budget, Receivables, Payables, Time, Expenses, Change Orders, Reports) / Close (Closeout, Warranty).
- Financials landing is mode-dependent (`getFinancialLandingUrl`, ~215): fixed_price → receivables, else inbox.
- Section detection (`getProjectSection`, ~105) uses `pathname.includes(...)` substring matching.

Problems found:
1. ~15 real org-level routes exist under `app/(app)/` (schedule, invoices, drawings, rfis, documents, tasks, payments, change-orders, closeout, warranty, selections, decisions, signatures, submittals, estimates, proposals) but are absent from workspace nav — orphaned, built ad hoc.
2. Project routes exist with no nav item: `/projects/[id]/tasks` (section detection even matches it), `/projects/[id]/work`, `/projects/[id]/financials/trust-center` (desktop-unreachable; mobile bottom nav DOES link it — `components/layout/mobile-bottom-nav.tsx:143`).
3. Mode-dependent landing makes the same sidebar click go to different pages on different projects.
4. Substring section matching is fragile (`includes("/time")` matches any future route containing it).
5. Loose permission gates: Time requires `invoice.read`; the Inbox item requires any of six broad permissions.

---

## Phase 1 — Workspace (org) sidebar

Target structure in `buildWorkspaceGroups`:

```
(no label)
  Home                    /                     unchanged
  My Work      [badge]    /my-work              NEW (Phase 3)
  Projects                /projects             unchanged
  Pipeline     [badge]    /pipeline             unchanged
"Office" group label
  Billing      [badge]    /billing              NEW desk (Phase 4); until built, point at /invoices
  Payables                /payables             existing org payables workspace — promote into nav
  Schedule                /schedule             existing org schedule page — promote into nav
  Directory               /directory            unchanged
"Platform" (existing conditional group, unchanged)
```

Implementation notes:
- `SidebarNavGroup` already supports `label` — render Office as a labeled group.
- Badges: `pipelineBadgeCount` pattern already exists; add `myWorkBadgeCount` and `readyToBillBadgeCount` props threaded the same way (computed server-side in the layout that renders `AppSidebar`; keep the queries cheap — counts only, single RPC or indexed count queries).
- Permissions: Billing `requiredAny: ["invoice.read"]`, Payables `["bill.read", "payment.read"]`, Schedule `["schedule.read"]`, My Work `["org.member"]`.

### 1.1 Orphan org-route cleanup
For each org route NOT in the target nav — `drawings, documents, rfis, submittals, decisions, signatures, selections, closeout, warranty, tasks, payments, change-orders, estimates, proposals` (verify each before acting):
- If it's a thin page duplicating a project feature and has no inbound links (grep for `href` usages): replace the page with a redirect to `/projects` (or the most sensible parent) and note it in the PR for later deletion. Do not delete data/services — pages only.
- If it IS linked from Home/dashboard or command bar (check `components/dashboard`, search/command components): keep the route functioning but do not add to nav; leave a code comment `// desk-rule: reachable via dashboard only, not nav`.
- `payments` and `change-orders` at org level: fold their content into the Billing desk (Phase 4) rather than keeping separate top-level pages; leave redirects.
- Do this as its own PR with an explicit list in the description — it's the easiest change to partially revert if a customer complains.

---

## Phase 2 — Project sidebar

Target structure in `buildProjectGroups` / `buildFinancialSubs`:

```
Overview
Plan:        Documents, Drawings, Bids, Signatures            (unchanged)
Build:       Schedule, Daily Logs, Tasks*, Time*, Punch, RFIs, Submittals, Decisions
Financials:  Summary*, Review* [badge], Budget, Receivables, Payables,
             Expenses, Change Orders, Reports
Close:       Closeout, Warranty                               (unchanged)
```

Changes:
1. **Move Time from Financials → Build** (capture surface for field staff; its financial consequence flows to Review automatically). Route stays `/projects/[id]/time`.
2. **Add Tasks to Build** (route exists; currently unreachable). If the tasks page is not production-quality, gate the nav item behind a feature flag instead of leaving it orphaned. Decide `/projects/[id]/work`: nav it, or delete the route — no orphans.
3. **Financials → Summary** as the group landing for ALL modes: `getFinancialLandingUrl` returns `${base}/financials/summary` unconditionally (delete the mode branching). The Summary page comes from the financials plan Phase 4.1. `/projects/[id]/financials` (the inbox route) moves to `/projects/[id]/financials/review` with a redirect from the old path; keep the `?tab=` legacy redirects working.
4. **Rename "Inbox" → "Review"** in the nav item and page chrome; add pending-count badge (`SidebarNavSubItem` needs an optional `badge` field — currently only top-level items support it; extend the type + `NavMain` rendering).
5. **Hide Review entirely for fixed_price** (already conditional via `config.showInbox`) and hide Time for non-cost-driven (already `config.showTime`) — keep, but re-express against the new positions.
6. **Trust Center:** remove the route (`app/(app)/projects/[id]/financials/trust-center/`) from mobile nav (`mobile-bottom-nav.tsx:143`) and fold `TrustCenterTab` content into the Summary page or Receivables. If keeping it standalone short-term, add it to BOTH desktop and mobile nav — no scope where one platform can reach a page the other can't.
7. **Mobile bottom nav** (`components/layout/mobile-bottom-nav.tsx`): mirror every project-nav decision above (Time under Build grouping, Review rename, Summary landing). Audit desktop-vs-mobile item parity and reconcile; they drifted once (Trust Center) and nothing prevents it — add a shared items-builder module both import (`components/layout/project-nav-items.ts`) so drift becomes impossible.

### 2.1 Nav mechanics fixes
- **Section matching:** rewrite `getProjectSection` to parse the path segment after the project id (`/projects/:id/<segment>/...` → switch on `<segment>`, with `financials` sub-segment handling) instead of `pathname.includes`. Preserve current active-state pairings (e.g., budget highlights for commitments).
- **Permissions:** Time item → introduce `time.read`/`time.write` (or reuse an existing field permission if RBAC already defines one — check `lib/services/permissions.ts` and the RBAC docs) instead of `invoice.read`. Review item → narrow to `["invoice.write", "bill.approve"]` (the people who act in it). Verify each changed gate against the RBAC matrix (`docs/rbac-plan.md`).

---

## Phase 3 — My Work page (new)

Route: `app/(app)/my-work/page.tsx`. Personal cross-project queue; read-mostly desk.

Sections (each row deep-links to the project workbench):
1. **Approvals waiting on me** — time entries/expenses/vendor bills in reviewable states on projects where I hold the approving permission (reuse `financials-review-queue` eligibility; query across projects, cap per project, show counts).
2. **My tasks** — tasks assigned to me across projects (service exists: `lib/services/tasks.ts`).
3. **Assigned to me elsewhere** — RFIs/submittals/decisions where I'm the assignee/ball-in-court, if those services expose assignee queries; otherwise defer this section (do not build new indexes for v1).
Badge count for the sidebar = approvals + tasks due within 7 days. Empty state explains the page ("Things across all projects that are waiting on you").
Server component; one aggregate loader; every query org_id-scoped and permission-checked per section (degrade sections the user can't read, matching `filterGroups` behavior).

---

## Phase 4 — Org Billing desk (new)

Route: `app/(app)/billing/page.tsx` (nav "Billing"). The controller's Monday-morning screen. Read-mostly; every row deep-links.

Content:
1. **Header stats:** ready to bill (org total), unbilled cost aging (0–30/31–60/61+), outstanding AR, retainage held.
2. **Ready to bill by project:** project, billing model badge, ready $ (open billable costs for cost-driven; due/pending draws for fixed price; earned-unbilled fee for fixed-fee), oldest unbilled age, blocked count with top reason → links to that project's Review (or Draws).
3. **Outstanding invoices:** reuse `InvoicesClient` with `projectScoped=false` (pattern already exists at `app/(app)/invoices/`) or embed a compact list linking to it.
4. **WIP summary** once the financials plan Phase 6.2 report exists — until then omit; leave a `TODO` anchor.
Safe one-click actions allowed: "send saved invoice", "mark paid" — MUST call the same server actions the workbench uses (`app/(app)/invoices/actions.ts`). No invoice creation/editing here.
Permissions: `invoice.read` to view; action buttons additionally gated by their own permissions.
The existing `/invoices` org page remains as the full invoice list; Billing links to it. `/payments` org content folds in here or stays linked — decide during build, but it leaves top-level nav either way.

---

## Sequencing & PR breakdown

| Order | Work | Size | Notes |
|---|---|---|---|
| 1 | CLAUDE.md scope rule + shared `project-nav-items.ts` extraction | S | Zero behavior change |
| 2 | Phase 2.1 mechanics (section parsing, permission gates) | S | Behavior-preserving except gates |
| 3 | Phase 2 project sidebar moves (Time→Build, Tasks, Review rename, redirects) | M | Landing repoint waits for Summary page |
| 4 | Phase 1 workspace sidebar (+ Office group, promote Payables/Schedule) | S | Billing points at `/invoices` until Phase 4 |
| 5 | Phase 1.1 orphan cleanup | M | Own PR, explicit route list |
| 6 | Phase 3 My Work | M | New page |
| 7 | Phase 4 Billing desk | M–L | After financials plan Phase 0 (trust) ideally |
| 8 | Financials Summary landing repoint | S | After financials plan Phase 4.1 |

**Acceptance criteria (global):**
- No route reachable on one platform (desktop/mobile) but not the other; no route with a page but no inbound nav/dashboard link (grep-verified) unless explicitly redirected.
- Every nav item permission-gated; `filterGroups` still drops empty groups.
- All legacy URLs redirect (old `/financials` inbox path, `?tab=` params, removed org routes) — no 404s from bookmarks.
- `pnpm lint` clean. No `pnpm dev`/`pnpm build`.
- Desk pages contain no mutation forms; any action button calls an existing project-scoped server action.

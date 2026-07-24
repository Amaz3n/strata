# Workstream 10 — Production Experience Refinement

> **Audience:** an LLM executing agent. Read `00-MASTER-production-expansion.md` FIRST —
> its rules (posture choke points, desk/workbench doctrine, design language, scale design
> case, leave-no-trash) bind here verbatim. This workstream is the IA/experience pass
> that follows the functional workstreams 01–09: it makes Arc *feel* designed for a
> production builder instead of a custom-builder app wearing production features.
> It is presentation + navigation + scoping work. **Zero new business capabilities,
> at most two small migrations (division context preference; none other expected).**

## STATUS — IMPLEMENTED (2026-07-23)

Phases A–H are implemented in the application:

- production project navigation subtracts custom-builder-only work, with
  `module_overrides` still taking precedence;
- production leads now live in Sales and `/pipeline` redirects, while mixed orgs keep
  the residential Pipeline escape hatch;
- production Home, the house traveler, community P&L, Plans & Pricing, executive
  reports, and the cross-community Land view are tier-specific server forks;
- the sidebar division lens is a validated secure cookie, composes with community
  scope, and defaults every production desk without introducing a third navigation
  level;
- Reports is in Office for every tier, production terminology is centralized, and
  production Inspections is visible;
- the obsolete production Pipeline files and the unmounted legacy project-detail /
  pipeline-checklist tree were removed.

**WS04–07 division enforcement audit and fixes.** The audit found that several
service-role reads checked a permission but did not intersect their result with
`membership_division_scope`. The following were corrected:

- WS04: price agreements and history, price-book health/readiness, PO exceptions,
  VPO/variance queues, PO completions, bid packages, and variance reporting;
- WS05: start packages/candidates/attention counts, release board, cycle/even-flow
  reporting, WIP counts, released markers, and late-task heatmaps;
- WS06: spec inventory, reservations, community sales/price sheets/incentives,
  closings, and backlog rollups;
- WS07: warranty request/dispatch/backcharge queues, direct project reads,
  technician visits, defect/cost analytics, originating commitments, and company
  warranty signals.

Explicit division filters now intersect assigned membership scope; they never widen
it. Direct record reads return not-found/empty outside the permitted division. The
new `warranty_defect_analysis_scoped` RPC receives only the server-resolved project
intersection. The production Home stat band now uses
`production_home_stat_rollup`, so direct cost/VPO/cycle/closing/start totals remain
aggregate at the 200-active-home design case.

**Verification completed:** `pnpm lint`, the 99-test financial suite, the 4-test
starts suite, the 19-test authorization suite, the 7-test posture/land suite,
`tsc --noEmit` with an 8 GB heap, the schema guard, and leave-no-trash greps. Runtime
light/dark visual QA against Cypress Landing still needs a non-production preview
environment; this repository's operator instructions prohibit starting or building
the app because its local environment points at production.

**Production capability gaps discovered (outside this workstream's zero-new-
capability boundary):**

1. Purchase orders/commitments have no trade acknowledgement or delivery-confirmation
   fact. Home therefore cannot truthfully show “trades unconfirmed next 2 weeks”
   without a WS04 data/workflow addition.
2. Arc has project-budget and mobile VPO capture, but no context-aware global web
   “New VPO” flow in Purchasing. Production Expenses now deep-link to the VPO desk;
   a true one-click office capture flow remains a separate capability.
3. The foundation schema has lot lifecycle status but no land-entitlement status,
   despite the master plan describing it. The Land view includes 90-day takedowns,
   deposits at risk, finished-lot/start-plan coverage, and months of supply, but an
   entitlement summary requires that missing WS01 fact.

## Mission

Workstreams 01–09 shipped the production capability set. What remains is the experience
gap, diagnosed 2026-07-23:

1. **Center of gravity.** For a custom builder the project is the home; for a production
   builder the project is a record you drill into. Production staff are role-specialized
   (purchasing manager, starts coordinator, superintendent, sales agent, service manager,
   controller) — their day starts in a desk, not a project. Today the highest-traffic
   surfaces (org Home, project overview) and several nav defaults still center the
   custom-builder mental model.
2. **Additive clutter.** Production nav was added *beside* residential surfaces instead
   of *replacing* them where they conflict (Pipeline vs Sales; per-house Bids/RFIs/
   Submittals/Decisions tabs that contradict the auto-PO / cutoff-enforcement doctrine).
3. **Divisions are a data attribute, not an experience.** The model is right
   (`divisions`, `membership_division_scope`, WS08 entity mapping) but half the
   production desks ignore division scope and there is no ambient division context.
4. **The money-watcher personas have no seat.** Community P&L, margin by plan, VPO
   trend, cycle time, and backlog are scattered across desks; the owner/controller —
   the buyer of Arc — has no consolidated view.

## Phase index and dependency order

| Phase | Contents | Depends on |
|---|---|---|
| A | Subtraction: posture-gate irrelevant project tabs; production org-nav cleanup | — |
| B | Pipeline → Sales consolidation (Leads tab, redirect, mixed-org escape hatch) | A |
| C | Production Home (replaces control tower at production tier) | — |
| D | Production house overview (the "traveler") | — |
| E | Community workbench enrichment (P&L tab, Plans & Pricing tab, traversal spine) | — |
| F | Divisions end-to-end (ambient switcher, desk sweep, enforcement audit, rollups) | — |
| G | Executive Reports desk + cross-community Land view | C, E, F |
| H | Adoption polish (terminology, inspections posture, icon dedupe, verification) | A–G |

A, C, D, E, F are independent and may run in parallel. B follows A (same files).
G consumes F's division lens and E's community P&L primitives. H is the closing sweep.

## Read these files first

- `components/layout/app-sidebar.tsx` — org sidebar; `buildWorkspaceGroups()` holds the
  tier forks (`showProductionNavigation`, `productTier === "commercial"` precedent).
- `components/layout/project-nav-items.ts` — project nav; `postures:` field is the
  gating mechanism; `module_overrides` is the per-project escape hatch (keep it working).
- `lib/product-tier.ts` — `getProjectPosture()`, `getOrgProductTier()`, posture helpers.
- `lib/financials/billing-model.ts` — `getProjectFinancialFeatureConfig()`; note the
  fixed-price branch already sets `showDraws/showTime/showExpenses` off for
  purchase-agreement and production-without-contract projects.
- `lib/terminology.ts` — the single noun choke point.
- `app/(app)/page.tsx` + `components/control-tower/*` — org Home.
- `app/(app)/projects/[id]/page.tsx` (+ `project-detail-client.tsx`,
  `project-pipeline-checklist.tsx`) — project overview.
- `app/(app)/pipeline/page.tsx` + `components/pipeline/*` — note `PipelineMode`,
  `PRODUCTION_NURTURE`, community filter, reservation info: the production fork that
  Phase B relocates into Sales.
- `app/(app)/sales/page.tsx` + `components/sales/*` — Sales desk (backlog, spec
  inventory, closings).
- `app/(app)/communities/[id]/layout.tsx` + `components/communities/community-tabs.tsx`
  — community workbench (tabs: Lots, Land, Starts, Sales, Settings).
- `lib/services/divisions.ts`, `lib/services/authorization.ts`
  (`membership_division_scope`), `supabase/migrations/20260718161419_membership_division_scope.sql`.
- `app/(app)/reports/page.tsx` — current org reports (WIP over/under + 1099 only; not
  in sidebar).
- `lib/services/reporting-scope.ts` — rollups stay parameterizable by explicit
  project-id sets; division/community rollups are scoped desk queries.

## Binding decisions (resolve all disagreements in favor of this section)

1. **No third sidebar scope.** The org/project two-level system holds. The community
   stays a horizontally-tabbed workbench; divisions become ambient *context*, not a
   nav mode. Do not build a community sidebar.
2. **One sales noun per tier.** Residential/commercial: Pipeline. Production: Sales
   (with the lead funnel as a tab inside it). Never both, except the mixed-org rule in
   Phase B.
3. **Home and Reports answer different questions.** Home = "is the factory on tempo
   this week, what's jamming the line" (flow + exceptions, zero P&L). Reports = "how
   are we performing" (P&L, margins, trends). Do not let them converge.
4. **Fork pages, don't morph components.** Tier/posture forks happen at the page/server
   component level (`getOrgProductTier()` / `getProjectPosture()` → render distinct
   components). No component trees full of tier conditionals.
5. **Subtraction defaults, per-project escape hatch.** Posture gating hides by default;
   `module_overrides` re-enables per project. Never delete residential/commercial
   surfaces — gate them.
6. **Divisions filter, never isolate** (master doc decision #2). The switcher is a lens
   with "All divisions" one click away; RLS stays org-based.
7. **Home/desks at 200-active-project scale ride aggregate RPCs** — no row enumeration
   in stat bands (existing >1000-row aggregate-RPC pattern).
8. **Desks never mutate across the doctrine line.** New surfaces (Home exceptions,
   Reports, Land view) deep-link into the owning desk/workbench; one-click-complete only
   by calling the owning server action.

---

## Phase A — Subtraction

### A1. Project workbench tabs (edit `components/layout/project-nav-items.ts`)

Add posture gates so these do NOT render for `posture === "production"`:

| Tab | Gate to | Rationale (encode in commit message, not code comments) |
|---|---|---|
| Plan → Bids | `["residential", "commercial"]` | Production buyout is auto-PO from the price book; a per-house bid tab invites ad-hoc procurement. |
| Build → RFIs | `["residential", "commercial"]` | RFIs clarify unique design intent; production builds from a released immutable plan version. |
| Build → Submittals | `["residential", "commercial"]` | Spec-compliance review is a commercial workflow; product data is settled at plan/price-book level. |
| Build → Decisions | `["residential", "commercial"]` | Every production buyer decision is a Selection with a schedule-derived cutoff; Decisions is a bypass around cutoff enforcement. |
| Build → Time | `["residential", "commercial"]` | Pay-on-PO, no T&M. `showTime:false` already covers contracted houses; the posture gate covers spec houses without a contract. |

Financials → Expenses for production posture: keep the tab but confirm
`getProjectFinancialFeatureConfig` hides expense *capture* for production
(purchase-agreement and no-contract branches). If any production entry point still
offers free-form expense creation, route it to VPO creation instead (deep-link to the
VPO flow with context). Do not build new UI — reuse the WS04 VPO capture.

Verify `module_overrides` still re-enables each gated tab on a single project.

### A2. Org sidebar for production tier (edit `components/layout/app-sidebar.tsx`)

When `productTier === "production"`:

- **Hide Pipeline** (Phase B provides the redirect + mixed-org rule).
- **Hide the standalone Bids item**; the Bids desk's production-relevant content
  (plan/community bid packages → rebid → price agreements) is a purchasing-manager
  activity — surface it as a tab or prominent link inside the Purchasing desk. Do not
  duplicate the bids UI; link to `/bids` scoped views from Purchasing.
- **Hide the org Schedule (portfolio Gantt) item.** Production time views are the
  Starts release board, cycle-time reports, and My Houses. (Lowest-conviction cut: if
  a per-community Gantt is later requested, it goes in the community workbench, not
  back in the org nav.)
- Ensure hidden routes still function if visited directly (deep links, search results)
  — gating is nav-level, not route-level, except the Phase B pipeline redirect.

### A3. Entry-point sweep

Grep for entry points that offer estimates/proposals on production-posture projects
(command bar actions, project creation flow, empty states, overview CTAs) and gate
them. Estimating happens once per plan; a per-house estimate is an anti-feature.

**Acceptance A:** A production-posture project shows Plan {Documents, Drawings,
Signatures}, Build {Schedule, Daily Logs, Photos, Punch, Selections}, Financials
{Review*, Budget, Receivables, Payables, Lien Waivers, Expenses†, Change Orders,
Reports}, Close {Closing, Closeout, Warranty}. A residential and a commercial project
render exactly as before (visual regression both modes, light+dark). `module_overrides`
re-enables any gated tab. (†per A1 disposition; *per existing config.)

---

## Phase B — Pipeline → Sales consolidation

1. **Add a `Leads` tab to the Sales desk** (`app/(app)/sales/`): relocate the
   production mode of the pipeline workspace (`PRODUCTION_NURTURE` stages, community
   filter, reservation handoff) into it. Tab order: Leads | Inventory | Backlog |
   Closings (match existing Sales desk structure; adjust to what's actually there —
   do not invent tabs).
2. **Redirect:** for production-tier orgs, `/pipeline` → `/sales?tab=leads`
   (preserve query params where meaningful).
3. **Leave no trash:** delete the production fork from `app/(app)/pipeline/page.tsx`
   and `components/pipeline/*` (`PipelineMode` production branches,
   `PRODUCTION_NURTURE`, production-only props) once relocated. Pipeline returns to a
   single-audience residential/commercial desk.
4. **Mixed-org escape hatch:** if a production-tier org has ≥1 non-production-posture
   active project, ALSO show Pipeline in the sidebar (custom prospects don't fit
   community sales). Compute server-side where sidebar props are assembled; do not
   query from the client.

**Acceptance B:** Production org: one sales noun in nav; leads nurture → reservation →
backlog flows entirely inside Sales; `/pipeline` redirects. Residential org: Pipeline
unchanged. Mixed org: both visible, no duplicated prospect surfaces. No dead
production code remains under `components/pipeline/`.

---

## Phase C — Production Home

Fork `app/(app)/page.tsx` on `getOrgProductTier()`: production renders new
`components/home/production-home*` server components; other tiers keep the control
tower untouched.

Layout mirrors the control tower's proven anatomy (stat band → two-pane), new content:

- **Stat band** (each stat deep-links to its owning desk): starts this week vs
  even-flow slot target · closings this month (scheduled/cleared, $) · homes under
  construction + avg cycle time vs target · VPO $ this week + running % of direct
  cost · backlog (sold-not-started) + spec count. All via aggregate RPCs (rule 7).
- **Exceptions queue** (replaces watchlist; rows deep-link, never mutate): start
  packages blocked on gates · homes approaching/past selection cutoff with unlocked
  selections · trades unconfirmed next 2 weeks · VPOs pending approval over
  threshold · closings this week with open checklist items · stalled houses (no
  schedule progress in N days; N configurable constant, default 7). Reuse WS04/05/06
  service queries; add narrow list functions only where none exist. Cap each list
  (rule: unbounded lists get caps day one) with "view all in <desk>" links.
- **Lookahead:** one merged week calendar — releases scheduled, closings scheduled,
  selection cutoffs due, lot takedowns due.
- **Mixed-org strip:** if the org has active non-production projects, a compact
  "Custom projects" strip linking to the control-tower views — do not render the full
  control tower.
- Honors the Phase F division lens.

**Acceptance C:** Production org Home shows zero custom-builder widgets; every number
verifiable against its owning desk; empty state (new org, no communities) renders the
onboarding checklist path, not a wall of zeros; loading + error + dark mode; p95 render
budget respected at the 200-active-project design case (aggregate RPCs, no N+1).

---

## Phase D — Production house overview ("the traveler")

Fork inside `app/(app)/projects/[id]/page.tsx` `ProjectData` on
`getProjectPosture()`: production renders `ProductionHouseOverview`; other postures
untouched. Sections, in order:

1. **Identity header:** Community / Phase / Lot (each a link up the spine — Phase E),
   address, plan + elevation + swing, pinned plan version, superintendent, buyer (or
   `SPEC` badge), start-released date, projected closing.
2. **Stage & schedule:** current stage vs template, % through cycle, days elapsed vs
   community average cycle time, next ~5 tasks/inspections.
3. **Money as variance:** price build-up (base + lot premium + structural options +
   selections + COs) · generated budget total · **VPOs to date ($, count, top reason
   code)** · margin vs plan target. No "budget health" framing — the budget is a
   derived artifact; variance is the story.
4. **Gates:** start package state, selection cutoff status (next cutoff date,
   locked/unlocked), closing checklist state.
5. Quiet strips: punch count, latest photos/daily log, warranty (post-close).

Remove for production posture: `project-pipeline-checklist.tsx` mount, estimate/
proposal links, draw status, decisions widgets. Joins (lot/community/plan version)
exist from WS01/02 — this is presentation work; add no new tables.

**Acceptance D:** A production house overview answers "which unit, what stage, what
variance, what's blocking" in one screen without scrolling on desktop; residential and
commercial overviews byte-identical to before; empty/loading/error + dark mode.

---

## Phase E — Community workbench enrichment

Edit `components/communities/community-tabs.tsx` + `app/(app)/communities/[id]/`:

1. **New `P&L` tab** — community P&L: revenue (closings + backlog at price), direct
   cost (budgets/actuals/VPO), margin actual vs plan target, per-lot detail table.
   Build on `reporting-scope.ts` explicit project-id sets (the community's lots'
   projects). This tab's primitives are reused by Phase G — build the service
   functions in `lib/services/` (e.g. extend the closings/backlog services or a
   neutral `community-pnl.ts`), not inline in the page.
2. **New `Plans & Pricing` tab** — community plan availability, base prices, lot
   premiums summary, active incentives. If these currently live under community
   Settings, MOVE them (leave-no-trash), leaving Settings for identity/phases/config.
3. **Traversal spine:** community layout already breadcrumbs down; ensure lot → house
   and house → community links exist both ways (house header links from Phase D; lot
   grid rows link to house workbench where a project exists).
4. **Sticky scope:** persist last-selected community/division per user across desk
   visits (cookie or membership preference — pick the lighter; if a migration is
   needed for a preference column, keep it additive). Desks with a community filter
   default to the sticky value; explicit "All" clears it.

Tab set after this phase: Lots · Land · Starts · Sales · Plans & Pricing · P&L ·
Settings. Still horizontal; do NOT convert to a sidebar (binding decision 1).

**Acceptance E:** Community P&L numbers tie to project financials for a seeded
community; Plans & Pricing shows the same data previously reachable via Settings with
the old location removed; a sales agent's community filter follows them from Sales to
Communities to Starts.

---

## Phase F — Divisions end-to-end

The model is right; make it an experience:

1. **Ambient division switcher** in the sidebar header (near org identity), rendered
   only when `orgHasDivisions()`. Sets a session-level division context (cookie +
   server read in layout); default "All divisions". Members whose
   `membership_division_scope` limits them to one division get it preselected and see
   only their divisions in the switcher (filter, never isolate — rule 6: this is UX
   preselection; authorization still enforces).
2. **Desk sweep:** make Starts, Purchasing, Warranty, My Houses, and Design Studio
   honor the division context (Communities, Plans, Sales, Team already filter — align
   them to read the ambient context as their default). Division predicate composes on
   top of `org_id` scoping, never replaces it (master rule 3).
3. **Enforcement audit:** verify WS04–07 service read paths respect
   `membership_division_scope` for scoped members (not just nav filtering). Write the
   findings into this doc's STATUS section; fix gaps in the same phase.
4. **Rollups:** production Home (C), community desk, and Reports (G) group/filter by
   division when divisions exist; orgs without divisions see zero division UI
   anywhere (master decision 2).

**Acceptance F:** A division-scoped purchasing manager sees only their division's POs/
agreements/queues across every desk without touching a filter; an org-wide user flips
divisions from the sidebar and every desk follows; a no-divisions org renders no
division UI; RLS/authorization tests prove scoped members can't read other divisions'
rows through the swept services.

---

## Phase G — Executive Reports desk + Land view

1. **Reports desk** (`app/(app)/reports/`, added to the Office sidebar group for all
   tiers): consolidate — community P&L rollup (from E's services) · margin by plan
   (crosses communities; no other home) · VPO % of direct cost trended by reason code
   and trade (WS04 variance RPC) · cycle time + even-flow adherence (WS05 reporting) ·
   closings backlog by horizon (WS06 backlog RPC) · existing WIP over/under + 1099
   (keep; they serve all tiers). Production-tier content leads; residential/commercial
   orgs see the existing reports plus whatever applies. Division is the first grouping
   dimension when present. CSV export per report (existing pattern).
2. **Cross-community Land view:** a `Land` tab on the Communities DESK (`/communities`,
   not the workbench): upcoming takedowns due (next 90 days, cash obligation),
   option deposits at risk, entitlement status summary, finished-lot delivery vs
   starts calendar, months-of-lot-supply per community (lots available ÷ trailing
   start rate). Aggregates what per-community land tabs already know — desk-level
   read-only, deep-links into each community's Land tab.

**Acceptance G:** The owner answers "which community makes money, which plan makes
money, where is variance leaking, do we have lot supply" from one desk; every figure
ties to its source surface; 400-lot / 200-project scale verified via aggregate
queries; Reports appears in the sidebar for all tiers.

---

## Phase H — Adoption polish + closing sweep

1. **Terminology:** route the org Projects desk title + project nouns through
   `terminology()` for production ("Homes"; confirm exact noun against
   `lib/terminology.ts` conventions). Sidebar item, page titles, empty states.
2. **Inspections posture:** WS05 instantiates per-house checklists and municipal
   inspections gate every schedule. Verify where those render for a production house;
   if the Inspections tab is their surface, add `"production"` to its postures.
   Decide from what WS05 actually built — do not duplicate a surface.
3. **Icon dedupe:** Sales and Pipeline share `Contact`; Communities duplicates
   Directory's `Building2`; Plans uses `Home`. Give production items distinct icons
   from the existing icon set.
4. **Verification sweep:** `pnpm lint` · `pnpm test:financials` · the starts suite ·
   visual pass (light+dark, empty/loading/error) over every touched surface in a
   residential org, a commercial org, and the Cypress Landing production sample org ·
   confirm no orphaned exports/components from B's deletion and E's settings move.

## Non-goals

- No new business capabilities: no rebates, no land development job costing, no BTR,
  no trade network (master §10 deferrals stand).
- No community sidebar scope, no third nav mode (binding decision 1).
- No changes to RLS architecture — divisions remain filters over org-scoped RLS.
- No WS08 gate work (soak/cutover tracked in 08); no WS01–09 QA acceptance items
  (tracked in 00-MASTER) — though the Cypress Landing sample org from WS09 is the
  natural QA vehicle for every phase here.
- No mobile changes except where My Houses already exists; mobile parity for Home/
  Reports is future work.

## Definition of done

- All phase acceptance criteria pass; residential and commercial experiences are
  pixel-unchanged except deliberate shared wins (Reports desk, icon dedupe).
- A production-tier walkthrough — sign in as owner, controller, purchasing manager,
  starts coordinator, sales agent, superintendent (division-scoped) — reaches every
  daily surface in ≤2 clicks from Home, and no surface shown is irrelevant to the
  persona's tier.
- `pnpm lint` clean; financial + starts suites pass; leave-no-trash grep confirms
  deleted forks/moved settings have no survivors.

# Takeoff — Master Gameplan

> **Status: ARCHIVED — executed or superseded.**
> This is a record of past intent. It very likely contradicts the current code.
> Never infer app behavior from it and never use it as an implementation guide.
> Source of truth is the code, `CLAUDE.md`, and the reference docs at the
> `docs/` top level.

> **Audience:** an LLM executing agent. Read this file FULLY before opening any code.
> It assumes you have internalized `/CLAUDE.md` (posture doctrine, design rules,
> registration checklist, verification commands). Everything here was verified against
> the live codebase on 2026-07-28; re-verify a fact before building on it if the file
> has since changed. Phases are ordered by dependency — do not start a phase before its
> prerequisites ship.

## 1. Mission

Build a drawing-based quantity takeoff system that beats Procore, Houzz Pro, Bluebeam,
and STACK — not by cloning them, but by exploiting three advantages only Arc has:

1. **We hold the vector PDF** and already run MuPDF WASM on every sheet
   (`lib/services/drawings-pipeline.ts`). Competitors measure raster images.
2. **We own both ends of the number.** A measured quantity lands in `estimate_items`
   (already qty × unit × unit_cost_cents), `bid_scope_items` (already has
   `unit_price` lines), `house_plan_takeoff_lines`, and eventually actuals.
   Point tools have nowhere to send the number.
3. **We hold the builder's own cost history** (commitments, bills, invoices,
   `arc_bid_benchmark_facts`) — takeoffs price from *this builder's jobs*, not a
   national cost book.

**The five headline capabilities** (each maps to a phase below):

| # | Capability | Phase |
|---|---|---|
| C1 | Zero-click scale: sheet calibrates itself from title block + printed dimensions | 3 |
| C2 | AI-assisted measurement: click-to-trace rooms/walls, count-by-symbol, command-bar takeoff — always draft → human approve | 6 |
| C3 | Living takeoff: revision-aware quantities ("Rev 3 grew the lanai 240 SF — your estimate is stale by $8,400") | 8 |
| C4 | Own-history pricing: rate suggestions from the builder's actual costs per cost code | 5 |
| C5 | Transparent estimate: client portal "show me" highlights the measured plan regions behind each estimate line | 7 |

**The product thesis:** takeoff is not a page, it is a *mode of the drawings viewer*
plus a conditions panel, and the quantity is a live, versioned property of the drawing
set that flows into whichever money surface the posture calls for.

## 2. Doctrine (non-negotiable, restated for this feature)

- **No new top-level page. No desk.** The mutation home is the drawings viewer inside
  the project workbench (residential/commercial) or the plan sheet / Design Studio
  (production). Estimator and plan-manager surfaces gain *awareness* (badges,
  deep-links), never a parallel takeoff editor.
- **Posture-neutral engine, posture-routed destination.** Measuring is identical on
  every posture. Where quantities *land* differs (estimate line vs bid scope line vs
  plan takeoff line) and routes through the existing choke points
  (`getProjectPosture()`, `PROJECT_MODULES`, `postures:` in
  `components/layout/project-nav-items.ts`). Never `if (posture === ...)` inline.
- **Naming:** the new tables are posture-neutral (`takeoff_conditions`, columns on
  `drawing_markups`). Never `residential_takeoff_*`. "Takeoff" is a legitimate domain
  term but must stay clearly distinct from the existing production
  `house_plan_takeoff_lines` (spreadsheet-imported plan quantities).
- **Money is integer cents; quantities are numeric; format at the edge.**
- Services own logic: `requireOrgContext()` → permission → logic → `recordEvent()` +
  `recordAudit()` → DTO. Actions return `{ success, error }`.
- Migrations: write into `supabase/migrations/`, **STOP and tell the human**. Never
  apply. Local env is PRODUCTION Supabase.
- Design: ascetic zone rules apply (`docs/design.md`). Condition colors are *state/
  identity of a condition*, chosen from a fixed token-derived palette — not decoration.
  Dense panel, `tabular-nums` for quantities. Every new surface ships empty/loading/
  error/dark.
- **Delete what you replace.** Phase 9 (production destination) replaces the paste
  importer as the *primary* fill path but the importer stays (spreadsheets are a real
  workflow); nothing else in this plan supersedes an existing feature.

## 3. What exists — verified inventory (do NOT rebuild)

### Drawings side

- **Viewer monolith:** `components/drawings/drawing-viewer.tsx` (~2,900 lines).
  Toolbar + tools + calibration + canvas fallback all live here. `MARKUP_TOOLS` at
  ~line 255: `arrow, circle, rectangle, text, freehand, callout, dimension, cloud,
  highlight`. The ONLY measuring tool is `dimension` (2-point linear).
- **Tiled renderer:** `components/drawings/viewer/tiled-drawing-viewer.tsx` —
  OpenSeadragon over DZI tiles; exposes an `ImageToScreenMatrix {a,b,c,d,e,f}` per
  frame. Overlay: `components/drawings/viewer/svg-overlay.tsx` — renders markups in
  image space, receives the matrix imperatively via `SVGOverlayHandle.setTransform`
  (bypasses React state for 60fps — preserve this pattern).
- **Markup storage:** table `drawing_markups` — generic:
  `id, org_id, drawing_sheet_id, sheet_version_id, data jsonb, label, is_private,
  share_with_clients, share_with_subs, created_by, timestamps`. GIN on `data`.
  RLS = `is_org_member(org_id)`. Write permission `drawing.markup`
  (project-scoped via `requireProjectPermission`), read `drawing.read`.
  `data` shape (`markupDataSchema`, `lib/validation/drawings.ts:360`):
  `{ type, points: [x,y][] (normalized 0..1, y-down), color, strokeWidth, text?,
  fontSize?, style? }`. **The measured value of a dimension is never stored** —
  recomputed at render. Service: `lib/services/drawing-markups.ts`.
  ⚠️ `lib/types/drawings.ts` declares a DIFFERENT MarkupType (`measurement`, `area`…)
  — it is **dead code imported by nothing**. The live model is
  `lib/validation/drawings.ts`. Delete the dead file when you first touch this area.
- **Calibration:** two-point flow in drawing-viewer.tsx (~407–416 state, ~926–940
  clicks, ~1104–1150 submit). Stored per **sheet version** at
  `drawing_sheet_versions.extracted_metadata.calibration =
  { feet_per_image_px, set_by, set_at }` via `setSheetVersionCalibration`
  (`lib/services/drawings.ts:1858`); read via `getSheetCalibration` (`:1808`, resolves
  current published revision's latest version). Feet/inches parse/format:
  `parseFeetInches` / `formatFeetInches` (`lib/validation/drawings.ts:236`).
  ⚠️ **Calibration does not carry across revisions** — new revision silently reverts
  dimensions to `"{n}px"` labels (`svg-overlay.tsx:52`). Imperial only.
- **Pipeline:** `lib/services/drawings-pipeline.ts` (~2,100 lines). Outbox jobs:
  `split_drawing_pdf` → chunk fan-out → per-page render (MuPDF WASM + libvips dzsave)
  → `enrich_drawing_metadata`. Text detection `detectSheetMetadata` (~1580) regexes
  the PDF **text layer** (so text extraction already works). Vision enrichment
  `runVisionEnrichment` (~1761) extracts ONLY `sheet_number, sheet_title, discipline,
  confidence` — **no scale**. Merge logic `mergeDetections` (~2070): vision overrides
  only low-confidence text detection.
- **Export:** `lib/services/drawings-export.ts` — as-built PDF via pdf-lib, flattens
  markups, its `dimension` case already recomputes real-feet labels server-side
  (proof the measurement math belongs in a service). Neat selector trick:
  `calibration:extracted_metadata->calibration`.
- **Compare:** `components/drawings/comparison-viewer.tsx` — side-by-side + opacity
  overlay between versions. No geometric diff.
- **Entity links:** `drawing_pins` (`entity_type`/`entity_id` → task/rfi/photo) is the
  established pattern for linking drawing geometry to other modules.

### Money side

- **Estimate lines** (`estimate_items`): `cost_code_id, item_type('line'|'group'),
  description, quantity numeric default 1, unit text, unit_cost_cents int,
  markup_pct numeric, sort_order, metadata jsonb`. Provenance already flows through
  `metadata` via `buildLineMetadata()` (`lib/services/estimates.ts:35-47`) — e.g.
  `source_bid_submission_id` from the "Use bid" dropdown
  (`components/estimates/estimate-create-sheet.tsx:721-745`). Totals single-source:
  `lib/financials/estimate-totals.ts` — **needs zero changes** for takeoff.
  Estimates attach to `project_id` OR `prospect_id` (precon before a project exists).
- **Bid scope lines** (`bid_scope_items`): `item_type('base'|'alternate'|'allowance'|
  'unit_price'), description, quantity numeric, unit, budget_cents, cost_code_id`.
  The commercial destination. Sub pricing per line: `bid_submission_items`.
- **Plan takeoff lines** (`house_plan_takeoff_lines`,
  `supabase/migrations/20260718170333_house_plans.sql:79`): `house_plan_version_id,
  elevation_id, cost_code_id, cost_type, description, quantity NOT NULL, uom NOT NULL,
  unit_cost_cents, sort_order, metadata` (immutability trigger, ≤2000 lines).
  The production destination. Written via `replaceTakeoffLines`
  (`app/(app)/plans/actions.ts:57`). Current fill path: paste importer
  `lib/plans/takeoff-import.ts` (pure parser, keep).
- **Unit-rate sources:** `cost_codes.unit` + `default_unit_cost_cents` +
  `default_markup_percent` (de-facto residential rate book);
  `vendor_price_agreements` (`lib/services/price-book.ts`, production PO pricing);
  `arc_bid_benchmark_facts` (bid intelligence).
- **Budget lines have NO qty/rate columns** — every estimate→budget path flattens to
  `amount_cents`. Do not try to carry qty into budgets in this plan (explicit non-goal).

## 4. Data model (all new DDL in ONE migration per phase; human applies)

### Phase-1 migration — measured markups

Extend `drawing_markups` with real columns (values must be queryable — do NOT bury
them in `data`):

```sql
alter table drawing_markups
  add column quantity numeric,          -- computed real-world value; null for non-measuring types
  add column uom text,                  -- 'lf' | 'sf' | 'ea' (v1); constraint below
  add column condition_id uuid references takeoff_conditions(id) on delete set null;
-- check (uom in ('lf','sf','ea'))
-- index (org_id, condition_id)
```

New markup `data.type` values: `polyline`, `area`, `count`. `quantity` is written
server-side on create/update (service computes from points × image dims × calibration)
and **recomputed in bulk when calibration changes** (add this to
`setSheetVersionCalibration`).

### Phase-2 migration — conditions

```sql
create table takeoff_conditions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  project_id uuid references projects(id),            -- residential/commercial home
  house_plan_version_id uuid references house_plan_versions(id), -- production home (phase 9)
  name text not null,                                  -- "LVP flooring", "Base trim"
  uom text not null,                                   -- lf | sf | ea; all member markups must match
  cost_code_id uuid references cost_codes(id),
  color text not null,                                 -- from fixed palette (see design note)
  waste_pct numeric not null default 0,                -- the ONE estimating nicety in v1
  unit_cost_cents integer,                             -- optional pinned rate (else cost-code default)
  sort_order integer not null default 0,
  created_by uuid, created_at, updated_at,
  check (num_nonnulls(project_id, house_plan_version_id) = 1)
);
```

RLS copied from a recent org-scoped neighbor, `(select auth.uid())` form. Indexes:
`(org_id, project_id)`, `(org_id, house_plan_version_id)`. Standard `updated_at`
trigger. Effective quantity of a condition =
`sum(markup.quantity) * (1 + waste_pct/100)` — computed in the service, never stored.

**Estimate provenance (no migration):** `estimate_items.metadata.takeoff = {
condition_id, measured_quantity, waste_pct, synced_at }` via `buildLineMetadata()` —
identical pattern to `source_bid_submission_id`.

### Registration checklist (applies to `takeoff_conditions`)

RLS + indexes ✓ above · RBAC catalog seed: `takeoff.read` / `takeoff.write`
(grant write to the roles that hold `drawing.markup` + estimator; state this in the
migration) · search index mapping in `lib/services/search-index.ts` ·
`recordEvent()` on condition create/update/sync-to-estimate · email: **none**
(do not add to `EMAIL_NOTIFICATION_TYPES`) · mobile API: **not in v1** ·
cron: none.

## 5. Phases

Ship order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Phases 3, 5, 7 are independent
of each other once 2 ships (parallelizable). Phase 6 depends on 4. Phase 8 is last.

---

### Phase 0 — De-risk the viewer (no user-visible change)

**Goal:** `drawing-viewer.tsx` (~2,900 lines) cannot absorb three new tools cleanly.
Extract the tool layer first.

- Extract tool state + pointer handling into a `useMarkupTools` hook or a
  `components/drawings/viewer/tools/` module; the monolith keeps orchestration only.
- Extract the geometry math (px↔normalized↔feet conversions, per-type
  quantity computation) into a pure module `lib/drawings/measure.ts` — client-safe,
  unit-testable, shared by viewer, service, and PDF export
  (today the math is duplicated between `svg-overlay.tsx` and `drawings-export.ts`;
  this extraction unifies it — delete the duplicates).
- Delete dead `lib/types/drawings.ts`.
- **Acceptance:** zero behavior change; all existing markup tools + calibration +
  export work; `pnpm lint && npx tsc --noEmit` clean; new `measure.ts` has unit tests
  (linear, polygon area via shoelace, count) under the drawings/schedule-adjacent
  test setup.

### Phase 1 — Real measurement tools + persisted quantity

**Goal:** the viewer measures LF, SF, EA and the numbers are queryable.

- Add `polyline` (multi-point linear, double-click/Enter to finish), `area`
  (closed polygon, shoelace area, Escape cancels, click-near-start closes), `count`
  (each click = one point; qty = points.length) to `markupDataSchema`,
  `MARKUP_TOOLS`, `svg-overlay.tsx`, the canvas fallback, and
  `drawings-export.ts`.
- Migration (Phase-1 DDL above). Service `createDrawingMarkup`/`updateDrawingMarkup`
  compute and write `quantity`+`uom` server-side using `lib/drawings/measure.ts`
  and the sheet-version calibration + `image_width/height`. Uncalibrated sheets:
  markups save with `quantity = null` and the overlay labels show px (existing
  behavior) plus a "set scale" nudge.
- `setSheetVersionCalibration` gains a bulk-recompute of all measuring markups on
  that sheet version.
- Calibration hardening: when a new **version/revision** is created for a sheet whose
  prior version had calibration, copy it forward into the new version's
  `extracted_metadata.calibration` with `carried_from_version_id`; the viewer shows
  "Scale carried from Rev N — verify" until a user confirms (confirm = re-save
  calibration without the flag). Do this inside the pipeline where the new version
  row is created.
- Overlay labels: polyline shows `142'-6" LF`-style, area shows `1,240 SF`, count
  shows the running count at the last point. `tabular-nums`.
- **Acceptance:** measure all three types on a calibrated sheet; values persist and
  survive reload; recalibrating updates stored quantities; as-built PDF export shows
  the same labels; uncalibrated flow degrades gracefully; empty/loading/error/dark
  verified; suites: whatever covers drawings + `pnpm test:financials` untouched-green.

### Phase 2 — Conditions + takeoff panel + send-to-estimate

**Goal:** measurements organize into priced line items; the client-facing ask is met.

- Migration (Phase-2 DDL). New service `lib/services/takeoff.ts` (follow
  `lib/services/change-orders.ts` structure): CRUD conditions, assign/unassign
  markups (`condition_id`), `getConditionRollup(projectId)` (per-condition qty by
  sheet, waste-adjusted total, effective rate from pinned rate → cost-code default),
  `syncConditionsToEstimate(estimateId, conditionIds)`.
- **Takeoff panel** in the project Drawings surface: a docked right-hand panel (new
  `components/drawings/takeoff-panel.tsx`) visible when the viewer is in Takeoff
  mode. Rows = conditions: color chip, name, cost code, qty (tabular-nums), uom,
  rate, extended. Selecting a condition arms the measure tools to auto-assign new
  markups to it and highlights its geometry on the sheet in the condition color.
  Row cap + "N more" per list rules. Dense table, no cards.
- Condition colors: fixed 12-color palette derived from chart/state tokens, assigned
  round-robin — color identifies a condition (state), never decoration.
- **Send to estimate:** dialog listing the project's/prospect's draft estimates (via
  the existing estimate listing service) → for each selected condition, create or
  update an `estimate_items` row: `quantity` = waste-adjusted rollup, `unit`,
  `unit_cost_cents` from effective rate, `cost_code_id`, provenance in
  `metadata.takeoff`. Re-sync shows a diff (old qty → new qty) before writing —
  mirror the preview-before-commit UX of `lib/plans/takeoff-import.ts`'s dialog.
  Never silently overwrite a line whose qty was hand-edited after sync (compare
  against `metadata.takeoff.measured_quantity`; if drifted, require explicit choice).
- **Estimate workbench awareness:** in `estimate-create-sheet.tsx`, lines with
  `metadata.takeoff` get a small measured-quantity badge; clicking deep-links to the
  drawings viewer in takeoff mode with the condition selected (`?condition=` param —
  mirror the `?item=` deep-link pattern from the schedule Gantt).
- Guard: deleting a markup that belongs to a synced condition flags the condition
  "quantity changed since last sync" (computed, not stored); deleting a condition
  with synced lines requires confirm and stamps the estimate line
  `metadata.takeoff.detached = true`.
- **Acceptance:** full loop works — measure → condition → send → estimate line with
  correct qty/rate/total per `estimate-totals.ts`; re-measure → re-sync shows diff;
  events + audit recorded; RBAC enforced (user without `takeoff.write` gets read-only
  panel); `pnpm test:financials` + `pnpm test:auth` green.

### Phase 3 — Zero-click scale (C1)

**Goal:** most sheets calibrate themselves; manual two-point becomes fallback/verify.

- **3a. Title-block scale via vision:** extend the `runVisionEnrichment` prompt to
  also return `stated_scale` (e.g. `1/4" = 1'-0"`, or `null`). Parse to
  feet_per_image_px using the PDF page dimensions + render DPI already known to the
  pipeline. Store as `extracted_metadata.calibration_proposal =
  { feet_per_image_px, method: 'title_block', raw: '1/4"=1\'-0"' }` — a PROPOSAL,
  never auto-applied.
- **3b. Dimension cross-check:** new pipeline step (same enrichment job): from the
  MuPDF text layer, find dimension strings (`parseFeetInches`-matchable tokens) and
  their positions; for nearby collinear vector segments (MuPDF page display list —
  spike this API first), compute implied feet-per-px per string. If ≥3 strings agree
  within 1%, emit `calibration_proposal` with `method: 'dimension_check',
  sample_count, spread_pct`. Dimension-check beats title-block when both exist.
- Viewer: uncalibrated sheet with a proposal shows a one-click confirm bar
  ("Scale detected: 1/4" = 1'-0" — verified against 7 printed dimensions · Apply").
  Applying writes real calibration with `method` recorded. The verified badge
  (`method: 'dimension_check'`) renders next to the scale readout.
- Raster/scanned sheets (no text layer): proposal absent, manual flow unchanged.
- **Acceptance:** on a vector test PDF, upload → sheet shows a proposal without any
  human input; applying calibrates and Phase-1 quantities compute; a scanned PDF
  degrades to manual; enrichment failures never block sheet publishing (mirror
  existing `vision_error` handling).

### Phase 4 — Vector extraction spike (gate for C2)

**Goal:** answer "how good is wild-PDF vector data?" before betting Phase 6 on it.

- Timeboxed spike, output = a written verdict in `docs/takeoff-vector-spike.md`, not
  shipped code. Using the MuPDF WASM already vendored: extract the display list for
  5–10 real customer sheets (ask the human for representative project IDs; read via
  existing storage paths). Measure: % of wall lines present as clean segments,
  closed-loop detectability of rooms, symbol repetition detectability
  (door/window/fixture blocks), noise level (hatching, text outlines).
- Verdict decides Phase 6 shape: **A** (vectors good → geometric snapping/flood-fill),
  **B** (vectors messy → vision-model-assisted: send the tile crop + click point to
  the vision model, get a polygon back), or **C** (hybrid, likely). Do not skip the
  spike and guess.

### Phase 5 — Own-history pricing (C4)

**Goal:** the rate field is never blank and never RSMeans.

- New read-only service function in `lib/services/takeoff.ts` (or
  `bid-intelligence.ts` if it fits better — check first): for a cost code, return
  `{ p25, median, p75, sample: [{project, vendor, unit_rate_cents, date}] }` derived
  from `commitment_lines` / bills joined through cost codes where a unit rate is
  computable, plus `vendor_price_agreements` where in scope. Cap samples, org-scoped,
  aggregate in SQL (RPC if sums exceed row limits — follow the platform-ops RPC
  pattern).
- Surface in the condition rate editor: suggestion row "You've paid $4.05–$4.30/SF
  across 6 jobs (last: Mar 2026)" with one-click accept + expandable evidence list.
- **Acceptance:** suggestions match hand-computed rates on a known org; codes with no
  history show cost-code default silently (no fake data); read path permission-gated
  by financial visibility (respect `financials.margin.read` semantics — check how
  estimate rate visibility is gated today and match it).

### Phase 6 — AI-assisted measurement (C2; shape decided by Phase 4)

**Goal:** click-magic + command-bar takeoff, always draft → approve.

- **Click-to-trace:** in takeoff mode with an area condition armed, a modified click
  (e.g. alt-click) inside a room proposes a polygon (method per spike verdict);
  the proposal renders dashed in the condition color with Accept/Adjust/Reject.
  Accepted = a normal `area` markup, `data.style.generated = method`. Same for
  wall-run tracing (polyline) and **count-by-symbol** ("find matches on this sheet"
  from one counted symbol; every hit is an individual vetoable point).
- **Command-bar takeoff** (only if `ai_search_enabled` org flag — reuse the existing
  gate): "take off interior walls on A-102" → a background job produces a DRAFT
  condition + markups in a review state; the takeoff panel shows a pending-review
  band; nothing counts toward rollups until approved. Reuse the outbox job pattern;
  register any new job type per the cron/jobs checklist if it needs one.
- Every generated shape is an ordinary markup after acceptance: editable, deletable,
  audited. No black-box quantities anywhere.
- **Acceptance:** trace/count work on the spike's test sheets with ≥80% no-adjust
  acceptance on clean vector sheets; rejection leaves no residue; drafts never leak
  into rollups or estimate sync; degraded gracefully on raster sheets (tools hidden
  or vision path per verdict).

### Phase 7 — Transparent estimate portal (C5)

**Goal:** the client taps an estimate line and sees the plan regions light up.

- In `/e/[token]` (`lib/services/estimate-portal.ts` + portal client components):
  lines with `metadata.takeoff` get a "show me" affordance opening an embedded
  read-only sheet view with that condition's geometry highlighted. Reuse the existing
  portal drawing read path (`app/api/portal/drawings/[token]/route.ts`) — extend its
  token scope rather than minting a new route family. Only markups whose condition
  the builder marked client-visible are exposed (add `share_with_clients` semantics
  at the CONDITION level; per-markup flags already exist — condition setting wins).
- **Acceptance:** portal token can render only the allowed sheets/geometry (verify
  with a second org's token → 404); builder toggle hides a condition from the portal
  immediately; mobile-width portal rendering verified.

### Phase 8 — Living takeoff / revision re-anchoring (C3)

**Goal:** a new revision updates quantities instead of orphaning them. Hardest phase;
everything above must be stable first. Design doc REQUIRED before code
(`docs/takeoff-reanchor-design.md`) covering the state machine:

- Measurements pin to `sheet_version_id` (already true). On new revision publish:
  each measuring markup on the prior version enters `pending_reanchor`; a job
  attempts geometric transfer (start simple: identity transform + calibration carry;
  detect changed regions via raster diff of the two versions' tiles — the comparison
  infrastructure exists); markups over unchanged regions auto-transfer, markups
  touching changed regions queue for human review in the takeoff panel
  ("3 conditions touch changed areas on A-101 Rev 3").
- After re-anchor, re-run rollups; conditions whose qty moved AND are synced to an
  executed estimate raise the money alert: "Rev 3 changed Flooring +240 SF ≈ +$1,032
  — draft a change order?" deep-linking into the existing CO creation flow with a
  prefilled description. NEVER auto-create the CO.
- Even the fully-degraded mode (everything queues for review, nothing auto-transfers)
  ships value — build that first, add auto-transfer after.
- **Acceptance:** revision upload on a measured sheet produces review queue not data
  loss; unchanged-region auto-transfer verified on a test pair; stale-estimate alert
  fires with correct delta; no markup ever silently deleted.

### Phase 9 — Production + commercial destinations

**Goal:** one engine, three landing zones.

- **Production:** conditions can live on `house_plan_version_id` (column exists from
  Phase 2). The plan sheet ("bill of process", `docs/plan-sheet-redesign.md`) gains
  "Measure from drawings" → viewer in takeoff mode against the plan's drawing set;
  sync writes `house_plan_takeoff_lines` via the existing `replaceTakeoffLines`
  semantics (respect the immutability trigger — sync only to draft plan versions;
  elevation mapping: conditions sync to `elevationId: 'base'` in v1, per-elevation
  conditions deferred). The paste importer remains; the release gate
  (`lib/plans/release-gates.ts` — takeoff_line_count > 0) is satisfied by either path.
- **Commercial:** the send-to dialog gains "bid package scope" as a destination when
  posture allows — writes `bid_scope_items` with `item_type: 'unit_price'`,
  `quantity`, `unit`, `cost_code_id`. Route the destination list through
  `getProjectFinancialFeatureConfig()` / posture choke points — the ENGINE never
  checks posture.
- **Acceptance:** production plan measured → bill filled → release gate passes → PO
  generation math consumes the lines unchanged (`pnpm test:starts` +
  `pnpm test:land` green); commercial sync produces scope lines subs can price in
  the existing bid portal; residential flow untouched.

## 6. Non-goals (do not build, do not scaffold "for later")

- Budget-line quantities (budget stays `amount_cents`-flat; the estimate is the
  qty-bearing document).
- Assemblies (one measurement → many priced items), deduction cutouts, roof-pitch/
  slope factors, metric units, RSMeans-style third-party cost data.
- Mobile takeoff. A takeoff DESK. Auto-created change orders. Prospect-level
  drawings (see open decisions).
- AI auto-takeoff without human approval, in any form.

## 7. Open decisions (ask the human before the affected phase)

1. **Prospect-stage takeoff** (before Phase 2): estimates attach to prospects, but
   drawings are project-scoped. Recommendation: create the project at estimating time
   (conversion machinery already handles prospect→project); drawings-on-prospects is
   scope creep. Confirm.
2. **Vision model + cost ceiling for 3a/6** (before Phase 3): which model the
   enrichment prompt extension runs on and per-sheet budget.
3. **Phase 4 verdict sign-off**: human reads the spike doc and picks A/B/C before
   Phase 6 starts.
4. **Condition palette** (before Phase 2): confirm the 12 colors against
   `docs/design.md` token rules with the human — color-as-identity for conditions is
   a deliberate doctrine carve-out and should be blessed once, in writing.

## 8. Verification (every phase)

```bash
pnpm lint && npx tsc --noEmit
```

plus the suites named in each phase's acceptance. Migrations: written, NOT applied —
stop and hand to the human. Schema drift: `pnpm db:schema:check` after any migration
lands. Every new surface: empty / loading / error / dark verified before "done".

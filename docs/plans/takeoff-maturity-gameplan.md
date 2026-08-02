# Takeoff Maturity — Gameplan (v2: land, harden, close table-stakes, then differentiate)

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

> **Audience:** an LLM executing agent. Read this file FULLY before opening any code.
> It assumes you have internalized `/CLAUDE.md` (posture doctrine, design rules,
> registration checklist, verification commands) and `docs/archive/takeoff-gameplan.md`
> (the v1 master — its §2 doctrine and §3 inventory still apply wholesale).
> Everything here was verified against the live working tree on 2026-07-30.
> **The takeoff subsystem is untracked, in-flight code** — re-verify every fact
> against the file before building on it. Phases are ordered by dependency;
> do not start a phase before its prerequisites ship.

## 1. Mission

The v1 takeoff (measuring, conditions, sync, re-anchoring) is architecturally sound
but market-incomplete. An estimator coming from STACK / PlanSwift / Procore
Estimating hits four walls in the first hour, and the branch as it sits **does not
compile** (missing modules, see Phase 0). This gameplan takes the system from
"competent measuring tool" to "the takeoff that never dies at export":

| # | Objective | Phase |
|---|---|---|
| M0 | Branch compiles; in-flight assist/spaces layer finished or amputated | 0 |
| M1 | Money paths covered by service-level tests (rollup, sync/drift, re-anchor, permissions) | 1 |
| M2 | Concrete is takeoff-able: CY via per-condition depth factor | 2 |
| M3 | Deduction (negative) areas — wall minus windows, slab minus stairwell | 2 |
| M4 | Org-level condition template library — carry your conditions job to job | 3 |
| M5 | Rollup CSV export | 3 |
| M6 | Geometric re-anchor auto-confirm — only *changed* regions need review | 4 |
| M7 | Plans → draft-estimate pipeline: rooms + templates + own-history rates → traceable draft estimate | 5 |

**Strategic frame (why this order):** Phases 0–1 make the existing work shippable.
Phases 2–3 close the gaps that disqualify Arc as a daily-driver takeoff (volume,
deductions, templates, export) — parity items, kept deliberately small. Phases 4–5
are the differentiators no standalone tool can copy: the takeoff stays alive through
revisions and prices itself from the builder's own history. Do **not** reorder 4–5
before 2–3; a magical draft estimate that can't take off a slab is a demo, not a product.

## 2. Doctrine (restated deltas only — v1 gameplan §2 still binds)

- Takeoff remains a **mode of the drawings viewer**. No desk, no new top-level page.
  The template library lives in Settings (org surface, read-mostly — allowed).
- **AI/geometry proposes, human approves. No exceptions.** Every generated quantity
  is draft-state until a person accepts it. This includes Phase 4 auto-confirm
  (which auto-confirms only provably-unchanged geometry, and says so) and the entire
  Phase 5 pipeline.
- Quantities are computed **server-side only** (`lib/services/drawing-measurements.ts`);
  the client never supplies a quantity. Preserve this in every new write path.
- Migrations: write into `supabase/migrations/`, **STOP and tell the human**. Local
  env is PRODUCTION Supabase. The three existing takeoff migrations
  (`20260728150000`, `20260728150100`, `20260729120000`) may not be applied yet —
  check `list_migrations` via Supabase MCP before assuming schema.
- All comparisons of quantities use `QUANTITY_EPSILON` from `lib/drawings/measure.ts`,
  never `===`.

## 3. Verified inventory pointers (do NOT rebuild)

The full inventory is v1 gameplan §3. Deltas discovered 2026-07-30:

- `lib/services/takeoff.ts` (~1,392 ln) — conditions CRUD, `getConditionRollup()`
  (4-query, classifies counted / stale / pending-review / unscaled), `loadSyncStates()`,
  `previewConditionSync()`, `syncConditions()` (estimate / bid scope / plan lines,
  drift resolution, 23505-recovery). Legacy `arc-takeoff:` magic-string read path at
  ~line 1034 — dies in Phase 0.
- `lib/services/takeoff-reanchor.ts` (~491 ln) — verbatim-geometry copy on revision
  publish, `needs_review` state in `data.style.reanchor`, review queue,
  `listStaleEstimateAlerts()` (executed-estimate dollar deltas + CO deep link).
  Geometric mode is designed in `docs/takeoff-reanchor-design.md` §3b, NOT built.
- `lib/services/takeoff-pricing.ts` — p25/median/p75 own-history rates from
  `commitment_lines` + `vendor_price_agreements`, gated on `financials.margin.read`.
- `lib/drawings/vector-snap.ts` (~1,258 ln, pure) — snap index, `findEnclosingLoop`
  flood fill (door-gap bridging ≤24px, wall-plausible pass), `extractAllFaces()`,
  `pointInPolygon()`. `lib/drawings/vector-analysis.ts` — stats + `recommendVerdict()`.
- Spike verdict (`docs/takeoff-vector-spike.md`): 20 sheets → 6A/0B/14C, hybrid
  routing `connectedEndpointPct ≥ 45 && roomSizedLoopCount ≥ 3` → geometric-first.
- `drawing_sheet_versions.extracted_metadata` carries `calibration`,
  `calibration_proposal`, `vector_stats`, `spaces` — all JSON, no new tables.
- Tests that exist: `tests/takeoff-measure|snap|scale|vector-merge|import` — pure
  function tests only. **Zero service-level tests.**
- UOM enum `('lf','sf','ea')` is enforced in THREE places: DB check constraints
  (both migrations), `lib/validation/takeoff.ts` Zod, and `MEASURING_TYPE_UOM` in
  `lib/drawings/measure.ts`. Any unit change touches all three.

## 4. Phases

### Phase 0 — Land the in-flight work (blocker; nothing else may start)

The working tree references symbols that do not exist. Resolve each by **finishing
it** (preferred where the surrounding UI is already wired) or **amputating cleanly**
(delete the call sites too — no dead wiring left behind):

1. `components/drawings/drawing-viewer.tsx` calls three server actions that exist
   nowhere: `findSymbolMatchesAction` (count-by-symbol), `saveRoomMapAction`
   (room-map editor publish), `isTakeoffAssistAvailableAction`. Types `SpaceRoom`,
   `RoomMapSource` also unresolved. The Zod schemas for the assist layer already
   exist and are imported by nothing: `lib/validation/takeoff.ts:122–162`
   (`assistTracePolygonSchema`, `assistSymbolPointsSchema`, `assistSheetPointSchema`,
   `ASSIST_COORD_GRID = 1000`). Finish: implement the actions in
   `app/(app)/projects/[id]/drawings/` actions file (or wherever the sibling drawing
   actions live — match the neighbor), backed by a `lib/services/takeoff-assist.ts`
   service. Symbol matching is geometric first (repeated-shape groups already
   computed in `vector-analysis.ts`); vision fallback per the spike routing rule.
2. `extract_drawing_spaces` job in `lib/services/drawings-pipeline.ts` (~line 2267)
   imports `lib/drawings/spaces-artifact.ts` which is not on disk, and the job type
   is missing from `DRAWING_PIPELINE_JOB_TYPES`. Write the artifact module
   (read/write `spaces.json` next to `vectors.bin`, schema = room polygons + labels
   + printed SF + `inferred_feet_per_image_px`), register the job type.
3. Kill the legacy provenance path: once migration `20260729120000` is confirmed
   applied (check via MCP `list_migrations`; if not applied, STOP and tell the
   human), delete the `arc-takeoff:` details-string fallback read in
   `lib/services/takeoff.ts` ~1034.
4. Close the scope hole: `assignMarkupsToCondition()` validates uom and org but not
   that the markup's sheet belongs to the condition's project (or, for plan-scoped
   conditions, to a lot project of that plan). Add the check; return a typed error.
5. **Exit gate:** `pnpm lint && npx tsc --noEmit` completely clean, plus
   `pnpm test:financials` green. Commit the subsystem (it is currently 100% untracked).

### Phase 1 — Service-level tests on the money paths

Pure-function coverage exists; the code most likely to move money incorrectly has
none. Add integration-style service tests (mock the Supabase client the way the
nearest existing service test does — find the exemplar in `tests/` before inventing
a harness). Cover, at minimum:

- **Rollup classification** (`getConditionRollup`): a member on a superseded version
  → `stale_markup_count`, excluded from total; `needs_review` re-anchor → pending,
  excluded; uncalibrated → unscaled; mixed set totals only the counted members;
  waste applied after summation; rate resolution order (pinned → cost-code default
  → null) and `rate_source` correctness.
- **Sync + drift** (`previewConditionSync` / `syncConditions`): create vs update vs
  unchanged vs drift classification; hand-edited line skipped without
  `drift_resolution='overwrite'`, overwritten with it; 23505 unique-violation
  recovery path; locked destinations (signed estimate, awarded package) rejected
  with reason; estimate header totals recomputed after write.
- **Re-anchor** (`reanchorRevisionMeasurements`): idempotency via `source_markup_id`
  (run twice → no duplicates); nothing deleted; copies excluded from rollup until
  `confirmReanchoredMarkups`; `listStaleEstimateAlerts` fires only for executed
  estimates and computes `delta_cents` correctly.
- **Permissions:** `takeoff.write` required for condition/markup mutations;
  `financials.margin.read` gates rate history (`visible:false` shape without it).
- **UOM guard:** `assertConditionAcceptsUom` rejects cross-uom assignment through
  every entry point (create, update, bulk assign).

Wire these into whichever suite command fits (`pnpm test:financials` or a new
`test:takeoff` script — if new, add it to package.json AND to the verification
table in `/CLAUDE.md`).

### Phase 2 — Volume (CY) + deduction areas

**One migration**, e.g. `20260730XXXXXX_takeoff_volume_deductions.sql`. Human applies.

**2a. Volume via per-condition depth factor.** Do NOT add a volume drawing tool —
estimators measure a slab in plan view (SF) and apply a depth. Model:

- `takeoff_conditions`: extend the `uom` check to `('lf','sf','ea','cy')`; add
  `depth_in numeric null check (depth_in > 0)`. Constraint: `depth_in` required
  when `uom='cy'`, null otherwise (`check ((uom='cy') = (depth_in is not null))`).
- Markups keep their measured uom (`sf`). Relax `assertConditionAcceptsUom`: a
  `cy` condition accepts `sf` markups (and only `sf`). Everything else stays exact-match.
- Conversion lives in ONE place — `lib/drawings/measure.ts`:
  `cyFromSf(sf, depthIn) = sf × (depthIn/12) / 27`, rounded via the existing 2dp
  convention. Rollup converts the summed SF, **then** applies waste. Panel shows
  `SF measured → CY effective` so the math is inspectable.
- Zod (`lib/validation/takeoff.ts`) + `MEASURING_TYPE_UOM` consumers updated —
  remember the three-layer enum (§3). Sync writes `unit='cy'` to destinations
  (all three destination tables take free-text `unit`, no schema change needed).
- Editor (`takeoff-condition-editor.tsx`): uom picker gains CY; picking it reveals a
  depth field (inches, with a ft-in affordance via `parseFeetInches`). Depth is
  editable after create (unlike uom) — changing it recomputes rollups live since
  nothing is persisted.

**2b. Deduction areas.** A markup-level flag, not a new markup type:

- `markupDataSchema` (`lib/validation/drawings.ts`): add optional
  `style.deduction: boolean` on `area` markups only.
- Server (`drawing-markups.ts` create/update): when `deduction=true`, store
  `quantity` **negative**. Rollups, sync, and drift then work unchanged — they sum.
- Guard in `getConditionRollup`: clamp effective condition quantity at ≥ 0 with a
  `net_negative` flag surfaced in the panel (a condition that nets negative is a
  user error, never a negative estimate line).
- Viewer: a "deduct" toggle in the area tool options; deduction polygons render
  hatched in the condition's color at reduced opacity (tokens only, no new colors).
  Labels show `−240 SF`. Portal evidence dialog and as-built export
  (`drawings-export.ts`) render the same hatch.
- Tests: extend Phase-1 rollup tests with mixed positive/negative members, the
  clamp, and CY conversion (measure tests for `cyFromSf` edge cases too).

### Phase 3 — Condition templates + rollup export

**3a. Org condition template library.** New entity → the FULL registration
checklist from `/CLAUDE.md` applies (RLS with `(select auth.uid())`, RBAC catalog
seed, search index, events, email-allowlist N/A, mobile N/A, cron N/A).

- Migration: `takeoff_condition_templates`
  (`id, org_id, name, uom, depth_in, cost_code_id, color, waste_pct,
  unit_cost_cents, share_with_clients, notes, sort_order, group_name text null,
  created_by, timestamps`) — same shape as `takeoff_conditions` minus scope columns,
  plus `group_name` (flat one-level grouping: "Concrete", "Framing" — NOT a
  hierarchy). Permissions: reuse `takeoff.read`/`takeoff.write` (org-level).
- Service `lib/services/takeoff-templates.ts`: CRUD +
  `applyTemplates(scope, templateIds)` → bulk-insert conditions into a
  project/plan-version scope (respect the 200 cap; skip name collisions,
  report skips) + `saveConditionsAsTemplates(conditionIds)` (reverse direction —
  this is how a library gets seeded from the org's first real job).
- UI: management lives at `/settings` in the cost-coding/templates family (match
  the settings language per the settings-redesign memory — microlabel groups,
  dialog editing). In the viewer, the takeoff panel's "New condition" flow gains
  an "Add from library" list (grouped by `group_name`, checkbox multi-add).
  Empty-project nudge: when a scope has 0 conditions and the org has templates,
  the panel's empty state offers the library first.
- **This phase is a Phase-5 prerequisite** — the draft-estimate pipeline maps
  rooms onto template conditions.

**3b. Rollup CSV export.** Small, do it in the same phase. A server action (not a
route) that renders `getConditionRollup` for all conditions in scope to CSV:
condition, uom, measured qty, waste %, effective qty, rate, rate source, extended
cents (formatted at the edge), per-sheet breakdown rows beneath each condition,
and flag columns (unscaled/pending/stale counts — the export must be as honest as
the panel). Client triggers download from the panel's overflow menu. Mirror the
CSV mechanics of `components/plans/plan-bill.tsx`.

### Phase 4 — Geometric re-anchor auto-confirm (the "living takeoff" payoff)

Today every revision dumps ALL measurements into a review queue ("degraded mode").
The design for the real thing exists — `docs/takeoff-reanchor-design.md` §3b —
read it fully first. Implementation shape:

- New pipeline step inside the existing re-anchor outbox job (NOT a new job type
  unless the design doc says otherwise): for each measuring markup, compare the
  local region between predecessor and new version. Prefer vector comparison
  (`vectors.bin` exists for both versions when `vector_stats.aligned`): sample the
  segments intersecting the markup's bbox (inflated ~2%), compare via the segment
  hash/tolerance approach in the design doc. Raster fallback per §3b when vectors
  are absent/unaligned.
- Outcomes per markup, stamped in `data.style.reanchor`:
  `state:'auto_confirmed', reason:'region_unchanged'` (counts in rollups
  immediately, but carries the stamp so the UI can disclose it) vs
  `state:'needs_review', reason:'region_changed' | 'not_attempted'`.
- The revision band (`takeoff-revision-band.tsx`) then shows "12 measurements
  carried automatically (unchanged), 3 need review" — with the 3 sorted by
  `delta_cents` impact from `listStaleEstimateAlerts`.
- **Safety rail:** auto-confirm NEVER fires when the markup's condition is synced
  to an executed estimate — those always queue for human review regardless of
  geometry, because the downstream is a signed contract.
- Tests: unchanged-region → auto-confirmed; any vector delta in bbox → review;
  executed-estimate rail; idempotency preserved.

### Phase 5 — Plans → draft estimate ("the groundbreaking one")

Compose what now exists into one flow: **upload plans → rooms extracted → scale
derived → template conditions applied → quantities proposed per room → rates from
own history → draft estimate, every line tracing to geometry.** Human approves at
each gate. Prerequisites: Phases 0–3 shipped (spaces job live, templates exist,
CY works).

- **Entry point:** on the estimate side, not the viewer — a "Draft from drawings"
  action in the estimate create flow (`components/estimates/estimate-create-sheet.tsx`
  already renders takeoff badges; this is its sibling). Available when the project
  has published sheets with `spaces` metadata. No new page.
- **Step 1 — rooms:** present the extracted room map (reuse the room-map
  editor/publish flow from Phase 0.1) for the human to approve. Approved rooms are
  the quantity substrate.
- **Step 2 — mapping:** a rules layer, `lib/services/takeoff-draft.ts`:
  map template conditions onto approved rooms. v1 mapping is deterministic and
  dumb-transparent: area templates (flooring SF, slab CY) ← room polygon areas;
  perimeter-derived LF templates ← room perimeters (already computed in
  `measure.ts`); count templates are proposed at 0 with a "count these by symbol"
  deep link into the viewer's Phase-0 symbol tool. NO model call in the mapping —
  the intelligence is the geometry plus the org's template library. (A vision-
  assisted mapping pass is a later option — leave a seam, not a stub.)
- **Step 3 — materialize as drafts:** for each mapped template, create a real
  `takeoff_condition` in the project + real `area` markups per room (stamped
  `data.style.generated='draft_estimate'`, draft state — reuse the exact
  Alt-click-assist draft→approve mechanic and rendering). The human accepts/
  rejects per condition in the takeoff panel. Nothing here invents new machinery;
  it batches the existing proposal flow.
- **Step 4 — price + sync:** accepted conditions get rates via the existing
  resolution chain (pinned → own-history suggestion surfaced with the p25–p75 band
  → cost-code default), then flow through the EXISTING `syncConditions()` into a
  **draft** estimate. The result is indistinguishable from a hand-built takeoff —
  because it is one, assembled faster.
- **The demo sentence this must earn:** "Upload plans, get a defensible draft
  estimate priced from your own past jobs in under an hour, and every number
  clicks back to a highlighted region on the sheet." If a step can't be inspected
  or rejected, it doesn't ship.
- Production posture: the same flow targeting a draft `house_plan_version`
  (conditions plan-scoped, drawings via `listPlanDrawingSources()`), entered from
  the plans workbench "Measure from drawings" dialog. One engine, posture-routed
  destination — no forks.

### Phase 6 (parallel, small) — Concurrency guard

Not a realtime system — just stop silent last-write-wins: markup and condition
update paths take the row's `updated_at` as a precondition
(`.eq('updated_at', seen)`); a miss returns a typed `stale_write` error the client
surfaces as "Changed by someone else — reload." Can land any time after Phase 0;
listed last so it never blocks the feature phases.

## 5. Non-goals (do not build, do not scaffold "for later")

Everything in v1 gameplan §6 still holds, minus what this plan explicitly builds
(volume/CY and deductions graduate from that list). Additionally out of scope here:

- **Assemblies** (one measurement → many priced lines). Depth factors + templates
  cover the bulk of residential need; assemblies are a v3 decision AFTER Phase 5
  proves the template model. Do not leave hooks for them.
- Formula/expression fields on conditions; unit conversion beyond the single
  SF→CY depth rule; metric.
- Condition hierarchy/WBS beyond the flat `group_name` on templates.
- Third-party cost books (RSMeans etc.) — own-history pricing is the moat, not a gap.
- Realtime/multi-user presence (Phase 6 is a guard, not collaboration).
- Auto-created change orders (alert + prefilled link only, as today).
- Mobile takeoff; prospect-stage takeoff (still open decision #1 in v1 §7).

## 6. Open decisions (ask the human before the affected phase)

1. **Phase 0:** finish vs amputate for each of the three missing assist actions —
   default is finish (the UI wiring is already there), but confirm scope.
2. **Phase 2:** is `cy` the only volume unit for v1, or do walls need a second
   depth semantic (vertical thickness vs slab depth)? Default: one `depth_in`,
   documented as "thickness along the unmeasured axis."
3. **Phase 3:** should applying a template snapshot the org's current cost-code
   default rate into the condition's pinned rate, or leave rate resolution live?
   Default: leave live (pinning is a human act).
4. **Phase 4:** auto-confirm threshold (what counts as "unchanged") — take the
   tolerance from the design doc; if it gives none, propose one from real revision
   pairs and get sign-off before enabling.
5. **Phase 5:** does the draft flow create the estimate itself or only fill an
   existing draft estimate? Default: fill an existing draft (estimate creation
   already has its own flow; don't duplicate it).

## 7. Verification (every phase)

- `pnpm lint && npx tsc --noEmit` — both, completely clean.
- `pnpm test:financials` + the takeoff suite from Phase 1; `pnpm test:land` when
  touching plan-version scope; `pnpm db:schema:check` after any migration is applied.
- Every new surface: empty / loading / error / dark mode.
- Any migration: written to `supabase/migrations/`, then STOP for human approval.
- Manual smoke per phase, in the QA org ONLY (never a customer org): the phase's
  headline action end-to-end, including the money landing (open the destination
  estimate/bid/plan line and check the number).

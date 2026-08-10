# Takeoff Maturity — Gameplan (v3: what is LEFT)

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

> **Phases 0–3 and 6 SHIPPED 2026-08-02, plus work this plan never had.**
> Their sections have been deleted from this file; what they built is described
> in **`docs/takeoff-model.md`**, which is the reference doc to read instead.
> In summary, and do NOT rebuild any of it:
>
> - Branch lands, compiles, committed. The assist/spaces layer was amputated
>   cleanly; count-by-symbol came back later as §5 of the reference doc.
> - Volume via depth, **plus** three factors this plan did not anticipate:
>   wall height (LF→SF, for drywall and siding), roof pitch (the ~20% a plan
>   view omits), and density (CY→tons). Units are now
>   `lf/sf/ea/cy/sy/sq/ton`. Generalised as ONE "axis factor" concept —
>   read `docs/takeoff-model.md` §2 before adding another.
> - Deduction areas, hatched in the viewer, the as-built PDF, and the client
>   evidence dialog.
> - Org condition template library at `/settings/takeoff`, with apply and
>   harvest from the takeoff panel.
> - Rollup CSV export carrying every honesty flag as a column.
> - Concurrency guard (`STALE_WRITE`) on condition and template updates.
> - Money-path tests: `pnpm test:takeoff`, rollup math extracted pure into
>   `lib/drawings/condition-rollup.ts`.
> - **Not in the original plan, also shipped:** count by example (geometric
>   symbol matching in the viewer, vision fallback, human accepts); the
>   multi-scale-sheet warning; per-sheet coverage tracking; the cross-sheet
>   double-count signal; the sync badge reading all three destinations; a scope
>   check on markup assignment.
>
> **Open decisions 1–3 are resolved** (see the reference doc). Decision 2 was
> answered by generalising rather than choosing: `depth_in` is thickness,
> `height_ft` is vertical extent, and they are separate fields.

> **Audience:** an LLM executing agent. Read this file FULLY before opening any
> code, and read `docs/takeoff-model.md` first — it describes the system these
> two phases build on, and it is reference, not intent.
>
> Doctrine that still binds: takeoff is a MODE of the drawings viewer (no desk,
> no new top-level page); AI and geometry propose, a human approves, no
> exceptions; quantities are computed server-side only and the client never
> supplies one; all quantity comparisons use `QUANTITY_EPSILON`. Migrations go
> into `supabase/migrations/` and then you STOP — local env is PRODUCTION
> Supabase.

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
each gate. Its prerequisites (templates, axis factors, count-by-symbol) shipped
2026-08-02; the room substrate is open decision #3 below.

- **Entry point:** on the estimate side, not the viewer — a "Draft from drawings"
  action in the estimate create flow (`components/estimates/estimate-create-sheet.tsx`
  already renders takeoff badges; this is its sibling). Available when the project
  has published sheets with an interpreted floorplan model. No new page.
- **Step 1 — rooms:** present the interpreted floorplan (`components/plans/floorplan-review.tsx`
  already reviews walls and named rooms in 2D on the source sheet) for the human
  to approve. Approved rooms are the quantity substrate. See open decision #3.
- **Step 2 — mapping:** a rules layer, `lib/services/takeoff-draft.ts`:
  map template conditions onto approved rooms. v1 mapping is deterministic and
  dumb-transparent: area templates (flooring SF, slab CY) ← room polygon areas;
  perimeter-derived LF templates ← room perimeters (already computed in
  `measure.ts`); count templates are proposed at 0 with a "count these by symbol"
  deep link into the viewer's count-by-example tool (`docs/takeoff-model.md` §5).
  NO model call in the mapping — the intelligence is the geometry plus the org's
  template library. (A vision-assisted mapping pass is a later option — leave a
  seam, not a stub.)
- **Step 3 — materialize as drafts:** for each mapped template, create a real
  `takeoff_condition` in the project + real `area` markups per room (stamped
  `data.style.generated='draft_estimate'`, alongside the `symbol_match` stamp
  count-by-example writes, and using the same propose-then-accept mechanic). The
  human accepts or rejects per condition in the takeoff panel. Nothing here
  invents new machinery; it batches the existing proposal flow.
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

## 5. Non-goals (do not build, do not scaffold "for later")

The full list is `docs/takeoff-model.md` §7. Restated here because these two
phases are exactly where the temptation arises:

- **Assemblies** (one measurement → many priced lines). Axis factors plus
  templates cover the bulk of residential need; assemblies are a decision AFTER
  Phase 5 proves the template model. Do not leave hooks for them.
- **Geometric re-anchoring that MOVES a polygon** onto "the same wall" in the new
  revision. Tempting and wrong: a plan that moved a wall by 6" would silently
  adjust the quantity, which is exactly the change the human needs to see.
  Phase 4 only decides whether a region CHANGED, never where it went.
- Formula/expression fields; metric; condition hierarchy beyond flat
  `group_name`; third-party cost books; realtime presence; auto-created change
  orders; mobile takeoff.

## 6. Open decisions (ask the human before the affected phase)

1. **Phase 4:** auto-confirm threshold — what counts as "unchanged". Take the
   tolerance from `docs/takeoff-reanchor-design.md` §3b; if it gives none,
   propose one from real revision pairs and get sign-off before enabling.
2. **Phase 5:** does the draft flow create the estimate itself, or only fill an
   existing draft? Default: fill an existing draft (estimate creation already has
   its own flow; don't duplicate it).
3. **Phase 5:** room extraction was REMOVED (`extract_drawing_spaces` is a no-op
   in the pipeline). The floorplan interpreter (`lib/drawings/floorplan-*.ts`)
   already produces walls, openings and named rooms in real feet with confidence
   scores, and feeds the 3D viewer. Confirm that it — not a revived spaces job —
   is the quantity substrate for step 1.

## 7. Verification (every phase)

- `pnpm lint && npx tsc --noEmit` — both, completely clean.
- `pnpm test:takeoff` and `pnpm test:financials`; `pnpm test:land` when touching
  plan-version scope; `pnpm db:schema:check` after any migration is applied.
- Every new surface: empty / loading / error / dark mode.
- Any migration: written to `supabase/migrations/`, then STOP for human approval.
- Manual smoke per phase, in the QA org ONLY (never a customer org): the phase's
  headline action end-to-end, including the money landing (open the destination
  estimate/bid/plan line and check the number).

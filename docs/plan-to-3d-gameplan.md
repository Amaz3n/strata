# Plan-to-3D Gameplan — 2D Floorplans → Walkable Models

**Status:** Awaiting execution. Written 2026-07-31.
**Audience:** an LLM executor. Follow directives literally; STOP means stop and ask
the human.

---

## 0. What this is

Lift a lightweight, walkable 3D model out of the 2D floorplan drawings Arc already
ingests: walls extruded from the plan's vector geometry, openings punched where doors/
windows sit, rooms labeled from extracted text. NOT BIM — a sales/orientation
artifact: buyers walk their plan in the browser and (later) see their selections in
it; supers orient in unfamiliar plans; the plan library gets a "view in 3D" button
that no production-builder tool has.

Why Arc can do this cheaply: the drawings pipeline ALREADY extracts vector segments
into a compact binary co-registered with the calibration system, and the analysis
layer already detects closed loops and "room-sized" loops. Most of a
floorplan-to-massing pipeline exists as exhaust.

## 0.1 Ground truth (verified 2026-07-31)

- **Vector substrate:** `lib/drawings/vector-extract.ts` walks the MuPDF display
  list → `vectors.bin` (format: `"ARCV"` magic, uint16 version=2, uint32 count,
  count × float32 x0,y0,x1,y1 normalized 0..1 y-down image coords, then per-segment
  uint8 flags + uint8 width). `VECTOR_EXTRACT_ALGO = 3`, `MAX_STORED_SEGMENTS =
  200_000`. Stored in R2 at `${drawing_sheet_versions.tiles_base_path}/vectors.bin`
  (uploaded by `drawings-pipeline.ts:1290` only when `vectorAligned`); stats
  side-channel in `drawing_sheet_versions.extracted_metadata.vector_stats`.
- **Analysis exists and is pure/testable:** `lib/drawings/vector-analysis.ts` —
  `Segment {x0,y0,x1,y1,width,filled,dashed}`, `analyzeSegments`,
  `collapseDashChains`, `mergeCollinearChains`, `closedLoopCount`,
  **`roomSizedLoopCount`**, `repeatedShapeGroups`, `CHAIN_ENDPOINT_QUANT = 0.35`.
- **Reader:** `lib/drawings/vector-snap.ts` — `parseVectorsBin(buffer)`,
  `buildVectorIndex(parsed, imageSize)`, `snapPoint(...)`. Client fetch precedent:
  `components/drawings/viewer/use-sheet-vectors.ts:43`.
- **Scale:** real-world units come from `extracted_metadata.calibration`
  (`feetPerImagePx` in `lib/drawings/measure.ts`); the pipeline writes a
  `calibration_proposal`. Markups/vectors share the same normalized space.
- **Text:** `drawing_sheet_versions.page_text` exists (extracted at split time) but
  positioned text runs are NOT stored — vector-extract records path geometry only.
  Room labeling needs positioned text (see WS-3D1.3).
- **Plans ↔ sheets:** plans do NOT own sheets. `house_plan_versions.
  drawing_source_file_id` is the plan PDF; `queuePlanDrawings()`
  (`plan-instantiation.ts:695`) pipelines it into the PROJECT's canonical drawing
  set on release. For plan-level 3D we process the plan version's own file (see
  WS-3D1.1 decision).
- **Viewer:** `lib/viewer/` is a framework-free WebGPU (WebGL2 fallback) 2D tile
  renderer explicitly designed for a second consumer. A 3D walkthrough needs a
  proper 3D scene graph — use Three.js rather than extending the 2D renderer
  (decision, see WS-3D3.1).
- **Buyer portal:** `app/p/[token]` exists with selections; org branding thin.
- **GPU/external compute:** none server-side today; extraction here is
  geometry-processing (CPU, Node) — no GPU runner needed for this plan.

---

## WS-3D1 — Floorplan interpretation (the hard 20%)

### 1. Input selection
Process at the PLAN level (`house_plan_version_id`), not per project — one
interpretation serves every lot instantiation (the production leverage). Pipeline
entry: a new outbox job `interpret_floorplan` with payload
`{ house_plan_version_id, sheet_strategy }`.
- The plan PDF (`drawing_source_file_id`) contains many sheets; floorplan sheets
  must be identified: heuristic v1 = sheets whose `vector_stats.roomSizedLoopCount ≥
  3` AND discipline `A`/title matching `/first|second|floor plan|main level/i`;
  ambiguous → vision-model classification (one image call per candidate sheet, via
  the existing drawings-vision provider plumbing). Where the plan PDF has not been
  through the drawings pipeline as a project set, run the SAME split/vector
  machinery against it under a plan-scoped storage path — reuse
  `drawings-pipeline` stages; do NOT fork a parallel pipeline (extend the existing
  job payloads with an optional `house_plan_version_id` context the way
  `queuePlanDrawings` threads project context).

### 2. Wall graph extraction (`lib/drawings/floorplan-interpret.ts` — pure, heavily tested)
Input: parsed `vectors.bin` segments + calibration (`feetPerImagePx`). Output typed
`FloorplanModel`:
```ts
interface FloorplanModel {
  version: 1
  units: 'feet'
  levels: Level[]           // one per processed sheet
}
interface Level {
  name: string              // 'First Floor'
  sheetVersionId: string
  walls: Wall[]             // centerline polyline, thickness ft, height ft (default 9)
  openings: Opening[]       // door|window|cased, on wall ref, offset, width, (sill/head defaults)
  rooms: Room[]             // polygon, label, area sqft
  confidence: { walls: number; openings: number; rooms: number }
}
```
Algorithm directives (each step already has a head start in `vector-analysis.ts` —
extend that module's helpers, don't duplicate):
- Normalize: `collapseDashChains` + `mergeCollinearChains`; drop segments <
  6" real-world.
- Wall candidates: parallel segment PAIRS at plausible wall thickness (3.5"–12"
  real-world after calibration) → centerline + thickness. Filled thick strokes
  (flags carry `filled`) are wall pours in many plan styles — treat width-in-tenths
  as thickness hint.
- Junction graph: quantize endpoints (`CHAIN_ENDPOINT_QUANT` pattern), snap
  T/L/X junctions, close gaps < 4".
- Openings: gaps in wall runs spanned by door-arc signatures (quarter-circle chords
  — vector-extract samples curves at 8 chords, so arcs appear as 8-segment fans:
  detect fan groups) → doors; paired short perpendicular ticks across a wall gap →
  windows; unclassifiable gap → `cased`.
- Rooms: face-walk the wall graph for closed cells (the `closedLoopCount` machinery
  generalized to the wall graph); area from calibration.
- Every output element carries per-element confidence; the model carries aggregate
  confidence. LOW CONFIDENCE IS A VALID RESULT — the UI (WS-3D2) exists to fix it.

### 3. Room labels
Positioned text is required and not currently stored. Extend the pipeline's page
processing to also emit `text-runs.json` (array of `{ text, x, y, w, h }` normalized
coords — MuPDF structured-text API provides this; the pipeline already extracts
plain text) to the same `tiles_base_path`, gated behind the same `vectorAligned`
condition. Then: label = text run whose bbox center falls inside a room polygon,
filtered by a room-name lexicon (`BEDROOM|BATH|KITCHEN|GARAGE|...` + `/\d+'-\d+"/`
dimension rejection). Store the lexicon in the interpret module, exported for tests.

### 4. Persistence (one migration, then STOP)
`floorplan_models` — org_id, house_plan_version_id (unique with algo_version),
status (`processing | draft | published | failed`), model jsonb (the FloorplanModel),
algo_version int, confidence numeric, error text, created/updated. Org-scoped RLS
(`plans` domain permissions — reuse the house-plans RBAC keys); registration
checklist applies (search: skip — models aren't searchable entities; events:
`floorplan.interpreted`, `floorplan.published`).

## WS-3D2 — Review & correction UI (accuracy comes from humans, cheaply)

On `/plans/[id]` (plan workbench): a "3D model" panel per released version:
- 2D REVIEW MODE first (this is where correction is efficient): the floorplan sheet
  rendered in the existing tile viewer with the interpreted wall graph as an SVG
  overlay (reuse the `svg-overlay.tsx` pattern; walls tinted by confidence).
  Corrections: delete false wall, draw missing wall (two clicks, snaps via
  `vector-snap`), toggle opening type, edit room label, set ceiling height per
  level. Every correction updates the model jsonb (draft status) — corrections are
  MODEL edits, never drawing markups (different domain; do not write
  `drawing_markups`).
- Publish action → `status: 'published'` (permission: plan write). Republishing a
  plan version's drawings or re-running interpretation on a superseded model
  requires explicit confirm ("re-interpret discards 14 corrections?").
- Batch entry: plan library list shows model status chips; "Interpret all active
  plans" bulk action enqueues jobs (dedupe on `house_plan_version_id`).

## WS-3D3 — The walkable viewer

1. **Renderer decision:** Three.js, dynamically imported, in a new
   `components/plans/plan-3d-viewer.tsx` client component. Do NOT extend
   `lib/viewer` (it's a 2D tile compositor; a walkthrough needs cameras, lighting,
   collision — fighting that into the tile renderer is wasted work). Bundle
   discipline: dynamic import so Three never enters app-shell chunks.
2. **Geometry construction (client-side from the model jsonb — no server bake):**
   walls = extruded centerline rects with thickness/height, boolean-punched openings
   (simple prism subtraction — use three-bvh-csg or manual wall-run splitting at
   openings, which is simpler: split each wall run into solid segments around
   opening spans; no CSG library needed — DO THIS, not CSG); floor slab per level
   from room-polygon union; flat ceiling optional toggle. Neutral matte materials +
   a soft hemisphere light + grid — deliberately model-like, not fake-photoreal
   (manage expectations; selections texturing is a later phase).
3. **Navigation:** orbit mode (default, touch-friendly) + walk mode (WASD/joystick,
   eye height 5'6", simple capsule-vs-wall collision, tap-to-teleport on mobile).
   Level switcher for two-story plans. Room labels as billboards, toggleable.
4. **Surfaces:** plan workbench panel (internal); community offering page
   (`/communities/[id]/offering`) "3D" button per plan row where a published model
   exists; buyer portal (`app/p/[token]`) plan section for production buyers —
   read-only viewer, no correction affordances, org logo corner. If the
   community-websites gameplan ships, the public site embeds the same viewer
   (model jsonb is not sensitive — it's geometry; confirm no pricing rides in it).
5. Performance budget: model construction < 500ms for a 4,000 sqft two-story on a
   mid phone; 60fps orbit on desktop, 30fps floor on mobile; total added JS ≤ 700KB
   gzipped (Three + viewer), loaded only on demand.

## WS-3D4 — Later phases (design notes, do not build now)
- **Selections in the model:** design-studio option → material/texture mapping per
  room surface (flooring first — it's the highest-value visual and the easiest
  mapping). Depends on option catalog gaining a `surface_kind` notion. STOP for
  product design.
- Elevation-aware exteriors (extrude footprint + roof massing from elevation
  sheets) — much harder; not before interior walkthroughs prove engagement.
- GLB export (one function on the built geometry) for marketing use.
- Splat fusion: as-built capture scenes (tech-frontier WS-F5) positioned inside the
  plan model — the "x-ray house" endgame.

## Acceptance
- Interpretation: golden-fixture suite of ≥6 real plan sheets (varied drafting
  styles) with hand-labeled wall graphs; wall recall ≥ 85% / precision ≥ 90% before
  the correction UI is considered "assist" rather than "authoring"; fixtures live
  with the module tests (pure functions — no DB needed).
- Round-trip: interpret → correct 3 walls → publish → viewer renders corrections;
  re-interpret prompts before discarding.
- Viewer budgets met (measure, don't assert).
- `pnpm lint && npx tsc --noEmit`; new pure modules ≥ 90% branch coverage
  (`vector-analysis.ts` sets the precedent of testable geometry code).

## Sequencing
WS-3D1 (interpret, FL-style single-story fixtures first) → WS-3D2 (review UI) →
WS-3D3 (viewer, internal then buyer) → WS-3D4 gated.

## Non-goals
- Not BIM, not IFC, no structural/MEP meaning, no quantity takeoff from the 3D model
  (takeoff already has its own vector path), no photoreal rendering, no VR.

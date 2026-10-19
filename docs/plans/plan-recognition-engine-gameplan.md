# Plan recognition engine — gameplan

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** Awaiting execution. Written 2026-10-06. Owner: Agustin (solo).
**Replaces:** `plans/takeoff-reliability-gameplan.md` (deleted in the same
change). The evaluation protocol it relied on stays in
[`docs/takeoff-evaluation.md`](../takeoff-evaluation.md).
**Audience:** an LLM executor working with the owner. Read the whole thing
before the first cut; §6 is the list of what is deleted and what is kept.

## 1. Decision

The heuristic recognition engine on the `books-readiness-sync` branch
(`lib/drawings` engine version 61, `FLOORPLAN_ALGO_VERSION` 42) is not merged
and is replaced. The audit that led here, 2026-10-06:

- ~16k lines of hand-written computer vision in TypeScript, 7,255 numeric
  literals across `lib/drawings`, tuned sheet by sheet over 61 versions on
  ~15 development plans.
- One honestly scored sheet (Gundersen A1.2): 11 of 16 rooms found, 1 exact,
  **0 within 2%** of area.
- No human-labelled ground truth. The only wall precision number (0.95) was
  scored on one bathroom crop against a reference GPT-6.1 Sol produced.
- Two planar-subdivision kernels, six door detectors, three window-host
  recoveries, five cache layers; takeoff and 3D keep separate copies of the
  building.
- The vision model was demoted to labelling path IDs the heuristics had
  already found, so the one component that generalises across drafting
  conventions could not propose geometry.

The failure is the approach, not the tuning: rules written against the quirks
of fifteen plans cannot converge without a labelled corpus, and with a corpus
a learned or model-proposed stage beats them. We build our own replacement;
licensing a vendor engine is out of scope.

## 2. What the engine must produce

One versioned **building record** per sheet version. Takeoff areas and the 3D
model are both projections of it; there is never a second copy.

```
Building {
  engineVersion, inputHash, scale { feetPerImagePx, source, confidence }
  region   { x, y, w, h }                     // plan view within the sheet, normalized 0..1
  walls[]  { id, a, b, thicknessFt, confidence, evidence }
  openings[] { id, wallId, offsetFt, widthFt, kind: door|window|cased, confidence }
  rooms[]  { id, ring, holes[], label, labelPoint, confidence }   // derived, see §3
  issues[] { code, elementId?, message }      // every silent drop is an issue
}
```

Coordinates are normalized sheet coordinates plus feet, exactly as
`FloorplanModel` already expects (`lib/drawings/floorplan-model.ts`), so the
3D projection is `buildingToFloorplan` with the recognizer's issue vocabulary
removed. The takeoff projection writes proposals into the existing fill-rooms
review and, on acceptance, ordinary `drawing_markups` rows through
`accept_takeoff_area_snapshot` with the quantity computed server-side. That
contract (normalized points, `type` area/polyline/count, `style.deduction`,
`style.parent_area_id`, `style.generated` as an opaque tag) is the whole
interface; nothing downstream reads engine provenance.

The schema lives in two places that move together: a Pydantic model in the
service and `lib/validation/building.ts` (Zod) in the app, with one shared
JSON Schema fixture under `tests/fixtures/building/` that both validate.

## 3. Three design rules

1. **Raster-first, one path.** Every sheet, vector or scan, renders to a raster
   normalized by *scale*, not paper DPI: 16 px per foot, so a 60 × 40 ft floor
   is under 1,000 px wide and a 4½" wall is always ~6 px. A residential plan is
   one image; tiling is for commercial sheets only. PDF vectors and the text
   layer are side evidence for snapping and labels, never a second pipeline.
   The July vector spike (`docs/takeoff-vector-spike.md`) settled this: 14 of
   20 production sheets were "C", and the floor plans specifically were noisy.
2. **Rooms are derived, never detected.** The proposer returns walls, openings
   and label points. Rooms come from polygonising the wall graph and assigning
   each label to the face that contains it. A closet with a wall and a door is
   separate by construction; a label with no face and a face with no label are
   issues, never silent. This removes the merge/split/swallowed-closet class at
   the source.
3. **The proposer is an interface.** `propose(image, scale) → candidates` is
   filled by a frontier vision model now and by a fine-tuned segmentation model
   when the traced corpus is large enough (§7). Everything after it is
   deterministic geometry and does not change when the proposer does.

## 4. Pipeline

| Stage | Output | How |
|---|---|---|
| 1 Triage | plan region, scale | Vision model picks the plan view and excludes title block, schedules, details. Scale from the printed scale text, checked against one dimension string (port `lib/drawings/scale.ts` parsing). Refuse with an issue when they disagree. |
| 2 Propose | candidate walls, openings, label points | Vision model, structured output, temperature 0, pixel coordinates, cached by image hash + prompt version. Tile with 15% overlap above ~1,500 px and dedupe on stitch. |
| 3 Refine | snapped walls | Edge map from rasterised vector segments plus raster edges (Canny / thinning). Snap each wall to its paired parallel edges, orthogonalise to the dominant axes with an oblique allowance, merge collinear runs, snap-round endpoints to a ½" grid. |
| 4 Resolve | wall graph, rooms, hosted openings | `shapely.polygonize` over the wall graph. One label per face. An opening must lie on a wall. Unlabelled enclosed faces and orphan labels become issues. |
| 5 Score | per-element confidence | Agreement between the proposal and the edge evidence. Low agreement is a review item, surfaced in the UI. |
| 6 Project | takeoff proposals, 3D level | Rooms with deductions into the fill-rooms review; walls/openings/rooms into the floorplan model document. |

Stages 3–5 are pure functions over the `Building` types with golden tests on
synthetic and traced inputs. All thresholds live in one `config.py` of named
parameters; a change to any of them is an engine version bump.

## 5. Compute

A FastAPI service, `services/plan-recognition/`, deployed on Modal (CPU now,
GPU on demand for §7). Dependencies: PyMuPDF, OpenCV, shapely 2, scikit-image,
numpy, pydantic, the provider SDK behind the existing `drawings_vision`
routing (the model and key come from the org's AI config, passed per request;
the service never holds a default key).

- The app calls it from the existing outbox job path (`interpret_floorplan`
  and the takeoff detection action move onto the same job), idempotent on
  `(sheet_version_id, engine_version, input_hash)`.
- The result is written to `sheet_building_records` (**not yet applied in
  production**; its migration is kept and applied with this work) and read by
  both projections. The storage-side caches of the old engine (`architecture/`,
  `auto-areas/`, `source-facts-*`) are not recreated.
- Vercel orchestrates and never runs geometry. The 45 s / 90 s budgets in the
  old code were serverless limits shaping the algorithm; the service has a
  work-unit budget so a rerun on the same input is byte-identical.
- One endpoint, one contract, one `ENGINE_VERSION`. The previous Cloud Run
  drawings worker was deleted as orphaned cruft; this one is owned by this plan
  and documented in `docs/reference/plan-recognition.md` when it ships.

## 6. The cut — what is dismissed, deleted and kept

Branch state on 2026-10-06: `books-readiness-sync` is 63 commits ahead of
`main`. Production (`main`) has **22** files in `lib/drawings`; the branch has
**112**. The recognition engine never reached production, so most of this
section is "do not merge", not "remove from prod".

### 6.1 Dismissed from the branch (never merged)

Delete from the branch in one commit, after the snapshot tag below.

- **`lib/drawings` engine families** (90 files): `area-*` (except
  `area-coverage.ts`, which is the takeoff coverage model), `raster-*`,
  `recognition-*`, `architectural-reinspection.ts`, `building-reconstruction.ts`,
  `building-window-hosts.ts`, `building-window-coverage.ts`,
  `reconstruction-review-groups.ts`, `vector-wall-network.ts`,
  `vector-wall-material.ts`, `vector-leaf-doors.ts`, `vector-source-visibility.ts`,
  `wall-body-reconciliation.ts`, `wall-hypothesis-semantics.ts`,
  `wall-span-recognition-plan.ts`, `window-jamb-hosts.ts`,
  `window-schedule-matching.ts`, `window-schedules.ts`, `source-leaf-doors.ts`,
  `segment-index.ts`, `room-names.ts`, `sheet-building-record.ts`,
  `pdf-raster-sampling.ts`, `pdf-region-raster.ts`, `opening-dimensions.ts`.
  `area-takeoff.ts` goes too: despite its name it *is* the engine
  (`detectAreas`, `AREA_ENGINE_VERSION`).
- **Services:** `architectural-recognition.ts`, `architectural-raster.ts`,
  `architectural-evidence.ts`, `area-takeoff.ts` (keep ~80 lines of
  `acceptTakeoffAreas` as the projection adapter), `area-evidence-extract.ts`,
  `area-revision.ts`, `sheet-building-records.ts` (rewritten as the thin reader
  for the new record), `original-sheet-raster.ts`, `local-raster-text.ts`,
  `ocr/raster-text-process.cjs`, and the vision fallback in `takeoff-assist.ts`
  (keep `acceptSymbolMatches`). In `floorplan-models.ts`, `runFloorplanInterpretation`
  becomes a call to the service plus `buildingToFloorplan`.
- **UI:** `components/drawings/viewer/use-area-takeoff.ts` and `area-overlay.tsx`
  are rewritten against the new proposal shape (the fill-rooms interaction stays;
  the detection plumbing goes); `workspace/scan-overlay.tsx` stays only if it is
  driven by the job's real progress.
- **Tests:** the 54 recognition-family suites (`raster-*`, `recognition-*`,
  `architectural-*`, `area-*`, `building-*`, `vector-wall-*`, `vector-leaf-*`,
  `wall-*`, `window-*`, `classified-*`, `localized-*`, `native-assembly-*`,
  `sheet-building-record`, `reconstruction-*`, `pdf-raster-*`, `pdf-region-*`,
  `original-sheet-raster`, `local-raster-text`, `vision-windows`), and the
  `tests/fixtures/area-*` Swiss and synthetic fixtures. Keep
  `takeoff-rollup`, `takeoff-measure`, `takeoff-scale`, `takeoff-snap`,
  `takeoff-symbol-match`, `takeoff-vector-merge`, `takeoff-reanchor`,
  `takeoff`, `takeoff-templates`, `drawing-*`, `drawings-*`, `floorplan-*`,
  `model-*`, `recognition-metrics`, `recognition-reference`.
- **Scripts:** `check-burke-area-takeoff.js`, `check-area-pdf.js`,
  `replay-area-takeoff.js`, `reinspect-area-replay.js`,
  `benchmark-building-corpus.mjs`, `area-estimator-trial.js`,
  `import-swiss-area-sample.py`, `import-area-pdf.js`, `inventory-area-pdfs.mjs`,
  `test-area-ui.mjs`, `test-area-reference-ui.mjs`,
  `test-area-acceptance-*.mjs`, `scripts/recognition-reference-adapter.mjs`,
  `score-recognition-scopes.mjs`. Keep the tracing and scoring tools:
  `create-area-review.mjs` + `area-review/`, `check-area-reference.js`,
  `score-area-reference.mjs`, `dev-scoreboard.mjs`, `holdout-guard.js`,
  `benchmark-area-takeoff.js`, `recognition-metrics.mjs`,
  `prepare-recognition-reference.mjs`, `area-release-policy.js`.
- **package.json:** `test:area-takeoff`, `test:recognition-evaluation`,
  `test:area-ui`; rebuild `test:takeoff` and `test:floorplan` from the kept
  suites. Remove `tesseract.js`, `tesseract.js-core` and `@tesseract.js-data/eng`
  once `local-raster-text.ts` is gone (OCR moves to the service).
- **Migrations, unapplied:** `20261004121500_sheet_building_records.sql` is
  **kept** (the new record lands there). `20261004124500_option_model_changes.sql`
  (Design Studio options priced from the 3D model) is dismissed until the model
  is good enough to price from; it is a feature on top of an unproven model.
- **Repository hygiene:** `tmp/ldh-sandbox/` (34 tracked files, tiles and
  walkthrough PDFs) is removed from the branch; `tmp/` is added to `.gitignore`
  (only `/tmp/takeoff-corpus/` is ignored today, and nine customer drawing
  sets sit untracked in `tmp/`). `public/models/furniture/*` (11 MB of GLTF)
  moves to tile storage or is dropped with the furniture catalog until the
  model earns decoration.
- **Docs:** `docs/automatic-area-takeoff.md` is deleted with the engine it
  describes; `docs/reference/drawings-workspace.md` loses its detection and
  scan paragraphs; `docs/takeoff-evaluation.md` keeps the split, conventions,
  tracing and scoring sections and drops the frozen release protocol §5, which
  is restated as Bar A / Bar B below.

### 6.2 Deleted from production (`main`)

- `lib/drawings/floorplan-interpret.ts`, `floorplan-vision.ts`,
  `lib/services/floorplan-vision-assist.ts`, `vision-windows.ts` and their
  tests (`floorplan-golden`, `floorplan-interpret`, `floorplan-vision`): the
  previous 3D interpreter. The branch already deletes them; the cut merges that.
- `components/plans/plan-3d-viewer.tsx` and `plan-ladder.tsx`, replaced on the
  branch by `components/plans/model-viewer/*`.
- No table is dropped. `floorplan_models`, `floorplan_model_revisions` and
  the `accept_takeoff_area_snapshot` RPC are in production and stay.

### 6.3 Kept (and must keep working through the cut)

- **Takeoff ledger:** `lib/drawings/measure.ts`, `condition-rollup.ts`,
  `condition-templates.ts`, `measurement-context.ts`, `takeoff-palette.ts`,
  `area-coverage.ts`; `lib/services/takeoff*.ts`, `drawing-measurements.ts`,
  `drawing-markups.ts`; tables `takeoff_*`, `drawing_markups`; the manual
  Length / Area / Count tools, item picker, scale chip, ledger and estimate
  handoff.
- **Ingestion:** `drawings-pipeline.ts` and the Oct 1–3 hardening (upload
  operations, artifacts, leases, cleanup, receipts, register, split manifest
  and registration, publication transaction, copy attempt: 12 migrations,
  **none applied in production yet**). They are orthogonal to recognition and
  need their own review before `db push`; they are not part of this plan's
  gate.
- **Vector side evidence:** `vector-extract.ts`, `vector-snap.ts`,
  `vector-analysis.ts`, `symbol-match.ts`, `symbol-verify.ts`, `text-runs.ts`,
  `scale.ts`.
- **3D layer:** `floorplan-model.ts` (minus `recomputeRooms`'s dependence on
  the old `detectAreas` and the window-schedule association in the edit
  reducer), `building-floorplan.ts` as the projection, `architectural-model.ts`,
  `architectural-polygon.ts`, `architectural-validation.ts`, `model-diff.ts`,
  `model-options.ts`, `model-takeoff.ts`, `lib/plans/floorplan-geometry.ts`,
  `components/plans/model-viewer/*`, `floorplan-review.tsx`,
  `model-inspector.tsx`, `model-preparation.tsx`, `workspace/model-pane.tsx`
  and the `use-model-*` hooks. Known limits to fix after recognition holds:
  no wall joins at corners and tees, constant level height, bounding-box roof,
  no cross-sheet registration, confidence stored as 0 on a fresh interpretation
  (`building-floorplan.ts` sets `{0,0,0}` and nothing recomputes it).
- **Infra that only looked like engine scaffolding:** `processing-lanes.ts`,
  `parallel-work.ts`, `lifecycle-metrics.ts`, `change-detection.ts`,
  `change-impact.ts`, `set-coherence.ts`, `callout-links.ts`,
  `region-snapshot.ts`, `sheet-metadata.ts`, `metadata-update.ts`,
  `page-artifact-key.ts`, `publish-validation.ts`, `pdf-preview.ts`,
  `number-evidence.ts`, `tile-urls.ts`, `tiles-cookie-client.ts`,
  `design-palettes.ts`, `furniture-*.ts`, `floorplan-sheets.ts`.

### 6.4 Before the cut

- `git tag recognition-engine-61 <HEAD>` so nothing is unrecoverable.
- Verify the revision-carry bug the takeoff audit surfaced: page processing
  calls `inheritPublishedMarkupsToRevision` (`lib/services/drawing-markups.ts`),
  which copies measurements without `condition_id`, `quantity` or `uom` and
  sets `carried_from_markup_id`; the later reanchor job then treats them as
  already carried and skips them. Likely result: measurements silently lose
  their condition on every revision upload. No test covers it. Unrelated to
  recognition; fix it first because the ledger is what we keep.
- Decide the fate of human corrections in existing `floorplan_models.model`
  rows. Default: not migrated. The schema stays, there are few, and a new
  interpretation replaces them.

## 7. Ground truth

Tracing is the critical path, not code. Conventions, tools and the holdout
registry in `docs/takeoff-evaluation.md` stay as they are. Extend
`scripts/create-area-review.mjs` to walls and openings in week 1; rooms-only
traces are acceptable for the first two weeks because rooms are the shipping
metric.

| By | Development (traced) | Holdout (traced, unscored) |
|---|---|---|
| Week 2 | 8 sheets | 0 |
| Week 5 | 20 sheets, 4 drafting sources | 10 |
| Week 12 | 60 sheets | 15 |
| Segmentation fine-tune | 150+ | — |

Development projects already burned (Burke, Tornincaso, Gundersen, Roth,
Growney, Galleon, Ginns, Matustik, Shad Ct, Sheepshead, the 15-set corpus)
stay development forever. The seven registered holdouts stay locked until
the week-6 gate.

## 8. Targets

| | **Bar A — ship as review-assist** | **Bar B — release qualification** |
|---|---|---|
| Scope | Vector PDFs, residential + light commercial | Adds scans, multi-level |
| Rooms found as own area (IoU ≥ 0.5) | ≥ 90% | ≥ 98% |
| Boundary (IoU ≥ 0.95) | ≥ 75% | ≥ 95% |
| Area within 2% | ≥ 80% of matched rooms | ≥ 95% |
| Sheet total SF error | ≤ 2% median, ≤ 5% worst | ≤ 1% / 2% |
| Walls (span P/R, centerline ≤ 1", thickness ≤ 1") | ≥ 90% | ≥ 98% |
| Openings (one-to-one, correct host and kind) | ≥ 85% | ≥ 98% |
| Silent misses | 0 — every unproposed labelled room is flagged | 0 |
| Correction time | Review + fix ≤ 50% of tracing manually | ≤ 10 min per floor |
| Budget | P95 ≤ 120 s per floor, ≤ $1.00 per view | ≤ $5 per project |
| Evidence | 10 holdout projects | 30 projects, 5 conventions, 10 scans |

## 9. Schedule (solo)

- **Week 1 — Cut and contract.** Tag, cut (§6), fix the revision-carry bug,
  `Building` schema in Pydantic + Zod + shared fixture, service skeleton on
  Modal with rendering and scale stages, scorer running on trace files from
  the service's output. Trace 4 sheets.
- **Weeks 2–3 — Proposer, refine, resolve.** Vision-model proposer, edge
  snapping, polygonize, label assignment. First dev scoreboard. Weekly loop
  from here: trace Monday, score Tuesday, fix the top mechanism by SF error,
  re-score Friday, keep or revert.
- **Week 4 — Review surfaces.** Confidence and issues; takeoff projection into
  the fill-rooms review; every unproposed labelled room visibly flagged.
- **Week 5 — 3D and scans.** Projection into the floorplan model document.
  Scans go through the same path with no vector edges; this is the test of
  rule 1.
- **Week 6 — Gate.** Score the 10 holdouts once. Bar A passes → ship
  review-assist for vector residential sheets and publish the scoreboard in
  `docs/reference/plan-recognition.md`. Fails → retire the failing holdouts to
  development, replace them, loop.
- **Weeks 7+ — Toward Bar B.** Keep tracing. At 150 traced sheets, fine-tune
  a segmentation model (U-Net/HRNet class, or a transformer room/wall model)
  behind the proposer interface and score it against the vision model on the
  same traces; keep whichever wins per sheet class. Then multi-level
  registration and wall joins in the 3D layer.

## 10. Rules of the game

1. Holdouts are scored only at gates. A holdout that drives a fix is retired
   to development and replaced.
2. No per-sheet fixes. A change must name a mechanism seen on ≥ 2 development
   projects.
3. Every change is scored on the whole development set and kept only if the
   scoreboard improves and no sheet loses more than one room.
4. Score by square feet of error, not counts.
5. Silent omission is a bug. Anything dropped by a limit becomes an issue.
6. One engine version bump per kept change, logged with before/after numbers.
7. All thresholds in one config file. A magic number in a function body is a
   review rejection.
8. The service has no second path. If vector and scan ever diverge above the
   edge map, rule 1 has been broken.

## 11. Scoreboard

Columns follow `pnpm takeoff:scoreboard`. The last two rows of the old engine
are kept as the baseline to beat.

| Date | Engine | Dev sheets | Found | Exact (≥0.95) | Within 2% | SF err | Note |
|---|---|---|---|---|---|---|---|
| 2026-10-03 | 61 (old) | 1 (Gundersen) | 45% | 5% | 0% | — | Baseline, ungrouped open plan |
| 2026-10-04 | 61 (old) | 1 (Gundersen) | 69% | 9% | 0% | 12% | Open plan grouped per convention |

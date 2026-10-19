# Takeoff & recognition evaluation

> Reference. How Arc's area takeoff and 3D recognition are measured: the data
> split, how references are traced, the scoring tools and the frozen release
> protocol. The work plan that uses this is
> [`plans/plan-recognition-engine-gameplan.md`](plans/plan-recognition-engine-gameplan.md).

Accuracy is measured against traced references, never inferred from valid
polygons, label coverage, proposal counts or test passes.

## 1. Data split and leakage

The exposure registry is `tmp/takeoff-corpus/qualification-exposure-registry-v1.json`
(git-ignored; it holds file names and hashes, not drawings). Holdout PDFs live
outside the repo in `~/Desktop/arc-holdout/`.

- **A project is the unit.** Every floor, revision, crop, rotation, layer-strip
  or rasterization inherits its parent project's split. Hash alone is not
  identity; two files of one building are one project.
- **`development`** — anything the engine has been run on, tuned against, or
  whose overlay anyone has looked at. Burke, Tornincaso and the original 15
  corpus projects are development forever.
- **`holdout`** — registered *before* anyone renders it in Arc, runs the engine
  on it, or opens it in the app. Scored only at gates in the gameplan.
- **`withdrawn`** — registered, then removed before any use.
- A holdout that drives an engine change is retired to development and replaced.
- Every script that runs the engine on a PDF or reference calls
  `scripts/holdout-guard.js` and refuses a registered holdout. `--gate` overrides
  it for gate scoring and records the run in the project's `gateRuns`.
  Selecting only easy or successful sheets invalidates an evaluation.

## 2. Tracing a reference

```sh
bun scripts/create-area-review.mjs SOURCE.pdf PAGE FEET_PER_PDF_POINT PROJECT_ID OUT.html
```

`PAGE` is 1-based. `FEET_PER_PDF_POINT` = feet per paper inch ÷ 72:

| Printed scale | Value |
|---|---|
| 1/8" = 1'-0" | `0.1111111` |
| 3/16" = 1'-0" | `0.0740741` |
| 1/4" = 1'-0" | `0.0555556` |
| 3/8" = 1'-0" | `0.0370370` |
| 1/2" = 1'-0" | `0.0277778` |

Valid only for a PDF at true paper size. Before tracing, measure one long printed
dimension; if it disagrees, derive the scale from that dimension instead. The
page is offline, embeds the source drawing, and must stay private.

The generator always writes `split: "development"`; set `holdout` by hand for a
registered holdout. Then:

```sh
node scripts/check-area-reference.js trace.json          # structure only
node scripts/check-area-reference.js trace.json --reviewer "Name" \
  --source-and-scope-checked --output checked.json        # after a second person checks it
```

The review hash binds source page, calibration, category, convention and
geometry; changing any of them invalidates the attestation. The annotator cannot
attest their own trace.

## 3. Tracing conventions

Decide once; apply on every sheet; note exceptions in the scope note.

- **Open plans:** split only where something is *drawn* — a wall, door, cased
  opening, threshold, or a material-change line. No drawn line → one area,
  named for everything in it ("Living / Kitchen / Dining").
- **Doorways:** close the room straight across the door opening at the wall face.
- **Boundary:** finish face of the wall (the inside face), not the centerline.
- **Closets, pantries, WICs:** separate areas whenever walled with a door.
- **Fixed fixtures** (tubs, showers, cabinets, islands): included in the room's
  area. Columns and voids are deductions (holes).
- **Exterior** (lanai, porch, balcony, garage): traced, labelled as exterior.
- **Completeness:** trace everything in the plan view, or name exactly what is
  excluded and why in the scope note. An untraced area makes engine proposals
  there unscoreable.
- Check rooms against printed dimensions as you go; > 2% off deserves a second look.

## 4. Scoring tools

| Tool | What it does |
|---|---|
| `pnpm takeoff:score REFERENCE.json [--out r.json]` | Runs the engine on the reference's own embedded input and scores it exactly: found (IoU ≥ 0.5), exact (≥ 0.95), within 2%, merged/missed/split, SF-weighted error. A `REFERENCE.scoring.json` sidecar `{"groups": [["Living Room", "Kitchen"]]}` scores rooms traced separately as one zone. |
| `pnpm takeoff:scoreboard [DIR]` | Scores every development reference in `DIR` (default `~/Desktop/arc-holdout/traces`), appends `tmp/takeoff-corpus/dev-scoreboard-history.jsonl`, exits 1 if a sheet loses more than one found room. |
| `scripts/check-area-pdf.js PDF PAGE SCALE out.json` | Runs the current engine (vector only, no model calls) on one page; writes proposals + a `.png` overlay. Development diagnostic. |
| `scripts/benchmark-area-takeoff.js DIR [--release] [--profile P] [--trial T] [--predictions D]` | Corpus scoring: raster IoU ≥ 0.5 matching, exact polygon area, boundary distances; validates split leakage and attestations; `--release` applies the area release gate. |
| `scripts/score-recognition-scopes.mjs` + `scripts/recognition-metrics.mjs` | Wall/opening/room protocol scoring against frozen references (§5). |
| `scripts/prepare-recognition-reference.mjs` | Source-only reference packets for wall/opening/room tracing. |
| `scripts/replay-area-takeoff.js` | Re-runs a downloaded in-app detection replay offline. |

## 5. Release protocol (version 1.0.0, frozen)

**Scope:** English-language residential plans, feet/inches, straight (including
oblique) walls, layered/unlayered vector PDFs and legible native scans ≥ 200 DPI,
with verifiable scale. Curved walls, unreadable scans and unresolved mixed
scale/level registration must be flagged unsupported before a model is offered.

| Gate | Requirement |
|---|---|
| Corpus | ≥ 30 unseen holdout projects, ≥ 5 drawing conventions, ≥ 10 native scans. Derivatives never add to counts. |
| Walls | Physical span precision and recall ≥ 98%; duplicate bodies reported separately. |
| Openings | Precision and recall ≥ 98%, one-to-one, correct host and type. |
| Rooms | ≥ 95% with IoU ≥ 0.95 **and** correct adjacency. |
| Dimensions | P95 ≤ 2" for spans ≤ 20 ft; ≤ 1% above. |
| Structural readiness | Zero unresolved critical defects in a "ready" model. |
| Human usability | ≥ 95% of plans usable within 10 min of real human correction. |
| Budget | P95 ≤ 180 s per floor view, ≤ $1.50/view, ≤ $5/project. |

**Matching tolerances:** walls — centerline ≤ 1", orientation ≤ 1°, thickness
≤ 1", scored as union of matched intervals so segmentation is not penalised.
Openings — endpoints ≤ 2" (either order), orientation ≤ 2°, same type, on an
already-matched host; maximum-cardinality then minimum-error one-to-one match.
Rooms — exact polygon intersection with holes, one-to-one IoU, adjacency after
ID mapping. Missing calibration makes physical scores unavailable, not zero.
No best-fit alignment or rescaling of predictions to truth.

**Reporting:** per category and per project, with project-cluster bootstrap
intervals for geometric metrics and Wilson intervals for plan-level fractions.
Failed, timed-out and abstained cases stay in denominators. Any scope or
threshold change is a new protocol version with an explicit report.

**Estimator trial** (area takeoff): different people do manual and assisted
takeoff of the same holdout sheets, roles swapped across sheets, a third person
checks scope. Timed end to end including review and correction. Median
assisted/manual ≤ 0.80 and p95 ≤ 1.25 per source category. Trial JSON format is
validated by `benchmark-area-takeoff.js --trial`.

## 6. Failure taxonomy

Classify each failure by mechanism, not by sheet: view/scope isolation; evidence
loss/clipping; scale/registration; semantic confusion (furniture, notes, door
arcs as walls); wall assembly; opening detection/host; room topology
(merge/split/swallow); floor/void/finish scope; vertical information; job
completion; correction UX. Rank by square feet of error and number of distinct
projects affected.

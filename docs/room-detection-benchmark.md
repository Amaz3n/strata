# Room detection benchmark

Status: offline benchmark infrastructure, not a validated detector or a shipped takeoff feature.

## Run

```sh
node scripts/benchmark-rooms.cjs tests/fixtures/room-benchmark/synthetic-two-rooms.json /tmp/arc-room-benchmark
open /tmp/arc-room-benchmark/review.html
node --test tests/room-benchmark.test.js
```

The runner writes `report.json` and a static `review.html` showing source vectors, reference interior boundaries (green), and predictions (magenta). It makes no network requests or database changes. The existing interpreter is run unchanged, including its centerline boundaries; do not treat that output as flooring takeoff.

## What is established so far

The two-room synthetic fixture detects both rooms but overstates each room's interior area by approximately 9.84%. This demonstrates a measurement-basis failure even with perfect room precision and recall. It does not establish accuracy on customer drawings, scans, or complex plans. Follow-up screening ran two specialist models locally on the selected real development sheet; see `scripts/room-model/README.md`. Neither produced usable enclosed regions in that screen. No external provider has been evaluated, and no independently labeled real customer fixtures have been committed.

## Reference data

Use the committed synthetic JSON as the schema example. Required metadata: `version: 1`, `id`, `project`, `kind` (`real` or `synthetic`), `split` (`development` or `holdout`), `units: "sheet-feet"`, and `boundary: "interior-face"`.

`input` accepts the existing interpreter's image dimensions, feet per image pixel, normalized vector segments, optional attribute flags, and optional positioned text runs. Use the exact same sheet version, raster transform, and confirmed scale for every detector. Mark a scan explicitly by providing empty segments; the current geometry baseline will return no rooms.

`truth` is an array of `{id, label?, polygon}`. Each polygon is a simple ring of `[x,y]` coordinates in feet from the SHEET origin, not the recentered model origin. Do not repeat the first vertex. Trace reference polygons independently of predictions. Confirm scale using printed dimensions; avoid using an unverified detected scale for both truth and predictions, which hides scale errors. Reference labeling should be reviewed before a holdout run.

Truth must exhaustively cover the selected plan under a recorded inclusion policy. Record exclusions and decisions in a fixture `notes` field: closets, stairs, patios, open-plan divisions, existing/proposed work, and doorway thresholds. The initial scorer rejects holes rather than silently filling voids. Cases requiring holes are outside the initial pilot and must remain visible in the dataset inventory. This limitation must be resolved before claiming broad takeoff coverage.

For alternate engines, append `candidates: [{name, rooms, inferenceMs?, timing?}]`. `rooms` uses the same schema and sheet-feet coordinates as truth. Candidates can come from a segmentation model, an external service, or another local algorithm; the runner does not call those engines. Do not mix coordinate origins or resize transforms. A segmentation model should produce per-room polygons, not one undifferentiated foreground mask.

Keep customer source drawings, fixtures, predictions and overlays outside the repository, e.g. under `/tmp/arc-room-benchmark-data`. Do not commit them as synthetic examples. Obtain the selected project/sheets before collecting data. Do not upload customer plans to a new third-party detector as an implicit part of local benchmarking.

## Metrics and limitations

- Exact polygon intersection-over-union via triangulation and convex triangle clipping. No raster grid approximation.
- Maximum-cardinality one-to-one room matching at IoU >= 0.5, with descending-IoU traversal preference. This does not optimize total assignment IoU; inspect ambiguous splits/merges in the overlay.
- Room precision, recall, missed rooms and extra predictions. Empty denominators are null, not invented perfect scores.
- Signed area error for every matched room, using polygon area rather than the interpreter's rounded area field.
- Symmetric boundary-distance 95th percentile in feet, sampled along both boundaries at intervals of at most 0.1 ft. This is not a maximum-distance guarantee.
- Optional measured `timing: {manualSeconds, assistedSeconds}` for each imported candidate. Assisted time must include inference, inspection, all edits, and acceptance. Missing timings remain null. No correction-time estimate is manufactured from polygon accuracy.

The 0.5 matching threshold establishes correspondence, not acceptability. Inspect area and boundary errors separately. Metrics describe geometric rooms; they do not validate finish assignments, deductions, waste, ceiling height, or pricing. The review HTML visualizes vector linework only; it is not a raster viewer for scan evaluation.

## Experiment protocol

1. Start with known failure sheets plus clean controls. Inventory 30–50 architectural plan sheets from multiple projects/drafting sources, including scans, renovation overlays, mixed-scale sheets, openings, and open-plan areas. Track excluded cases instead of cherry-picking successes.
2. Split by entire project. Do not tune on holdout sheets or include revisions of a development sheet in holdout. Current metadata records the split; experiment owners must enforce it across files.
3. Independently label interior boundaries and ambiguous cases. Keep scans/source files available for visual adjudication.
4. Freeze the current Arc baseline, then compare a boundary-corrected geometry candidate and a specialist segmentation candidate on identical inputs. Evaluate a commercial service only after confirming input/output support and approval for sending customer files.
5. Record errors per sheet and drawing category. Do not pool synthetic and real results or report only successful matches. Track missed/extra rooms alongside matched-room error.
6. Time manual and assisted completion with the same measurement policy, counterbalancing order across users/sheets to reduce memorization effects.
7. Choose the implementation by corrected takeoff accuracy and measured time saved. A proposed product goal is >=50% less total time; it is not a demonstrated outcome. Set acceptable area/boundary tolerances with estimators before unblinding holdout results.

The user selected a real project, and its A4.0 floor plan has now been used for baseline and specialist-model screening. Customer artifacts remain outside the repository. Independent interior-boundary annotation and a held-out multi-project evaluation remain outstanding; the real-sheet screening does not establish an accuracy percentage.

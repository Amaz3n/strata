# The drawings workspace

> Reference. True as of 2026-10-04. Read before touching
> `components/drawings/drawing-viewer.tsx` or `components/drawings/workspace/*`.
> The quantity rules underneath are in `docs/takeoff-model.md`.

One screen, no modes. The sheet rail on the left, the sheet (and its 3D model,
beside it or alone) in the middle, the takeoff ledger on the right, one dock of
tools at the bottom, one task bar at the top of the sheet.

**Looking comes first.** Most opens are to read a drawing, so the right panel
starts closed and the sheet takes the width. It opens on Takeoff the moment an
item is armed (any measuring tool, a `?condition=` deep link, or a deal line
being measured), and
otherwise remembers whether this person left it open (`arc:drawings:panel`).
There is no instruction row: zoom is a small cluster at the sheet's bottom
right, and a one-line hint shows over the dock only while a tool has something
to teach (draw outline, length, ruler, fill, count, calibration).

**The rail** reads like the set: discipline groups (collapsible, sticky), each
sheet's thumbnail, number and title. A sheet only carries a badge when there
is something on it — takeoff measurements, open issues, or the 3D floor traced
from it. Most sheets never get a takeoff, so "not measured" is not shown and
there is no coverage meter.

**The scan.** While Arc reads a sheet — finding rooms, matching symbols,
reading the scale, tracing it for 3D — the sheet wears the hologram scan
(`SheetScan`, in image space so it zooms with the drawing); the model build
shows each source sheet as a blueprint bay (`ModelScanBays`), and a fresh model
arrives with one pass of the beam (`ScanReveal`). It is live progress: it runs
only while the work does and is still under reduced motion
(`components/drawings/workspace/scan-overlay.tsx`, `.arc-scan-*` in globals).

## The one rule: pick a tool, say what it's for, then click

A measuring tool always measures INTO a takeoff item. Picking Length (L), Area
(A) or Count (C) with nothing armed opens `ItemPicker` — items already on the
job, then the company library, then "Create" — and the choice arms the tool.
The tool supplies the unit (`TOOL_SOURCE_UOM`); the item never has to be set up
first. Clicking a ledger row arms that row's item with its own tool
(`toolForSourceUom(conditionSourceUom(...))`). The armed item survives sheet
changes, so the next sheet measures into it too.

| Tool | What a click does |
|---|---|
| Area · Fill rooms | Detection runs once per sheet; a click inside a room saves exactly that room (`useAreaTakeoff().fillAt`). The click is the review — the person is pointing at the room as it saves. Clicking a saved room again takes it out. |
| Area · Draw outline | `useMeasureTools` area ring; Add/Deduct. The escape hatch when detection is wrong. |
| Length | Polyline. A wall-height item (height set) reports SF from the run. |
| Count | Count by example is how counting works: the first click matches the symbol across the sheet's linework; with no match it counts one and every click adds one. Nothing saves until "Add N". |
| Ruler | A polyline that is never saved. |
| Redline | Cloud, arrow, text, pen — always red (`REDLINE_COLOR`), saved the moment it is drawn. |
| Issue or photo | A click opens "RFI, punch item or task…" (the host's create dialog) or "Pin a photo". |

Scale lives in one place, `ScaleChip`. A measuring tool on an unscaled sheet
says so in the task bar and offers "Confirm scale" (a detected proposal) or
"Set from a dimension" (two clicks, then the length typed inline); the tool
resumes the moment a scale exists.

The local calibration service checks current organization/project access and
compares the loaded metadata before saving; it confirms the saved body before
remeasuring. Automatic detection also compares its PDF page, raster dimensions
and manifest before recording a proposal. Unavailable files, PDF failures and
unconfirmed saves return errors; the viewer leaves the scan incomplete and
shows the error so reopening or reloading the sheet can retry. A genuine scan
with no proposal remains a completed scan.

The current-scale reader validates its sheet, published-revision parent and
version against current organization/project access, then rechecks the sheet
pointer and access before returning. Stored scales, proposals, scan markers and
inferred space scales must be valid evidence. Malformed evidence returns an
action error instead of an unscaled or completed-scan result. Legacy scales
without a method retain the dimension-tool fallback, and valid space-area
proposals remain available. The action returns the shared ActionResult envelope;
the viewer unwraps it and displays load failures without retaining a prior scale.

The server measurement-context loader uses the same stored calibration and
manifest validators, verifies the version's organization and sheet/revision
ancestry, and refuses missing or failed source reads. Create/update additionally
pin the context to their markup sheet. Existing uncalibrated or unrendered
versions still supply nullable context; draft versions remain usable for
carry-forward. Labels, sharing flags and explicit condition removal preserve
quantities and do not load the scale. Caller-specific authorization, atomic
source snapshots and original-request recovery remain workflow responsibilities.

Revision carry-forward exhausts ID-paged version history, source measurements
and existing carry provenance through an empty response. It rejects unavailable
or foreign source pages, future predecessors and measured versions tied with the
target timestamp. Copies preserve creator, privacy and raw metadata, validate
condition units and confirm every saved batch. Area deductions retain their
carried parent and remain pending human review. The original 200-row inserts
are separate commits: later failures and concurrent retries still require durable
original-request inspection, atomic context fences and recovery. The source
uniqueness index is inspected, pending actual database and concurrency proof.

The pending-review queue uses current project authorization and exhausts
ID-paged measurements rather than stopping at 500. It includes public and
current-creator private markups, validates sheet/condition ancestry and stored
review evidence, and refuses unknown or failed pages. The action returns an
ActionResult; the band exposes load failures with Retry and fences overlapping
requests and project changes. Confirmation, full family membership, fresh ACL
snapshots and durable recovery still require separate implementation and proof.

Confirmation validates the complete selected set before changing any review
flags, including current sheet/version ancestry, project and condition write
access, private creator, geometry and server-computed quantity at the current
scale. Each original update compares the loaded revision stamp and confirms
its saved body. A failed concurrent batch settles before the next begins. These
remain separate row commits: whole-room/deduction membership, the body the
human actually reviewed, atomic snapshots and durable retry receipts are open.

Signed-estimate alerts inspect every retained estimate destination line, even
when a newer bid, worksheet or draft estimate owns the latest-sync badge. They
require complete sync evidence and a verified target set. Targets must belong to the project or its signed
prospect ancestor; failed reads, missing targets and invalid quantities or rates
return errors. Deltas preserve signed direction and reject unsafe integer money;
zero rates display zero. Alerts still link to a human change-order decision.
The band reports review and alert failures independently, retains the successful
section and offers Retry. Completeness and privacy of upstream rollup members
and destination parents, immutable contract history, atomic source snapshots and
runtime acceptance remain open.

Condition discovery exhausts ID-paged rows through an empty response, with a
10,000-row refusal limit separate from the unchanged 200-condition creation
policy. Project reads use canonical project access; plan reads validate the
organization, version, parent and assigned division. Stored factors, rates,
waste and identities must be valid evidence. Existing long names and factors
retain read access, and ordering uses sort order, timestamp and ID. Upstream
member, cost-code, sync-history and landing-sheet reads still need completion
and privacy checks; dense UI capacity and fresh authorization remain unaccepted.

Rollup rate discovery loads the complete referenced cost-code set, including
inactive historical codes. Missing, failed or foreign reads return errors;
stored rates must be nullable, nonnegative safe integer cents. Pinned rates and
genuine null/zero fallback rates retain their existing behavior. Member
quantities must be finite before conversion, and priced totals must fit supported
integer precision. Complete raw member and sync evidence, rate-unit policy and
atomic source snapshots still need separate implementation and acceptance.

Measurement-member reads exhaust provider pages for each condition batch and
validate raw quantities, units, geometry and sheet/version/revision ancestry
before totals are computed. Outer parent joins retain missing ancestry so it
fails validation instead of silently removing the measurement. Each member project needs read access and each
condition must match its project or original plan-borrowing scope. A condition
with another creator’s private measurement fails visibly; quantities are not
silently subtracted into a smaller total. Publish or reassign private evidence
before shared pricing. Current orphaned evidence also requires resolution.
Valid legacy unversioned and unscaled measurements retain their classifications.
Fresh source snapshots, private-evidence recovery and full-family integrity
still require runtime and operator acceptance.

Sync-state reads exhaust ID-ordered destination pages through an empty response,
with a shared 200,000-line refusal limit. Every matching row must carry valid
organization, condition, line and target identities and finite quantities;
missing amounts cannot become zero. Older losing rows also require valid
provenance. Latest badges compare actual timestamp instants and microseconds,
with a stable destination/line tie. Genuine undated legacy syncs remain readable.
Worksheet status requires a valid project/prospect and an available workspace;
evidence-only rows retain their original hand-edit treatment. Destination parent
ownership, current destination permissions and units still require implementation
and acceptance. The signed-estimate server workflow requests every current
destination line with its own drift flag; ordinary panel responses omit that full
evidence payload. Alerts reject missing or duplicated history and inconsistent quantities.
Each signed-estimate line gets its own alert and stable UI identity. This is current
line evidence, not immutable records of earlier sync bodies. Contract immutability,
legacy bid provenance, source snapshots and runtime acceptance remain open.

Condition deep links read one owned condition, validate the same stored evidence
and read policy as discovery, and load the complete validated member set.
Landing uses net per-sheet measurements: current confirmed evidence takes
priority; current review evidence remains reachable when nothing is confirmed.
Stale-only or truly empty sets return null. Genuine unscaled legacy geometry
still identifies a sheet. The condition body and authority are checked again
before returning. Unknown, hidden-private, malformed or changed evidence returns
an actionable error; the register provides a context-bound Retry and cancels
old project/plan replies. Real transport/action compatibility, current member
snapshots, private-evidence recovery and actual sheet-open recovery remain open.

These are local source safeguards, pending actual schema/transport and field
acceptance. Calibration, quantity updates, audit and events still commit in
separate steps, so a failure can leave a saved scale or some recalculated
quantities. Durable request inspection and recovery, competing metadata writers,
current parent/file revisions and database transaction fences remain open under
the enterprise acceptance contract; this workflow is not release-accepted.

## Takeoff → estimate

`TakeoffLedger` reads `useTakeoffRollups` (one load for the whole workspace —
the picker, the handoff and the 3D Takeoff look read the same rows). Each row
says whether the estimate has it: Not in estimate / Estimate out of date /
Edited in estimate / In estimate / detached.

`EstimateHandoff` replaced the tick-then-sync dialog. There is no selection to
make: it previews every measured item against its line and opens with the lines
that would change already chosen. Hand-edited lines (`drift`) stay out unless
overwritten one by one; items that can't be priced yet (revision review,
unscaled) are held back with the reason instead of blocking the whole send. The
destination is resolved as before (measuring context → `?estimate=` → the
only writable target).

**A deal's pricing line is not a handoff.** The deal room hosts the viewer with
`line` set (`LineMeasuring`): the item is armed and stays armed, the header
carries "Measuring for {section}" and **Done**, and the panel is `LineLedger`
instead of the ledger and its send. Done writes the quantity onto the line
directly. A sheet the deal opens to read is `viewOnly`: the dock offers no
measuring tools and the ledger arms nothing, so nothing is measured into an
item no line owns — takeoff starts from a line on Pricing. Measurements a
revision carried over can still be confirmed there. `EstimateHandoff` never
renders on a deal.

## The 3D model

The model is a view of this workspace, not a page: Sheet · Split · 3D (keys
1/2/3). `/projects/[id]/drawings/model` redirects to `?view=3d`. The page
decides the target: `?planVersion=` → the plan version's model; a production
lot → none (it shares its plan's model); otherwise the project's own.

- Every surface that shows a building renders `components/plans/model-viewer`:
  `ModelScene` (three.js, render-on-demand, per-surface meshes so walls, rooms
  and objects can be hovered, selected and coloured) wrapped by `ModelViewer`.
  `ModelStage` adds its own controls for the plan workbench, the offering
  dialog and the buyer portal.
- `useWorkspaceModel` owns load → generate → poll (status only, via
  `loadFloorplanModelStatusAction`, never the geometry) → edit (optimistic,
  same reducer, rolled back on failure).
- Sheet ↔ model mapping goes only through `lib/drawings/model-takeoff.ts`
  (pure, tested): which rooms and walls the takeoff counts, the room under a
  sheet point, a room's outline on its sheet. Hover a room on the sheet and it
  lights in 3D; hover in 3D and it is outlined on the sheet.
- The Takeoff look colours each wall and room by the item that counts it and
  leaves the rest gray — the fastest way to see what the estimate missed.
- Walls are corrected on the sheet only (the plan workbench's review surface);
  3D is for looking, furnishing, and floor finishes. A room's "Counted in"
  moves or creates its area measurement on its source sheet.

## The 3D engine

`ModelScene` (`components/plans/model-viewer/model-scene.ts`) is loaded with
everything it needs by `loadModelRuntime()`; the path tracer loads on first use.

- **Render.** "high" quality runs one composer — GTAO (radii in feet), an
  outline on hover and selection, a little bloom on true highlights, SMAA,
  OutputPass; "fast" (coarse pointer or < 768px) renders forward. The
  backdrop is opaque (`theme.background`) because post-processing needs it.
- **Sun.** `sunPosition()` (`lib/plans/sun-position.ts`, tested) from the
  model's `site` (`site.set` edit: plan-up bearing and latitude; default 0° /
  35°), today's date and the hour on the Sun slider.
- **Cuts are one set of global clipping planes**: dollhouse cut, section box
  (six draggable handles) and "Section here" on a wall. Every pass, AO
  included, sees the same cut building. Tools (handles, measurements) render in
  a second, unclipped pass. Picking skips anything a plane removes.
- **Photo** hands the frame to `three-gpu-pathtracer`, refining to 320
  samples while nothing moves. The tracer cannot clip, so a photo is traced
  from a copy of the model whose cut level's walls are built to the cut height.
- **Trim.** `floorplan-geometry` generates baseboards (faces that look into a
  room, stopping at doorways), casings and raised door panels as `detail`,
  dropped past framing distance. Finishes are physical materials with the
  pattern as colour and bump map.
- **Furniture** with a `modelId` draws the real piece from
  `FURNITURE_CATALOG` (`public/models/furniture/`, Poly Haven CC0, see
  CREDITS.md); clones share buffers. The object's box stays as the invisible
  pick target and is left out of photos. Layout rules — back to wall, centre
  or best wall in a room, overlap / door swing / front clearance / wall
  crossing — are pure in `lib/drawings/furniture-layout.ts`.
- **Measure** snaps to the corner, then the edge, of the face under the
  cursor and prints feet-inches the way the plan does (`formatFeetInches`). It
  measures the model, which is built at the sheet's scale; it does not read
  the dimension strings printed on the sheet.
- **Picking** runs on `three-mesh-bvh`. Levels above the one in focus are not
  built at all; a GLB export rebuilds the whole building for the file.
- **Walkthroughs** are saved views with a `path` (`lib/plans/camera-tour.ts`,
  tested): record with ●, play from the Model menu or the stage's menu, share
  with "Copy link" (`?view=3d&modelView=<id>`). VR appears only where
  `immersive-vr` is supported and stands you at the walk position at real scale.

## Options, palettes, compare, pins

- **Options**: a Design Studio option can carry `model_changes`
  (`lib/drawings/model-options.ts`: floor finish, wall finish, furniture, by
  room label). The Design tab lists the catalogue's options that have any,
  priced from THIS model (floor SF, perimeter × ceiling height, or each), and
  shows ticked ones in 3D through `applyModelOptions()` — never saved onto the
  model, because choosing is the buyer's.
- **Palettes** (`lib/drawings/design-palettes.ts`) set every floor in one save;
  specific rules (baths, bedrooms) win over broad ones.
- **Compare** diffs the model against any saved revision
  (`floorplan_model_revisions`, archived on every save) with
  `lib/drawings/model-diff.ts`: rooms added / resized / removed, walls added /
  removed, coloured in 3D, and the estimate move for SF items counting those
  rooms (Δ SF × (1 + waste) × unit cost). Other units are listed as not priced.
- **Pins**: the issues and photos on the sheet on screen stand in 3D on that
  sheet's floor; clicking one opens it like on the sheet.

## The shared building record

`sheet_building_records` (migration `20261004121500_sheet_building_records`,
pending approval) holds, per sheet version and engine version, the engine's
whole-sheet runs keyed by finish policy and recognition mode
(`lib/drawings/sheet-building-record.ts`, `lib/services/sheet-building-records.ts`).
Takeoff's area fill and the model interpretation both go through
`ensureSheetBuildingRun`; they share a run when their settings match (takeoff's
default "drawn" policy is a separate run in the same row, because the model
includes fixtures). Until the table exists both fall back to their previous
paths.

## Deliberately not built yet

- Uploading a 3D file (IFC/GLB). Every model is traced from sheets; there is no
  upload path or loader.
- Schedule progress in 3D. Schedule items carry no room or wall reference, so
  there is nothing to colour by; it needs that link first.
- Buyer selections on the portal model. Options are previewed in the
  workspace; the buyer-facing choice flow stays in Design Studio.

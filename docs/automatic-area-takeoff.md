# Automatic area takeoff — desktop preview

Implemented September 26, 2026. **Release accuracy gate has not passed.**
How accuracy is measured: [takeoff-evaluation.md](takeoff-evaluation.md). Current
scores and the work plan: [the reliability gameplan](plans/takeoff-reliability-gameplan.md).

## Using it

Choose **Takeoff** in the viewer header, set the drawing scale, then choose
**Find floor areas**. No takeoff item is required to detect or review areas.
The drawing has a dedicated canvas, a contextual tool row, one right inspector,
and a status bar with scale and zoom. Search and versions share the inspector;
returning to takeoff preserves the review. On narrow mobile screens, **Show drawing**
and **Review** switch between the canvas and a full-height inspector.

Hover or select areas on the drawing or in the inspector. **Locate** brings a
listed area into view. Proposals have quiet neutral outlines; selection uses the
primary color. Choose or create an SF/SY floor-finish item in **Add to**. Check
boundaries, deductions and scale, then use the pinned **Add areas** action.
Nothing contributes to quantities before acceptance. Net and waste-adjusted
quantities use the destination's reporting unit; waste is applied once.

Detection defaults to the whole sheet. Detection settings offer a plan region,
fixture policy, rerun, and explicit image fallback. Keep different scales outside
the selected region. Changing the region or fixture policy starts a new proposal
review. Detection remains a server action rather than a durable background job.

**Draw an area manually** creates a proposal in this same review. Other manual
measurements retain the existing item-based save flow. The **Quantities** tab
contains item rollups, pricing, revision checks and estimate transfer.

Switching items preserves proposal geometry and selection; it resets finish-scope
confirmation. Accepted geometry remains reusable for another compatible item and
is hidden from further selection into the same item. Server overlap checks remain
authoritative, including after reloads or edits. New acceptance does not rewrite
previously saved quantities.

Drafts are validated and stored in the current tab's session storage, scoped by
project/plan, sheet revision, source, engine version, scale and image dimensions.
Up to 20 reviews are retained. Returning to a sheet or reloading restores proposals,
edits and selection, but requires fresh scale/boundary confirmation. Storage failure
is visible; server-side review validation is unchanged. Drafts are not shared across
tabs, devices or collaborators.

Corrections:

- **Close opening:** two clicks add a virtual measurement boundary, then rerun
  detection. Edited proposals are preserved; overlapping new proposals are
  suppressed and reported. It never modifies 3D walls. Choosing a new region
  starts a new review and clears the previous region’s edits.
- **Split:** select one area, then two points defining a dividing line. Splitting
  a complex concave ring into disconnected pieces is refused. Remove deductions
  before splitting and reapply them to the resulting zones.
- **Move corner / Move edge:** select one area; click a corner or edge midpoint,
  then its destination. PDF snapping applies; Alt bypasses it.
- **Merge:** select adjacent areas sharing a boundary. Disjoint or overlapping
  selections and areas with deductions are refused. For identical finishes in
  separate rooms, select and accept the rooms together; no union is needed.
- **Deduct:** select one area and click opposite corners of a column or void.
  Deductions must be fully contained and nonoverlapping. **Remove deductions**
  clears the selected areas' proposed holes when the source shape was furniture.
- **Undo edit:** restores the previous proposal geometry (20 local edit states).
  Escape cancels the pending point, then exits the current edit tool/review.

**Architectural interpretation (engine 20)** uses PDF paths first, then the
configured drawings vision provider for unresolved/shared spaces or uncertain
source boundaries. Up to four crops are considered, within a 25-second service
recognition budget. This route can make model calls and incur normal AI usage.
The model classifies supplied source path IDs and proposes doorway anchors from
actual source vertices. It cannot supply unrestricted room coordinates or area
quantities. Failed/unavailable recognition preserves the vector result with a
warning. Use `interpretation: "vector"` in diagnostic calls for a model-free run.
Partial/unavailable recognition is not cached as a permanent result. An explicit
retry can make fresh model calls; incremental continuation across the four-crop
budget is not implemented.

**Image proposal** remains a separate explicit fallback using the configured
drawings vision provider and a crop at up to 2,400 image pixels per side.
Invalid, self-crossing, out-of-crop
or crop-edge proposals are refused; valid outputs remain unverified suggestions.
No scan model is accuracy-qualified. A local SAM 2.1 Tiny diagnostic with manually
seeded room points failed all three printed-area checks; see the verification
report below. It is not integrated into production detection.

**Download detection details** exports a private, source-bound replay after a
successful detection snapshot save. It contains drawing paths/text, scale,
region, fixture policy and captured visual observations. Replay locally with
`node scripts/replay-area-takeoff.js replay.json result.json`; a different engine
is refused unless `--compare-current` explicitly requests a non-exact comparison.
No network/model call is made by the replay command. This makes application
results reproducible instead of comparing them to independently re-extracted
PDF inputs with potentially different calibration or region settings.

Architecture output separates source elements, doorway adjacency, provisional
spaces and finish zones. When fixture paths are identified, a separate pass
reconstructs physical spaces with those footprints included; measured finish
zones keep the requested fixture treatment and link to the physical spaces.
This extra pass adds computation. Boundary support is evidence provenance, not a
calibrated confidence score. Finish materials/scope remain unverified; no
cross-sheet finish-schedule registration or specialized model qualification is
claimed. All proposals still require review.

## Geometry and evidence

`area-evidence.json` retains original PDF path commands, cubic control points,
stroke width/dashes, fill/color/color-space/opacity, layer names, group IDs and
clip references. Commands use the same normalized rendered-sheet coordinates as
markups. `vectors.bin` remains backward compatible. Extraction algorithm 5 writes
the additional artifact during ingestion and vector backfill. Existing sheets
extract it on demand from the org-scoped source file.

The area engine uses drawn faces, a planar subdivision with shared T/X vertices,
and physical-unit tolerances. It removes zero-area spurs, excludes dashed and
identified annotation layers, and filters unsupported small/unnamed enclosures.
The engine also filters imperial dimension annotations before constructing faces.
It requires dimension-only text, nearby aligned linework, endpoint ticks or
arrow legs, and a span agreeing with the printed dimension. It handles horizontal
and vertical annotations, text gaps and chains, then removes supported witness
lines conservatively. It preserves heavier strokes, explicit wall layers and
user boundaries; it never removes an entire PDF path merely because one segment
is an annotation. A message reports how many dimensions were excluded.
Missing text/ticks, metric-only dimensions and arbitrary text rotation remain
unsupported by this classifier. Those annotations may still split proposals.
Engine 3 preserves connected wall corners when identifying witness-line tips
and allows arc-supported door thresholds to meet perpendicular return walls or
the interior of a jamb segment. Both cases have regression tests that returned
zero areas before the correction.
Engine 4 was checked against the supplied Burke.pdf, page 4 (A4.0). It recognizes
CAD dimension layers such as `A_DIM_FLR` and excludes ceiling/millwork annotation
boundaries. Door detection fits complete contiguous cubic curves, including
multi-segment swings and modest overswing, with radius and circularity checks.
Engine 14 preserves classified wall/jamb returns beneath overlapping text, accepts
source-classified CAD door swings down to 36 degrees, and projects offset hinge
points onto nearby drawn structure within one inch. Existing endpoint tolerance
is retained. Aligned wall faces and both jambs can also establish finish-face
thresholds from explicit swing geometry. Retracted pocket leaves require paired
panel faces bracketed by a wall pocket; wide openings require opposing pockets.
Door-only closed symbols are excluded from floor proposals. Duplicate source
edges do not spend the finite geometry budget twice. Whole-sheet search shares
its budget across room labels and consolidates repeated unsupported-enclosure
warnings. Elevation prose (such as NAVD notes) is excluded from takeoff's local
dimension-chain check. These rules remain reviewable hypotheses, not accuracy
certification.

Nearby parallel faces are supporting evidence, not proof of a wall. Door-sized
arcs can support a virtual threshold only when drawn jamb boundaries also
support its endpoints. It does not reuse the floorplan interpreter's 14-foot bridges.

Engine 5 clips existing lines to search windows without adding crop boundaries,
recovers enclosing faces around attached interior loops, and supports sliding
thresholds only with explicit door-layer panels, aligned wall faces and jambs.
Whole-sheet proposals require room-label evidence or predominantly structural
boundaries for substantial unlabeled enclosures, cannot overlap each other, and
undergo local scale checks. Missing labels, processing limits and
ambiguous interpretations are reported. Outlined text is not readable room-label
evidence: such PDFs currently need manual region selection or an image proposal.
Image/shading/mask paint not represented by vectors is flagged.

Nested shapes are proposed deductions, never certified columns: the user must
check them. Crop edges are never invented walls. Compound/curved/unknown clips
are excluded with a warning; convex clips are supported conservatively. Paint
order/opaque overprints, unusual CAD layers, masking, curved walls, furniture,
open-plan zones and very fragmented exports remain important limitations.
Dense regions (>24,000 unique candidate segments), truncated extraction and complex
boundaries (>500 vertices) fail or abstain visibly. At most 200 areas are shown.

All proposals require review. Scores are not calibrated probabilities and the
UI does not call any proposal “verified.” Quantity is polygon area in the
calibrated scale; original faces, not inferred wall centerlines, establish it.

## Acceptance and revisions

The service checks org membership, takeoff and markup permissions, current
revision, condition scope/unit and the calibration used during review. It
recomputes quantities server-side, rejects invalid/overlapping selected geometry,
and inserts the outer polygons and their deductions in one SQL statement.

IDs derive from org, version, condition and canonical geometry. Identical retries
(including reversed ring winding) do not double count. This does not deduplicate
slightly different geometry by identity alone. The service also reads every
existing area in the same version and condition, rejects overlaps and refuses a
retry with changed deductions. Acceptance uses an atomic snapshot RPC. A transaction advisory lock serializes
measurement writes for the organization, sheet version and condition; a changed
snapshot rejects acceptance and asks for another review. Manual measurement
writes take the same lock. Exact geometry retries remain idempotent.

Revision carry-forward remains pending review and excluded from totals. An
advisory local comparison includes path order, paint styles, clips, text and
calibration. Only matching captured evidence is marked unchanged. Missing/legacy
artifacts, groups and unrepresented image/shading/mask paint are unavailable,
never unchanged. The revision panel can confirm the unchanged-evidence subset;
no comparison automatically accepts a measurement. Carried deductions reference
the new parent ID, a room and its deductions share a conservative comparison,
and carry provenance survives confirmation so retries cannot copy it again.
Recalibration continues to
use the existing takeoff measurement flow.

Markup styles retain engine version, proposal source, original points, proposed
boundary evidence, proposal ID, edit flag, review flag and deduction parent ID.
The audit trail records batch IDs, edited count and elapsed review-session time.
Elapsed time includes idle time and is not itself proof of estimator productivity.
Proposals are cached by org, revision, evidence bytes, engine version, region,
added boundaries, fixture policy and calibration, in a bounded process cache and derived R2 JSON.
Changing version, scale or permissions invalidates the active review; eligible
revision/scale drafts can be restored. Changing items preserves geometry. Late server
responses from another drawing context are ignored. Atomic acceptance requires the migration
`20260927004537_takeoff_area_atomic_acceptance.sql` (applied to production).

## Manual desktop checks

1. On a calibrated current architectural sheet, choose a floor SF/SY condition,
   open Auto areas without selecting a region. Verify proposal alignment while panning,
   zooming and resizing; repeat in dark mode.
2. Check a known room dimension/area; inspect door thresholds, columns, closets
   and open-plan labels. Try the correction controls and Undo.
3. Accept two selected rooms with a deduction. Verify condition total and
   estimate sync, then retry the same area: it must not duplicate the quantity.
4. Switch sheet/condition or recalibrate while detection is pending. Old results
   must not appear on the new context. Trigger an error and retry without losing
   the accepted measurements.
5. Try a scan with a tight image crop. Every result must remain a review proposal;
   unavailable model/invalid response must leave manual takeoff usable.


## Accuracy and verification

Accuracy is scored against traced references only — see
[takeoff-evaluation.md](takeoff-evaluation.md) for the data split, tracing tools,
conventions and the frozen release protocol. The running scoreboard lives in
[the reliability gameplan](plans/takeoff-reliability-gameplan.md). The public
Swiss Dwellings diagnostics ([fixture attribution](../tests/fixtures/area-takeoff/README.md),
CC BY 4.0) are development diagnostics and do not count toward any gate.

Software checks: `pnpm test:takeoff`, `pnpm test:area-ui` (real controller with
mocked actions; needs Bun and Playwright Chromium) and `pnpm test:drawing-workspace`.
Real-PDF regressions run only when `ARC_BURKE_PDF`, `ARC_TORNINCASO_PDF` or
`ARC_MHK_PDF` point at the private source files. Acceptance SQL is exercised by
`scripts/test-area-acceptance-sql.mjs` and `scripts/test-area-acceptance-concurrency.mjs`
against isolated local databases, never the linked project.

# Estimating and drawing quantities

The working estimate and Plans & quantities are two views of preconstruction estimating. Drawings remain available to project teams independently. Users may begin with scope, quotes, allowances, or plans; drawing upload is not a required estimating stage.

## Entry and return

- An estimate scope row offers Measure, then area/length/count units and Measure from plans. Save the worksheet before navigating. The server provisions the precon resource project if necessary and links a reusable takeoff item to the exact row. Geometry is saved independently; returning without applying never changes its commercial quantity.
- Drawings offer Start takeoff. The quantity review can attach a measured item to an existing compatible scope row or create one. An already-linked row cannot be reassigned accidentally, and two selected quantities cannot target one row.
- A contextual measurement session displays its scope and destination. Applying a row's reviewed quantity returns to that expanded estimate row. Other sessions let the user continue measuring.
- Project draft estimates, bid packages and unissued draft/pricing change orders have contextual measurement entry points. Production plan-version destinations retain their existing dedicated route. Takeoff never writes directly into an approved budget or issued agreement.

## Takeoff sidebar

The viewer mode buttons use the primary blue accent for the active mode. Takeoff has one home screen containing measurement entry points and saved quantities; there are no Measure/Quantities tabs or working-item selector.

Area takeoff follows two steps: select and review geometry, then name and save the quantity. Detection and manual floor-area drawing need no condition or price. Saving can create a quantity using only a name and SF/SY unit, or add to an existing compatible quantity. A save retry reuses a newly created destination. Sheet geometry remains reusable for other finishes, with duplicate protection for the same destination. A session opened from an estimate row retains that row's bound quantity.

Lengths and counts use a compact name/type setup that immediately activates the drawing tool and labels its destination. Converted measurements remain available through advanced setup. Saved rows offer an explicit Measure more action; selecting a row opens its detail instead of silently changing the drawing destination. Applying saved quantities remains a separate review through Use in estimate.

## Quantity and price ownership

`metadata.takeoff_source` links a worksheet row before the first application. `metadata.takeoff` records the applied quantity, net quantity, waste and per-sheet breakdown. Those are different states, visible in the worksheet. The existing condition ID remains the source of geometry.

Applying quantities preserves same-unit rates. Changing an unmeasured lump-sum row to a measured unit clears its incompatible cost, with an explicit preview warning. Manual and selected trade quotes receive measurement evidence without altering their quantity or price. The quote-review workflow remains responsible for commercial changes.

Both measured and destination quantities are compared with the review before applying. Server-side scope checks, worksheet version checks, hand-edit handling and revision/calibration gates remain authoritative. No price or quantity from the browser is accepted as a measurement calculation.

## Revisions and proposals

Worksheet source badges expose saved quantities and differences from current plans. Pending revised measurements and uncalibrated geometry cannot be applied. Source links open the relevant condition; missing/deleted sources preserve existing commercial quantities and say the source is unavailable.

The active proposal editor now uses the worksheet snapshot service when preparing a proposal from the working estimate. It preserves deliberately edited proposal presentation/lines/settings in that snapshot. Prepare updated proposal creates a version, while identical drafts can be reused. Already-issued documents remain unchanged. Unreviewed or unapplied changes to live measurement sources must be resolved before preparing a fresh snapshot; explicit manual quantity overrides remain distinguishable.

## Project changes

`apply_change_order_measurements` applies draft change-order quantities and recalculates totals in one transaction. Its server service checks project-scoped permissions before calling the RPC, which is executable only by the service role. The transaction checks project scope, issued/visible state, parent timestamp and a typed snapshot of existing lines. It preserves edited unit prices, fixed internal costs and unrelated line metadata; linked commitment-cost lines cannot be repriced by takeoff. Editing a measured change retains its provenance. Its execution baseline and budget movement still pass through the existing change-order approval workflow.

Deploy `20260929011236_takeoff_estimating_continuity.sql` before using the new change-order destination. The migration is additive and is tested in isolated PostgreSQL (PGlite); it has not been applied to a shared or production database by this task. The installed Supabase CLI does not expose the advisors command; invoker rights, grants, scope checks and transaction rollback were reviewed/tested directly.

## Verification

- `tests/measurement-context.test.js`: reusable row bindings, permission failures, missing rows and contextual destinations.
- `tests/precon-takeoff-destinations.test.js`: existing-row mapping, rate protection, quote evidence, mismatched units, missing/foreign mappings, reviewed quantities and lump-sum conversion.
- `tests/takeoff-continuity-db.test.js`: transactional change-order writes, totals, issued-state/permission/project checks, stale snapshots and rollback. Set `ARC_TEST_PGLITE_MODULE` when PGlite is supplied outside the repository.
- `pnpm test:estimating-continuity`: real scope-row/review components with deterministic server fixtures; verifies return mapping, provenance, revised quantity warning, light/dark/mobile layouts and browser errors. This is an isolated UI flow, not a live customer mutation.
- Existing drawing-workspace browser suite and takeoff/drawings/precon regression suites remain part of verification.

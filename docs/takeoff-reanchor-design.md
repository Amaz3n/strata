# Takeoff — revision re-anchoring (Phase 8)

> Required reading before touching `lib/services/takeoff-reanchor.ts`.
> Gameplan: `docs/archive/takeoff-gameplan.md` §Phase 8 (capability C3, "living takeoff").

## 1. The problem

Measurements pin to `sheet_version_id`. That is correct — a quantity measured on
A-101 Rev 2 is a statement about Rev 2's geometry, and reusing it against Rev 3
without checking would be a lie. But the naive consequence is worse: publish a
revision and every measured quantity on that sheet silently drops out of the
rollup, because `getConditionRollup` only counts markups on the current
revision. The estimate keeps its number, the takeoff loses its evidence, and
nothing tells anyone.

So the choice is not "re-anchor or not". It is "re-anchor visibly, or lose
quantities invisibly".

## 2. State machine

Each measuring markup on a superseded version is in exactly one state:

```
                 revision published
   anchored ─────────────────────────► pending_reanchor
                                            │
                        ┌───────────────────┼───────────────────┐
                        │                   │                   │
              region unchanged      region changed        no successor
                        │                   │                   │
                        ▼                   ▼                   ▼
                  transferred          needs_review          orphaned
                (new markup on         (human decides)    (sheet dropped
                 the new version)                          from the set)
                        │                   │
                        └────────► anchored ┘   (after accept / re-measure)
```

State lives in `drawing_markups.data.style.reanchor`, not in a new column: it is
transient, it is per-markup, and adding a column for a workflow flag would make
every markup query carry it forever. The shape is

```jsonc
{
  "state": "pending_reanchor" | "needs_review" | "orphaned",
  "from_version_id": "…",     // the version this measurement was taken on
  "to_version_id": "…",       // the version it is being moved to
  "reason": "region_changed" | "no_successor" | "not_attempted",
  "queued_at": "2026-07-28T…"
}
```

**Invariant: no markup is ever deleted by this process.** A markup that cannot
be transferred stays exactly where it is, on its old version, flagged. Losing a
measurement is unrecoverable; leaving a stale one is a nuisance.

## 3. Transfer

### 3a. Degraded mode (what ships first, and always works)

On revision publish, every measuring markup on the sheet's prior version is
copied forward onto the new version with `state: "needs_review"`. The takeoff
panel surfaces a band — "3 conditions touch changed areas on A-101 Rev 3" — and
the estimator confirms or re-measures each one.

This is strictly better than today. Nothing is lost, nothing is silently
counted, and the work is bounded by the number of sheets that actually changed.

**Crucially: a `needs_review` markup does NOT count toward its condition's
rollup.** A quantity in the rollup is a claim about the current drawings, and a
transferred-but-unconfirmed measurement is not yet one.

### 3b. Auto-transfer (added on top, never replacing 3a)

Where the geometry under a measurement did not change, the review is busywork.
Detecting that reuses the comparison infrastructure that already exists
(`components/drawings/comparison-viewer.tsx` renders two versions' tiles):

1. Fetch both versions' tiles at a coarse pyramid level.
2. Raster-diff them into a changed-region mask.
3. For each markup, test its bounding box (expanded by a tolerance) against the
   mask.
4. No overlap → auto-transfer, `state` cleared, counted immediately, audited.
   Overlap → `needs_review`, as in 3a.

Tolerance matters more than cleverness here. Title-block revision clouds and
date stamps change on every sheet; a diff that flags the whole sheet because the
revision triangle moved is useless. The mask must ignore the title-block region
(the same region the scale detector reads) and must threshold on connected-area
size, not on pixel count.

**Auto-transfer is only correct when the sheet's calibration is unchanged.** If
the new version's scale differs — or is merely carried-forward and unconfirmed —
every markup goes to `needs_review` regardless of the raster diff, because a
transferred measurement re-measures itself against the new scale and would
silently change value.

## 4. The money alert

After re-anchoring, conditions whose effective quantity moved AND that are
synced to an estimate raise a delta alert:

> Rev 3 changed **Flooring** +240 SF ≈ **+$1,032** — draft a change order?

Rules:

- **Never auto-create the change order.** It deep-links into the existing CO
  flow with a prefilled description; a human decides whether the revision is
  owner-driven scope or the architect fixing their own drawing.
- Only fires when the estimate is executed or the quantity is under a signed
  document. A drifted draft estimate is a re-sync, not a change order.
- The dollar figure uses the condition's effective rate at alert time and is
  labelled approximate. It exists to make the size of the change legible, not to
  price the CO.

## 5. Ordering and idempotency

Re-anchoring is queued through the outbox (`reanchor_takeoff_markups`), one job
per published revision, because publish must not block on a raster diff of forty
sheets.

The job must be idempotent: outbox jobs retry, and a partially-applied transfer
that ran twice must not double-count. Keyed on `(from_version_id, to_version_id,
source_markup_id)` — a markup already carrying a `reanchor.to_version_id` for
this target is skipped.

## 6. What is deliberately not built

- **Geometric re-anchoring** (finding "the same wall" in the new drawing and
  moving the polygon onto it). Tempting and wrong: a plan that moved a wall by
  6" would silently adjust the quantity, which is exactly the change the human
  needs to see.
- **Cross-sheet transfer.** If a detail moves from A-101 to A-501, the
  measurement orphans. Correct: it is a different sheet.
- **Auto-resync to the estimate.** Re-anchoring updates the takeoff; pushing
  that to money stays an explicit, previewed action (Phase 2's sync dialog).

## 7. Acceptance

- Publishing a revision on a measured sheet produces a review queue, not data
  loss — verified by counting markups before and after.
- A markup on an unchanged region auto-transfers and counts immediately.
- A markup on a changed region lands in `needs_review` and does NOT count.
- A revision that changes the scale sends everything to review regardless of the
  diff.
- Re-running the job twice produces the same result as running it once.
- The stale-estimate alert fires with the correct delta and deep-links to CO
  creation without creating anything.

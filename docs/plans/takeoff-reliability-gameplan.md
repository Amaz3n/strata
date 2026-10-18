# Takeoff & 3D reliability gameplan

Status: active, started 2026-10-04. Owner: Agustin (solo, no architect).
This is the only takeoff/recognition plan; the earlier ones were folded into
[`docs/takeoff-evaluation.md`](../takeoff-evaluation.md) (how we measure) and
deleted on 2026-10-04. Most were never committed, so only the folded content survives.

## Where we are (measured, not guessed)

- Engine 61. First honest score — Gundersen A1.2, one sheet, scored untouched:
  10/22 rooms found as their own area, 1 near-exact boundary, **0 within 2%**.
  Open-plan zone matched at IoU 0.94 once the convention was fixed. Real misses:
  closets swallowed, a missed interior wall, overshoots, one split, wrong label,
  and a 2–5% systematic offset on every room.
- 7 locked holdout projects, 0 traced. ~18 development projects, 1 traced.
- Engine is a chain of rule passes (~1,500 thresholds) tuned sheet-by-sheet over
  60 versions. Two planar-subdivision kernels, 6+ door detectors, takeoff and 3D
  store separate copies of the building. Most of `lib/drawings` is uncommitted.

## The target

Two bars. We ship at the first; the second is the long-term gate.

| | **Bar A — ship as review-assist** | **Bar B — release qualification** |
|---|---|---|
| Scope | Vector PDFs, residential + light commercial | Adds scans, multi-level |
| Rooms found as own area (IoU ≥ 0.5) | ≥ 90% | ≥ 98% |
| Boundary (IoU ≥ 0.95) | ≥ 75% | ≥ 95% |
| Area within 2% | ≥ 80% of matched rooms | ≥ 95% |
| Sheet total SF error | ≤ 2% median, ≤ 5% worst | ≤ 1% / 2% |
| Silent misses | 0 — every unproposed labelled room is flagged | 0 |
| Correction time | Reviewing + fixing ≤ 50% of tracing it manually | ≤ 10 min per floor |
| Evidence | 10 holdout projects | 30 holdout projects, 5 conventions, 10 scans |

Bar A is what makes the feature worth using: an estimator saves half their time
and is never surprised by a missing room. Bar B is the existing
`recognition-qualification.md` gate; it is not dropped, it is staged.

## Rules of the game (apply every phase)

1. **Holdouts are scored only at phase gates**, never during work. A holdout that
   drives a fix is retired to development and replaced.
2. **No per-sheet fixes.** A change must name a *mechanism* seen on ≥ 2
   development projects. If it only helps one sheet, it doesn't go in.
3. **Every change is scored on the whole development set.** Keep it only if the
   dev scoreboard improves and no sheet regresses by more than 1 room.
4. **Score by square feet of error, not counts.** Fix the mechanism costing the
   most SF first.
5. **Silent omission is a bug.** Anything dropped by a limit becomes a visible
   warning.
6. **One engine version bump per kept change**, logged in the scoreboard with
   its before/after numbers. No "final2".

## The weekly loop (from Phase 1 on)

```
Mon  trace 1–2 development sheets (≈1–2 h)
Tue  run dev scoreboard → rank failure mechanisms by SF error
Wed–Thu  fix the top mechanism (with Claude)
Fri  re-score dev set → keep or revert → log it
```

## Phase 0 — Foundation (1 week)

Nothing here changes accuracy; it makes everything after it trustworthy.

- [ ] Commit `lib/drawings`, services, tests, docs and the untracked
      `architectural_model_revisions` migration (applied in prod, missing in git).
      *(Owner — held while other work is in flight.)*
- [x] Delete dead code: the legacy interpreter (`floorplan-interpret.ts`; sheet
      selection moved to `floorplan-sheets.ts`), `floorplan-vision.ts`,
      `floorplan-vision-assist.ts`, `architectural-reconcile.ts`, the experimental
      raster extractors (`raster-features/-mass/-junctions/-runs`), two orphaned
      components, and the tests that only covered them.
- [x] Turn silent drops into warnings: dense whole-sheet windows, interior faces
      over 1,000 edges, labelled enclosures above `maxAreaSqft` (default 100,000).
- [x] `scripts/score-area-reference.mjs` (`pnpm takeoff:score`): exact per-room
      IoU, area error, merged/missed/split, SF-weighted error; open-plan groups
      via a `REFERENCE.scoring.json` sidecar.
- [x] `scripts/dev-scoreboard.mjs` (`pnpm takeoff:scoreboard`): every traced dev
      sheet, history in `tmp/takeoff-corpus/dev-scoreboard-history.jsonl`, exit 1
      on a regression. Skips holdouts.
- [x] Holdout guard (`scripts/holdout-guard.js`): engine-running scripts refuse
      registered holdouts unless `--gate`, which is logged in the registry.
- [x] Conventions, tools and protocol in `docs/takeoff-evaluation.md`; the 12
      older takeoff/recognition plans folded in and deleted.

**Gate:** committed, scoreboard runs on Gundersen and reproduces today's numbers
(reproduced 2026-10-04: 11/16 zones found with the open plan grouped).

## Phase 1 — Development set (2 weeks, then continuous)

- [ ] Trace 8 development sheets from the exposed projects, chosen for variety:
      Roth, Growney, Galleon, Ginns, Matustik, Shad Ct, Sheepshead, Tornincaso.
      (They are already burned for holdout use, so tracing them costs nothing.)
- [ ] Settle the 2–5% offset question first: compare engine vs trace wall face on
      3 clean rooms. Either an engine fix or a convention line — decided once.
- [ ] Produce the first dev scoreboard and the ranked failure-mechanism list.
- [ ] In parallel: trace 3 holdouts (Zeller, Passidomo, Hart). Do **not** score them.
- [ ] Source 3 more residential holdout projects (target 10).

**Gate:** 9 traced dev sheets, scoreboard baseline recorded, top 5 mechanisms
ranked by SF error.

## Phase 2 — One geometry kernel (3 weeks)

Replace the foundations without changing behaviour, so later accuracy work sits
on solid ground and runs fast.

- [ ] `lib/geometry/`: snap-round to a fixed grid *before* intersecting, planar
      arrangement (half-edge/DCEL) with proper hole assignment, built **once per
      sheet** and queried by window (today: up to 60 rebuilds × 4 passes).
- [ ] Adopt a proven polygon library (clipper2 or polygon-clipping) for union,
      split, overlap and deductions.
- [ ] One copy each of area, point-in-polygon, segment intersection, arc fit.
      Move `area-takeoff` and `floorplan-model` onto it; delete the old kernels.
- [ ] One layer vocabulary (`areaPathRole`); delete the other three.

**Gate:** dev scoreboard equal or better on every sheet; whole-sheet p95 runtime
≤ 5 s (today ~16 s); zero invalid polygons.

## Phase 3 — Accuracy: candidates + global resolution (4–6 weeks)

The structural change that stops the patch-chain.

- [ ] Every evidence source emits **scored candidates** instead of decisions:
      wall-face pairs, door/opening hypotheses, room labels, LLM path roles (as one
      feature, cached by source-path identity, temperature 0).
- [ ] One resolver picks the consistent set: rooms close, openings have hosts,
      labelled rooms get exactly one area, closets/baths with walls+doors stay
      separate, open-plan zones merge only where nothing is drawn.
- [ ] Collapse thresholds into one config file of named parameters; calibrate
      them on the dev set, not by hand per sheet.
- [ ] Work the ranked mechanism list through the weekly loop. Expected early wins
      from Gundersen: swallowed closets, missed short interior walls, label
      assignment, overshoot past openings.

**Gate (= Bar A check):** dev set meets Bar A. Then score the 10 holdouts **once**.
If holdouts meet Bar A → Phase 5 ship. If not → retire the failures to dev,
replace them, loop Phase 3.

## Phase 4 — One building record, takeoff and 3D (3–4 weeks, can overlap Phase 3)

- [ ] Detection moves from the server action to the 800 s job path; work-unit
      budgets instead of wall-clock budgets, so reruns are identical.
- [ ] Persist one **building** per sheet version. Takeoff areas and the 3D model
      are both projections of it; no separate engine runs or vision calls.
- [ ] Corrections become an edit log anchored on stable geometry ids, replayed on
      regeneration and on new drawing revisions (today: discarded on force).
- [ ] 3D fixes: wall miters/joins, remove double-drawn walls, real confidence
      from evidence, level-height edits move the floor above, WebGL context
      release, theme-aware palette, page errors not swallowed as "no model".

**Gate:** a wall fixed in 3D changes the takeoff area and vice versa; corrections
survive a regenerate and a revision upload; same input → byte-identical output.

## Phase 5 — Ship Bar A (1–2 weeks)

- [ ] Estimator timing trial on 3 holdout-equivalent sheets: review+fix vs manual.
- [ ] UI states every proposal's evidence and every flagged miss; scoreboard
      numbers published in `docs/automatic-area-takeoff.md`.
- [ ] Release as review-assist for vector PDFs.

## Phase 6 — Toward Bar B (after ship)

- Grow holdout to 30 projects / 5 conventions; add a hired estimator as second
  reviewer (~$25–50/h) so references are independently checked.
- Scans: evaluate a trained segmentation model against the raster heuristics on
  the same traced scans before investing further in pixel rules.
- Multi-level registration, finish-schedule registration.

## Timeline (solo, realistic)

| Weeks | Phase |
|---|---|
| 1 | 0 Foundation |
| 2–3 | 1 Dev set (tracing continues weekly after) |
| 4–6 | 2 Kernel |
| 7–12 | 3 Accuracy loop (+ 4 in parallel from week 9) |
| 13–14 | Holdout gate → 5 Ship Bar A |

~3½ months to a measured, shippable review-assist. Bar B is a further quarter
or more, gated mostly by acquiring and tracing data, not code.

## Scoreboard

Columns follow `pnpm takeoff:scoreboard`: found = zones matched at IoU ≥ 0.5;
exact and ≤2% are shares of found zones; SF err = square feet wrong / traced SF.


| Date | Engine | Dev sheets | Found | Exact (≥0.95) | Within 2% | SF err | Note |
|---|---|---|---|---|---|---|---|
| 2026-10-03 | 61 | 1 (Gundersen) | 45% | 5% | 0% | — | Baseline, ungrouped open plan |
| 2026-10-04 | 61 | 1 (Gundersen) | 69% | 9% | 0% | 12% | Open plan grouped per convention; partial reference |

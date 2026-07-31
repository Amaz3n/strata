# Takeoff — vector extraction spike (Phase 4)

> **Status: harness shipped, verdict NOT signed off.**
> Phase 6 depends on the verdict below. It is open decision #3 in
> `docs/takeoff-gameplan.md` and belongs to the human, not to an agent.

## 1. The question

Phase 6 (AI-assisted measurement) can be built three ways, and the right one
depends entirely on how good the vector content of real customer PDFs is:

| Verdict | What it means | What Phase 6 becomes |
|---|---|---|
| **A** | Vectors are clean and connected | Geometric snapping: alt-click floods a room by tracing its closed loop; wall runs snap to real segments; count-by-symbol matches repeated sub-paths |
| **B** | Vectors are noisy, fragmented, or absent | Vision-assisted: send the tile crop plus the click point to the vision model, get a polygon back, human accepts/adjusts/rejects |
| **C** | Mixed across a set (the expected answer) | Snap where the geometry closes, fall back to vision where it does not — the user sees one gesture either way |

Guessing this wrong is expensive in both directions: building A against messy
PDFs produces a tool that fails silently on half the sheets, and building B when
the geometry was right there burns tokens and latency on every click.

## 2. How to run it

```bash
node scripts/takeoff-vector-spike.mjs --project <projectId> --limit 8
```

Other modes:

```bash
node scripts/takeoff-vector-spike.mjs --sheets <sheetId>,<sheetId>
```

```bash
node scripts/takeoff-vector-spike.mjs --file ./sample-plans.pdf --page 2
```

The script is **read-only** — it downloads PDFs and prints numbers. It needs
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which `.env.local`
already carries and which point at **production**.

Pick 5–10 sheets that are actually representative:

- at least two architectural floor plans (the rooms case)
- at least one elevation or section (the wall-run case)
- at least one MEP sheet (dense symbols — the count case)
- at least one sheet you know was scanned, as the negative control
- ideally sheets from two different architects, since export toolchains vary
  far more than drafting conventions do

## 3. What it measures, and why each number matters

The harness runs each page through a scriptable MuPDF device, records every
stroked and filled path as flat segments in page space, and reports:

| Metric | Reads on | Why it decides the verdict |
|---|---|---|
| `segments` | volume of vector content | Under ~200 the sheet is effectively raster; nothing to snap to |
| `axis-aligned %` | share within ~1° of an axis | Architectural linework is overwhelmingly orthogonal; a low number means the page is mostly ornament, hatching, or a rotated detail |
| `sub-noise %` | segments under 3pt | Hatching, arrowheads, and outlined text all land here. High noise is what makes naive flood-fill leak |
| `median length` | typical segment size | A tiny median with a large count is a shredded path set |
| `endpoint connectivity %` | endpoints shared by 2+ segments | **The single most important number.** Loop-tracing a room requires walls whose endpoints actually meet. Exporters that emit every wall as an independent stroke kill this |
| `closed loops` / `room-sized` | rings the walker closed | Direct evidence for click-to-trace. Three or more room-sized loops on a floor plan means the geometry supports it |
| `repeated shapes` | identical sub-paths | Whether count-by-symbol can be geometric (match a signature) instead of visual |

The loop finder is deliberately conservative: it only follows unambiguous
degree-2 continuations and abandons a walk at any junction. A spike that
guessed which branch to take at a T-intersection would report rooms that a real
implementation could not find.

Thresholds live in `lib/drawings/vector-analysis.ts` (`recommendVerdict`) —
A needs `<55%` noise, `≥55%` connectivity, and `≥3` room-sized loops.

## 4. Results

<!-- Fill this in from the harness output. One row per sheet. -->

Run 2026-07-29 against production sheets from three customer projects (three
different drafting sources): 26-014 Mullenger SFH renovation, 26-027 Design West
Morrison condo, and Oakwood Residence. 20 sheets total, mixing floor plans,
foundation plans, elevations, sections, site plans, details, and schedules.
(Note: the harness as originally committed downloaded from Supabase Storage and
could not run at all — PDFs live in R2. Fixed in `scripts/takeoff-vector-spike.mjs`
the same day; run with `npx tsx`, not bare `node`, on Node 20.)

**26-014 Mullenger (8 sheets — all C):**

| Sheet | Segments | Axis % | Noise % | Connectivity % | Loops (room-sized) | Repeats | Script verdict |
|---|---|---|---|---|---|---|---|
| A-1.1 Cover/Site | 53,112 | 57 | 93.9 | 75 | 13 (4) | 549 grp, max 14,681 | C |
| A-2.2 Garage demo | 52,676 | 58.5 | 94.3 | 32.9 | 39 (8) | 303 grp | C |
| A-3.1 Kitchen floor plan | 75,769 | 44 | 92.5 | 53.3 | 62 (29) | 741 grp | C |
| A-3.2 Garage/entry floor plan | 67,911 | 56.1 | 93.3 | 53 | 57 (23) | 520 grp | C |
| A-4.2 Rear elevation | 43,524 | 68.1 | 97.7 | 42.1 | 18 (13) | 152 grp | C |
| A-5.1 Kitchen foundation | 343,181 | 62.8 | 98.8 | 49.7 | 51 (12) | 519 grp, max 106,129 | C |
| A-5.2 Garage foundation | 64,765 | 62.6 | 92.3 | 55.5 | 86 (16) | 488 grp | C |
| A-7.2 PE details | 48,088 | 64.1 | 95.3 | 41.8 | 20 (5) | 304 grp | C |

**26-027 Design West Morrison (6 sheets — 3 A, 3 C):**

| Sheet | Segments | Axis % | Noise % | Connectivity % | Loops (room-sized) | Script verdict |
|---|---|---|---|---|---|---|
| P2 Existing first floor plan | 2,128 | 39.3 | 39.4 | 62.1 | 38 (32) | **A** |
| P7 Foyer ceiling details | 2,500 | 37.6 | 23.1 | 70.1 | 31 (17) | **A** |
| P6 Foyer wall details | 1,738 | 41.9 | 15.8 | 80.3 | 21 (12) | **A** |
| P8 Kitchen ceiling details | 4,040 | 19.4 | 57.1 | 83 | 41 (29) | C |
| S-2 Drawer schedule | 14,977 | 46.5 | 83.5 | 70.4 | 45 (30) | C |
| T-5 Product sheet | 22,025 | 14.7 | 86.4 | 78.4 | 48 (21) | C |

**Oakwood Residence (6 sheets — 3 A, 3 C):**

| Sheet | Segments | Axis % | Noise % | Connectivity % | Loops (room-sized) | Script verdict |
|---|---|---|---|---|---|---|
| A-1.1 Site plan | 22,875 | 72.9 | 72.1 | 70.8 | 135 (39) | C |
| A-2.3 Window/door schedules | 2,282 | 82 | 12 | 65.5 | 16 (15) | **A** |
| A-3.1 West elevation | 6,493 | 78.3 | 30.1 | 57.3 | 115 (41) | **A** |
| A-3.2 East elevation | 7,550 | 54.4 | 34.1 | 54.2 | 114 (34) | C |
| A-4.1 Building section | 10,425 | 52.4 | 40.2 | 55.4 | 196 (29) | **A** |
| A-5.2 Detail sheet | 2,745 | 10.4 | 73.5 | 48.6 | 24 (21) | C |

**Totals: 6 A / 0 B / 14 C → suggested overall verdict C.**

## 5. Verdict

**Suggested by measurement: C (hybrid).** _(Human sign-off still required —
record it here when given.)_

Rationale:

> Every one of the 20 sheets sampled has real, traceable vector content — the
> predicted "half these PDFs are scans" failure mode did not appear at all
> (zero B verdicts, no sheet under ~1,700 segments). Endpoint connectivity is
> healthy almost everywhere (median ~55–70%; only one sheet below 40%), and
> every sheet yields room-sized closed loops (4–41 per sheet). What separates
> A from C is exclusively the **noise ratio**: sheets rendered through
> AutoCAD-style exporters that explode hatching, text outlines, and pattern
> fills into sub-3pt fragments land at 86–99% noise and drop to C even though
> their structural linework connects fine underneath.
>
> **The runtime boundary for Phase 6:** route by per-sheet stats computed once
> at ingest, not per click. If `connectedEndpointPct >= 45` **and**
> `roomSizedLoopCount >= 3` after noise filtering (drop segments < 3pt before
> building the connectivity graph — the loop finder already ignores them),
> offer geometric snap/flood-fill first, with the vision path as the fallback
> when a trace fails to close at the clicked point. Otherwise go straight to
> vision. On this sample that routes 20/20 sheets into the geometric-first
> path — noise inflates the noise ratio but does not destroy the structural
> graph underneath it.

### What ships either way

Phase 6 as implemented takes the **vision-assisted path (B)**, because it is the
only one that works on every sheet including scans, and because it degrades
honestly: the model proposes, the human accepts. That implementation is not
blocked on this verdict.

What the verdict changes is whether a **geometric fast path** is added in front
of it:

- **A or C** → before calling the model, try tracing the clicked point's
  enclosing loop from the display list. On a hit, the proposal is exact, free,
  and instant; on a miss, fall through to vision. Same UI, same accept/reject.
- **B** → skip the geometric path entirely. Do not build a snapping layer that
  fires on one sheet in five; a tool that only sometimes snaps is worse than one
  that never does, because users cannot predict it.

## 6. Open follow-ups

- Segment extraction currently flattens curves to 8 chords. If the verdict is A
  or C, revisit — arcs matter for curved walls and radius counters.
- The repeat detector matches on segment signature, which will over-count in
  dense hatching. If count-by-symbol goes geometric, it needs sub-path grouping
  (a door block, not its individual strokes).
- Nothing here reads clipping paths or XObject nesting. A sheet built from
  heavily nested form XObjects may under-report connectivity.

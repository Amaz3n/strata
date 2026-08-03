# Takeoff — the quantity model

> Reference. True as of 2026-08-02. Read this before touching
> `lib/drawings/measure.ts`, `lib/drawings/condition-rollup.ts`, or
> `lib/services/takeoff*.ts`.
>
> Companion docs: `docs/takeoff-reanchor-design.md` (what happens to
> measurements when a revision publishes) and `docs/takeoff-vector-spike.md`
> (whether real PDFs have linework worth snapping to).

## 1. Two units, not one

A drawing is flat. Clicking on one can only ever produce a **length, an area, or
a count** — that is `MeasureUom` (`lf | sf | ea`), and it is what
`drawing_markups.uom` stores.

A condition reports something wider — `ConditionUom`
(`lf | sf | ea | cy | sy | sq | ton`) — because an estimator prices concrete in
cubic yards, carpet in square yards, roofing in squares and gravel in tons. The
difference between the two units is closed by a **factor**: one number the
estimator already knows and the drawing cannot supply.

```
takeoff_conditions.uom          what the condition REPORTS  → the estimate line
conditionSourceUom(uom, factors) what its members MEASURE   → the markup guard
```

**A condition has exactly ONE source unit.** Never a mix. Letting an SF
condition sum both SF polygons and height-factored LF runs would make
"1,240 LF → 9,920 SF" a lie the moment someone added a gable polygon, and there
would be no honest way to display the conversion.

## 2. The four factors

| Column | Unit | Legal on | Effect |
|---|---|---|---|
| `depth_in` | inches | `cy`, `ton` (required) | plan SF → CF → CY |
| `tons_per_cy` | tons/CY | `ton` (required) | CY → tons |
| `height_ft` | feet | `sf` only | source flips to **LF**; run × height → SF |
| `pitch_rise` | rise per 12 | `sf`, `sq` | plan area × √(1+(rise/12)²) |

`height_ft` and `pitch_rise` are mutually exclusive — a wall is not pitched, and
allowing both would make the source unit ambiguous.

These rules live in **three** places and must move together:

1. `takeoff_conditions_factor_units` — the SQL check constraint
   (`supabase/migrations/20260802120000_takeoff_factors_templates.sql`)
2. `factorRuleViolation()` — `lib/validation/takeoff.ts`, which turns each rule
   into a sentence an estimator can act on
3. `conditionSourceUom()` / `convertToConditionUom()` — `lib/drawings/measure.ts`

The `ConditionUom` enum itself lives in those same three: the DB check, the Zod
`conditionUomSchema`, and the TS type. Any unit change touches all three.

**Changing `uom` is forbidden after creation** (it would orphan every member).
**Changing a factor is allowed**, with one exception: setting or clearing
`height_ft` flips the source unit, so the service refuses it while the condition
still has measurements.

## 3. What counts, and what deliberately does not

`rollUpCondition()` in `lib/drawings/condition-rollup.ts` is the whole of it —
pure, and tested in `tests/takeoff-rollup.test.js` without a database, because
this is where geometry becomes money.

| Member state | Counted? | Why |
|---|---|---|
| on the sheet's current revision | yes | — |
| on a **superseded** version | no, `stale_markup_count` | a measurement taken on Rev 2 is not evidence about Rev 3 |
| **carried forward**, unconfirmed | no, `pending_review_count` | it is a question, not a quantity — see the re-anchor doc |
| on an **uncalibrated** sheet | `quantity` is null, `unscaled_markup_count` | measured, awaiting scale — never counted as zero |
| a **deduction** | yes, negatively | `style.deduction` on an `area`, stored as a negative quantity |

Order of operations, and it matters:

```
per member: measured quantity → convertToConditionUom()
     sum → clamp at 0 if net negative → applyWaste() → × rate
```

Conversion is per member because every conversion is a linear multiplier, so the
total is identical either way — but doing it per member is what lets the
per-sheet breakdown be reported in the condition's own unit without drifting
from the total on screen.

A condition whose deductions outrun its areas is **clamped to zero and flagged**
(`net_negative`). A negative estimate line is always a mistake, never an intent.

Every comparison of two quantities uses `QUANTITY_EPSILON`, never `===` —
`numeric` round-trips through Postgres as a string.

## 4. Honesty signals

Each of these exists because the alternative is a plausible-looking number:

- **`duplicate_suspect_sheets`** — two sheets contributing within 2% of each
  other. The signature of the same floor measured on the dimension plan and
  again on the finish plan. Advisory; two bedrooms really can match.
- **Local scale disagreement** (`detectLocalScaleDisagreement`, `lib/drawings/scale.ts`)
  — the dimensions PRINTED inside a measured region versus the sheet's
  calibration. Catches a 1/2" detail measured at the sheet's 1/4". Runs in the
  viewer against `text-runs.json`; advisory, never re-scales anything.
- **Sheet coverage** (`lib/services/takeoff-coverage.ts`) — which sheets nobody
  has measured or waived. Only the human's *declaration* is stored; "has
  measurements" is always derived, because a cached copy would go stale the
  first time someone deleted a markup.
- **The CSV export carries all of them as columns.** An export that dropped them
  would be a cleaner file and a worse document.

## 5. Count by example

`lib/drawings/symbol-match.ts` — geometric hashing over the extracted vectors,
running **in the viewer** against the same `vectors.bin` the snapping already
downloaded. No round trip, no tokens.

1. Segments around the click are the exemplar.
2. Its **rarest** segment (by length and angle bucket) becomes the anchor —
   every genuine occurrence contains one, so the candidate list is short.
3. Each candidate implies a translation; the placement passes if ≥70% of the
   exemplar's segments appear there. Run at 0/90/180/270°.

**`matches` includes the clicked symbol's own placement** (it matches at zero
translation). Callers must not add the click back — that is an off-by-one
straight into an estimate. The vision fallback is the opposite: its prompt asks
for every *other* occurrence, so there the click IS added back.

Vision (`lib/services/takeoff-assist.ts`) runs only when the geometry finds
nothing. Composite MEP symbols — a GFCI is a duplex plus a "GFI" tag — are
separated by `partitionByNearbyText()` rather than dropped, so the estimator
sees "12 found, 3 labelled differently" and decides.

Nothing is saved until a human accepts. Accepted points go through
`acceptSymbolMatches()`, which re-derives the quantity server-side and stamps
`style.generated = "symbol_match"`.

## 6. Templates

`takeoff_condition_templates` is a **library, not a link**. Applying one COPIES
it into the scope; editing the library never reprices a job already out to bid.
Color is not carried — it is identity on a sheet, claimed at apply time from
what the scope has free. Skips (name collisions, over the 200-condition cap) are
reported, never silent.

## 7. Deliberately not built

- **Assemblies** — one measurement producing many priced lines. Factors plus
  templates cover the bulk of residential need. Do not leave hooks.
- **A volume drawing tool.** Nobody measures a slab in 3D; they measure it in
  plan and say "4 inches".
- **Metric, formula fields, condition hierarchy, third-party cost books.**
- **Realtime collaboration.** The `updated_at` precondition on condition and
  template updates (`STALE_WRITE`) is a guard against silent last-write-wins,
  not a presence layer.

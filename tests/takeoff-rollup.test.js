require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  rollUpCondition,
  classifySyncRow,
  findDuplicateSuspects,
  CONDITION_SHEET_BREAKDOWN_CAP,
} = require("../lib/drawings/condition-rollup")
const {
  conditionSourceUom,
  convertToConditionUom,
  cubicYards,
  pitchFactor,
  computeMarkupQuantity,
  MEASURE_UOM_LABELS,
} = require("../lib/drawings/measure")
const { factorRuleViolation } = require("../lib/validation/takeoff")

/**
 * The rollup is where geometry becomes money, and every rule it enforces exists
 * because the alternative is a number that lies. These tests are written against
 * the lie each rule prevents, not against the implementation.
 */

function condition(overrides = {}) {
  return {
    id: "c1",
    name: "Test condition",
    uom: "sf",
    waste_pct: 0,
    unit_cost_cents: null,
    cost_code_id: null,
    depth_in: null,
    height_ft: null,
    pitch_rise: null,
    tons_per_cy: null,
    ...overrides,
  }
}

function member(overrides = {}) {
  return {
    id: "m1",
    condition_id: "c1",
    quantity: 100,
    drawing_sheet_id: "s1",
    sheet_number: "A-101",
    sheet_title: "First floor",
    is_current_version: true,
    pending_review: false,
    is_deduction: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Classification — what counts, and what deliberately does not
// ---------------------------------------------------------------------------

test("a measurement on a superseded revision is excluded, not silently summed", () => {
  const totals = rollUpCondition(
    condition(),
    [
      member({ id: "a", quantity: 100 }),
      member({ id: "b", quantity: 250, is_current_version: false }),
    ],
    null,
  )
  assert.equal(totals.measured_quantity, 100)
  assert.equal(totals.markup_count, 1)
  assert.equal(totals.stale_markup_count, 1)
})

test("a measurement carried forward by a revision does not count until confirmed", () => {
  const totals = rollUpCondition(
    condition(),
    [member({ id: "a", quantity: 100 }), member({ id: "b", quantity: 250, pending_review: true })],
    null,
  )
  assert.equal(totals.measured_quantity, 100)
  assert.equal(totals.pending_review_count, 1)
  // Neither counted NOR stale: it is a question about the new revision.
  assert.equal(totals.stale_markup_count, 0)
})

test("an unscaled measurement is reported as unscaled, never as zero-that-counts", () => {
  const totals = rollUpCondition(
    condition(),
    [member({ id: "a", quantity: 100 }), member({ id: "b", quantity: null })],
    null,
  )
  assert.equal(totals.measured_quantity, 100)
  assert.equal(totals.unscaled_markup_count, 1)
  // It is still a member — the panel says "2 measurements, 1 awaiting scale".
  assert.equal(totals.markup_count, 2)
})

test("waste is applied after summation, not per member", () => {
  const totals = rollUpCondition(
    condition({ waste_pct: 10 }),
    [member({ id: "a", quantity: 33.33 }), member({ id: "b", quantity: 33.33 })],
    null,
  )
  assert.equal(totals.measured_quantity, 66.66)
  assert.equal(totals.effective_quantity, 73.33)
})

// ---------------------------------------------------------------------------
// Deductions
// ---------------------------------------------------------------------------

test("a deduction subtracts and is counted separately", () => {
  const totals = rollUpCondition(
    condition(),
    [
      member({ id: "wall", quantity: 400 }),
      member({ id: "window", quantity: -35, is_deduction: true }),
    ],
    null,
  )
  assert.equal(totals.measured_quantity, 365)
  assert.equal(totals.deduction_count, 1)
  assert.equal(totals.net_negative, false)
})

test("deductions that outrun their areas clamp to zero and raise the flag", () => {
  const totals = rollUpCondition(
    condition({ waste_pct: 10 }),
    [
      member({ id: "wall", quantity: 100 }),
      member({ id: "oops", quantity: -400, is_deduction: true }),
    ],
    null,
  )
  assert.equal(totals.net_negative, true)
  assert.equal(totals.measured_quantity, 0)
  // Waste on a clamped zero must not resurrect a number.
  assert.equal(totals.effective_quantity, 0)
})

test("a deduction area measures negative, and only an area can", () => {
  const image = { width: 1000, height: 1000 }
  const square = [
    [0, 0],
    [0.1, 0],
    [0.1, 0.1],
    [0, 0.1],
  ]
  const plain = computeMarkupQuantity({ type: "area", points: square }, image, 0.1)
  const deducted = computeMarkupQuantity(
    { type: "area", points: square, style: { deduction: true } },
    image,
    0.1,
  )
  assert.equal(plain.quantity, 100)
  assert.equal(deducted.quantity, -100)

  // The flag on a non-area is ignored by the math (the schema rejects it too).
  const counted = computeMarkupQuantity(
    { type: "count", points: [[0.1, 0.1]], style: { deduction: true } },
    image,
    0.1,
  )
  assert.equal(counted.quantity, 1)
})

// ---------------------------------------------------------------------------
// Axis factors — the dimension the drawing cannot show
// ---------------------------------------------------------------------------

test("cubic yards come from plan area carried down through a depth", () => {
  // 1,080 SF at 4in = 1,080 × (4/12) / 27 = 13.33 CY.
  assert.equal(Math.round(cubicYards(1080, 4) * 100) / 100, 13.33)
  // No depth is zero, never NaN — a CY condition without one reports nothing
  // rather than a number nobody can trace.
  assert.equal(cubicYards(1080, null), 0)
})

test("a CY condition sums SF members and reports CY", () => {
  const slab = condition({ uom: "cy", depth_in: 4 })
  assert.equal(conditionSourceUom(slab.uom, slab), "sf")

  const totals = rollUpCondition(slab, [member({ quantity: 1080 })], null)
  assert.equal(totals.source_quantity, 1080)
  assert.equal(totals.source_uom, "sf")
  assert.equal(totals.measured_quantity, 13.33)
  assert.match(totals.conversion_summary, /1,080 SF/)
  assert.match(totals.conversion_summary, /4″ deep/)
})

test("a wall height turns a run walked in plan into square feet", () => {
  const drywall = condition({ uom: "sf", height_ft: 9 })
  // The source unit FLIPS to LF — that is the whole point, and it is what the
  // membership guard checks against.
  assert.equal(conditionSourceUom(drywall.uom, drywall), "lf")

  const totals = rollUpCondition(drywall, [member({ quantity: 120 })], null)
  assert.equal(totals.measured_quantity, 1080)
  assert.equal(totals.source_uom, "lf")
})

test("roof pitch adds back the area a plan view omits", () => {
  // 8/12: sqrt(1 + (8/12)^2) ≈ 1.2019.
  assert.equal(Math.round(pitchFactor(8) * 10000) / 10000, 1.2019)
  // A flat roof, or no pitch at all, must not change the number.
  assert.equal(pitchFactor(0), 1)

  const roof = condition({ uom: "sf", pitch_rise: 8 })
  const totals = rollUpCondition(roof, [member({ quantity: 2000 })], null)
  assert.equal(totals.measured_quantity, 2403.7)
  // Pitch never changes what you trace — it is still a plan area.
  assert.equal(totals.source_uom, "sf")
})

test("squares, square yards and tons restate the same measured area", () => {
  assert.equal(convertToConditionUom(2000, "sq", { pitch_rise: null }), 20)
  assert.equal(convertToConditionUom(900, "sy", {}), 100)
  // 1,080 SF at 6in = 20 CY; at 1.4 t/CY = 28 tons.
  assert.equal(
    Math.round(convertToConditionUom(1080, "ton", { depth_in: 6, tons_per_cy: 1.4 }) * 100) / 100,
    28,
  )
})

test("converting per member equals converting the sum", () => {
  const slab = condition({ uom: "cy", depth_in: 4 })
  const split = rollUpCondition(
    slab,
    [member({ id: "a", quantity: 540 }), member({ id: "b", quantity: 540 })],
    null,
  )
  const whole = rollUpCondition(slab, [member({ quantity: 1080 })], null)
  assert.equal(split.measured_quantity, whole.measured_quantity)
})

test("every unit a condition can report has a label", () => {
  for (const uom of ["lf", "sf", "ea", "cy", "sy", "sq", "ton"]) {
    assert.ok(MEASURE_UOM_LABELS[uom], `${uom} has no label`)
  }
})

// ---------------------------------------------------------------------------
// Factor rules — the constraint, said as a sentence
// ---------------------------------------------------------------------------

test("a volume condition without a depth is refused, with a reason", () => {
  assert.match(factorRuleViolation({ uom: "cy" }), /needs a depth/)
  assert.match(factorRuleViolation({ uom: "ton", depth_in: 4 }), /density/)
  assert.equal(factorRuleViolation({ uom: "cy", depth_in: 4 }), null)
})

test("a factor may not ride on a unit it means nothing for", () => {
  assert.match(factorRuleViolation({ uom: "lf", height_ft: 9 }), /reported in SF/)
  assert.match(factorRuleViolation({ uom: "ea", depth_in: 4 }), /CY or tons/)
  assert.match(factorRuleViolation({ uom: "sf", height_ft: 9, pitch_rise: 8 }), /not both/)
})

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

test("rate resolution is pinned, then cost code, then nothing", () => {
  const costCode = {
    id: "cc",
    code: "09-650",
    name: "Resilient flooring",
    unit: "sf",
    default_unit_cost_cents: 405,
  }

  const pinned = rollUpCondition(
    condition({ unit_cost_cents: 500, cost_code_id: "cc" }),
    [member({ quantity: 100 })],
    costCode,
  )
  assert.equal(pinned.rate_source, "pinned")
  assert.equal(pinned.extended_cents, 50000)

  const fallback = rollUpCondition(
    condition({ cost_code_id: "cc" }),
    [member({ quantity: 100 })],
    costCode,
  )
  assert.equal(fallback.rate_source, "cost_code")
  assert.equal(fallback.extended_cents, 40500)

  const unpriced = rollUpCondition(condition(), [member({ quantity: 100 })], null)
  assert.equal(unpriced.rate_source, null)
  assert.equal(unpriced.extended_cents, null)
})

test("a zero pinned rate is a decision, not a missing rate", () => {
  const totals = rollUpCondition(
    condition({ unit_cost_cents: 0, cost_code_id: "cc" }),
    [member({ quantity: 100 })],
    { id: "cc", code: "x", name: "y", unit: null, default_unit_cost_cents: 999 },
  )
  assert.equal(totals.rate_source, "pinned")
  assert.equal(totals.extended_cents, 0)
})

// ---------------------------------------------------------------------------
// Sheet breakdown and the double-count signal
// ---------------------------------------------------------------------------

test("the per-sheet breakdown is in the reporting unit and sums to the total", () => {
  const slab = condition({ uom: "cy", depth_in: 6 })
  const totals = rollUpCondition(
    slab,
    [
      member({ id: "a", quantity: 540, drawing_sheet_id: "s1", sheet_number: "A-101" }),
      member({ id: "b", quantity: 270, drawing_sheet_id: "s2", sheet_number: "A-102" }),
    ],
    null,
  )
  const sheetSum = totals.sheets.reduce((sum, sheet) => sum + sheet.quantity, 0)
  assert.equal(Math.round(sheetSum * 100) / 100, totals.measured_quantity)
})

test("the sheet breakdown truncates visibly rather than silently", () => {
  const members = Array.from({ length: CONDITION_SHEET_BREAKDOWN_CAP + 3 }, (_, index) =>
    member({
      id: `m${index}`,
      quantity: 100 - index,
      drawing_sheet_id: `s${index}`,
      sheet_number: `A-${100 + index}`,
    }),
  )
  const totals = rollUpCondition(condition(), members, null)
  assert.equal(totals.sheets.length, CONDITION_SHEET_BREAKDOWN_CAP)
  assert.equal(totals.sheets_truncated, 3)
  // The TOTAL still covers every sheet — only the itemisation is capped.
  assert.equal(totals.markup_count, CONDITION_SHEET_BREAKDOWN_CAP + 3)
})

test("two sheets contributing the same quantity are flagged as a possible double count", () => {
  const totals = rollUpCondition(
    condition(),
    [
      member({ id: "a", quantity: 1240, drawing_sheet_id: "s1", sheet_number: "A-201" }),
      member({ id: "b", quantity: 1245, drawing_sheet_id: "s2", sheet_number: "A-301" }),
    ],
    null,
  )
  assert.deepEqual(totals.duplicate_suspect_sheets, ["A-201", "A-301"])
})

test("genuinely different sheets are not flagged, and one sheet never is", () => {
  const spread = rollUpCondition(
    condition(),
    [
      member({ id: "a", quantity: 1240, drawing_sheet_id: "s1", sheet_number: "A-201" }),
      member({ id: "b", quantity: 700, drawing_sheet_id: "s2", sheet_number: "A-301" }),
    ],
    null,
  )
  assert.deepEqual(spread.duplicate_suspect_sheets, [])
  assert.deepEqual(findDuplicateSuspects([{ sheet_number: "A-1", quantity: 100 }]), [])
  // Zero-quantity sheets must not match each other.
  assert.deepEqual(
    findDuplicateSuspects([
      { sheet_number: "A-1", quantity: 0 },
      { sheet_number: "A-2", quantity: 0 },
    ]),
    [],
  )
})

// ---------------------------------------------------------------------------
// Sync classification — the hand-edit guard
// ---------------------------------------------------------------------------

test("a line nobody has touched updates, and an identical one is left alone", () => {
  assert.equal(
    classifySyncRow({ nextQuantity: 120, liveQuantity: 100, lastSyncedQuantity: 100 }),
    "update",
  )
  assert.equal(
    classifySyncRow({ nextQuantity: 100, liveQuantity: 100, lastSyncedQuantity: 100 }),
    "unchanged",
  )
})

test("no destination line means create", () => {
  assert.equal(
    classifySyncRow({ nextQuantity: 120, liveQuantity: null, lastSyncedQuantity: null }),
    "create",
  )
})

test("a line edited by hand since the last sync is drift, and stays drift", () => {
  // Someone typed 150 over the 100 the sync wrote.
  assert.equal(
    classifySyncRow({ nextQuantity: 120, liveQuantity: 150, lastSyncedQuantity: 100 }),
    "drift",
  )
  // Even when the takeoff now agrees with the hand-edit: the estimator still
  // has to be told their number is being replaced by an identical one.
  assert.equal(
    classifySyncRow({ nextQuantity: 150, liveQuantity: 150, lastSyncedQuantity: 100 }),
    "drift",
  )
})

test("quantity comparisons use the epsilon, so a numeric round-trip is not drift", () => {
  assert.equal(
    classifySyncRow({ nextQuantity: 100, liveQuantity: 100.001, lastSyncedQuantity: 100 }),
    "unchanged",
  )
  assert.equal(
    classifySyncRow({ nextQuantity: 100, liveQuantity: 100.01, lastSyncedQuantity: 100 }),
    "drift",
  )
})

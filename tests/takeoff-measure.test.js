require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  computeMarkupQuantity,
  measurementLabel,
  polygonAreaPx,
  polygonPerimeterPx,
  polylineLengthPx,
  segmentLengthPx,
  centroidPx,
  applyWaste,
  extendedCents,
  formatQuantityWithUom,
  isMeasuringMarkupType,
} = require("../lib/drawings/measure")
const {
  CONDITION_COLORS,
  conditionColorAt,
  nextConditionColor,
} = require("../lib/drawings/takeoff-palette")

// A 1000x800 rendered sheet at 1/4" = 1'-0" would put ~0.04 ft in every pixel;
// the round number keeps the arithmetic checkable by hand.
const IMAGE = { width: 1000, height: 800 }
const FEET_PER_PX = 0.1 // 1 px = 0.1 ft, so 10 px = 1 ft

// ---------------------------------------------------------------------------
// Primitive geometry
// ---------------------------------------------------------------------------

test("segment length is plain euclidean distance", () => {
  assert.equal(segmentLengthPx({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
})

test("polyline length sums every leg, not just endpoints", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]
  assert.equal(polylineLengthPx(pts), 30)
  // A single point measures nothing rather than throwing.
  assert.equal(polylineLengthPx([{ x: 5, y: 5 }]), 0)
})

test("shoelace area handles a rectangle, an L-shape, and reversed winding", () => {
  const rect = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 0, y: 10 },
  ]
  assert.equal(polygonAreaPx(rect), 200)

  // Same ring wound the other way: area is unsigned.
  assert.equal(polygonAreaPx([...rect].reverse()), 200)

  // L-shape: 20x20 square minus a 10x10 bite = 300.
  const ell = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 20 },
    { x: 0, y: 20 },
  ]
  assert.equal(polygonAreaPx(ell), 300)
})

test("a polygon with fewer than three points has no area", () => {
  assert.equal(polygonAreaPx([{ x: 0, y: 0 }, { x: 5, y: 5 }]), 0)
})

test("polygon perimeter closes the ring back to the start point", () => {
  const rect = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 0, y: 10 },
  ]
  assert.equal(polygonPerimeterPx(rect), 60)
})

test("centroid averages the vertices and is null for an empty ring", () => {
  assert.deepEqual(centroidPx([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), {
    x: 5,
    y: 5,
  })
  assert.equal(centroidPx([]), null)
})

// ---------------------------------------------------------------------------
// Quantity computation
// ---------------------------------------------------------------------------

test("a dimension measures linear feet between its two points", () => {
  // 0.0 -> 0.3 across a 1000px sheet = 300px = 30 ft.
  const measured = computeMarkupQuantity(
    { type: "dimension", points: [[0, 0], [0.3, 0]] },
    IMAGE,
    FEET_PER_PX,
  )
  assert.deepEqual(measured, { quantity: 30, uom: "lf" })
})

test("a polyline measures the whole run, corners included", () => {
  const measured = computeMarkupQuantity(
    { type: "polyline", points: [[0, 0], [0.2, 0], [0.2, 0.25]] },
    IMAGE,
    FEET_PER_PX,
  )
  // 200px + 200px (0.25 * 800) = 400px = 40 ft.
  assert.deepEqual(measured, { quantity: 40, uom: "lf" })
})

test("an area scales with the SQUARE of the linear scale", () => {
  const measured = computeMarkupQuantity(
    { type: "area", points: [[0, 0], [0.2, 0], [0.2, 0.25], [0, 0.25]] },
    IMAGE,
    FEET_PER_PX,
  )
  // 200px x 200px = 40,000 px² -> 40,000 * 0.1 * 0.1 = 400 SF (20ft x 20ft).
  assert.deepEqual(measured, { quantity: 400, uom: "sf" })
})

test("a count is the number of points and needs no calibration at all", () => {
  const points = [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]]
  assert.deepEqual(computeMarkupQuantity({ type: "count", points }, IMAGE, null), {
    quantity: 3,
    uom: "ea",
  })
  assert.deepEqual(computeMarkupQuantity({ type: "count", points }, null, null), {
    quantity: 3,
    uom: "ea",
  })
})

test("length and area yield no quantity on an uncalibrated sheet", () => {
  assert.equal(computeMarkupQuantity({ type: "dimension", points: [[0, 0], [1, 0]] }, IMAGE, null), null)
  assert.equal(computeMarkupQuantity({ type: "area", points: [[0, 0], [1, 0], [1, 1]] }, IMAGE, 0), null)
})

test("non-measuring markup types never produce a quantity", () => {
  for (const type of ["arrow", "circle", "rectangle", "text", "freehand", "callout", "cloud", "highlight"]) {
    assert.equal(isMeasuringMarkupType(type), false, `${type} should not measure`)
    assert.equal(computeMarkupQuantity({ type, points: [[0, 0], [1, 1]] }, IMAGE, FEET_PER_PX), null)
  }
})

test("degenerate geometry measures nothing instead of returning zero", () => {
  assert.equal(computeMarkupQuantity({ type: "polyline", points: [[0.5, 0.5]] }, IMAGE, FEET_PER_PX), null)
  assert.equal(computeMarkupQuantity({ type: "area", points: [[0, 0], [1, 1]] }, IMAGE, FEET_PER_PX), null)
  assert.equal(computeMarkupQuantity({ type: "count", points: [] }, IMAGE, FEET_PER_PX), null)
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test("labels read as a builder reads a plan", () => {
  assert.equal(
    measurementLabel({ type: "dimension", points: [[0, 0], [0.245, 0]] }, IMAGE, FEET_PER_PX),
    `24'-6"`,
  )
  assert.equal(
    measurementLabel({ type: "area", points: [[0, 0], [0.2, 0], [0.2, 0.25], [0, 0.25]] }, IMAGE, FEET_PER_PX),
    "400 SF",
  )
  assert.equal(measurementLabel({ type: "count", points: [[0, 0], [0.1, 0.1]] }, IMAGE, null), "2")
})

test("uncalibrated length labels fall back to rendered pixels", () => {
  assert.equal(measurementLabel({ type: "dimension", points: [[0, 0], [0.3, 0]] }, IMAGE, null), "300px")
  assert.equal(
    measurementLabel({ type: "area", points: [[0, 0], [0.2, 0], [0.2, 0.25], [0, 0.25]] }, IMAGE, null),
    "40,000px²",
  )
})

test("quantity formatting is stable for panels and estimate lines", () => {
  assert.equal(formatQuantityWithUom(1240.5, "sf"), "1,240.5 SF")
  assert.equal(formatQuantityWithUom(12, "ea"), "12 EA")
})

// ---------------------------------------------------------------------------
// Waste + extension
// ---------------------------------------------------------------------------

test("waste is a percentage uplift rounded to two decimals", () => {
  assert.equal(applyWaste(1000, 10), 1100)
  assert.equal(applyWaste(1000, 0), 1000)
  assert.equal(applyWaste(333.333, 7.5), 358.33)
})

test("extended cost stays in integer cents", () => {
  assert.equal(extendedCents(1240.5, 415), 514808)
  assert.equal(extendedCents(100, null), 0)
})

// ---------------------------------------------------------------------------
// Condition palette
// ---------------------------------------------------------------------------

test("the condition palette is twelve stable, unique colors", () => {
  assert.equal(CONDITION_COLORS.length, 12)
  assert.equal(new Set(CONDITION_COLORS).size, 12)
  assert.equal(conditionColorAt(0), CONDITION_COLORS[0])
  // Wraps rather than running off the end.
  assert.equal(conditionColorAt(12), CONDITION_COLORS[0])
  assert.equal(conditionColorAt(-3), CONDITION_COLORS[0])
})

test("a new condition takes the first color nobody is using", () => {
  assert.equal(nextConditionColor([]), CONDITION_COLORS[0])
  assert.equal(nextConditionColor([CONDITION_COLORS[0]]), CONDITION_COLORS[1])
  // Case-insensitive: stored values may round-trip lowercased.
  assert.equal(nextConditionColor([CONDITION_COLORS[0].toLowerCase()]), CONDITION_COLORS[1])
  // Past twelve it wraps instead of returning undefined.
  assert.ok(CONDITION_COLORS.includes(nextConditionColor(CONDITION_COLORS)))
})

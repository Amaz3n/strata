require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  boundsOfPoints,
  padBox,
  boxesIntersect,
  boxArea,
  matchItemsToRegions,
  changeSeverity,
  rankClassifiedRegions,
  summarizeRevisionImpact,
  isQuantityBearing,
  CHANGE_KINDS,
} = require("../lib/drawings/change-impact")

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function assertBox(actual, expected, message) {
  for (const key of ["x", "y", "w", "h"]) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 1e-9,
      `${message ?? "box"}.${key}: ${actual[key]} !== ${expected[key]}`,
    )
  }
}

test("bounds wrap every point of a run", () => {
  const box = boundsOfPoints([
    [0.2, 0.4],
    [0.6, 0.1],
    [0.3, 0.9],
  ])
  assertBox(box, { x: 0.2, y: 0.1, w: 0.4, h: 0.8 })
})

test("a single-point count markup has zero-size bounds, not null", () => {
  const box = boundsOfPoints([[0.5, 0.5]])
  assert.deepEqual(box, { x: 0.5, y: 0.5, w: 0, h: 0 })
})

test("no points means no bounds", () => {
  assert.equal(boundsOfPoints([]), null)
})

test("non-finite coordinates are skipped rather than poisoning the bounds", () => {
  const box = boundsOfPoints([
    [Number.NaN, 0.5],
    [0.2, 0.3],
    [0.4, 0.7],
  ])
  assertBox(box, { x: 0.2, y: 0.3, w: 0.2, h: 0.4 })
})

test("all-garbage points yield null instead of an infinite box", () => {
  assert.equal(boundsOfPoints([[Number.NaN, Number.NaN]]), null)
})

test("touching boxes count as intersecting — a coarse grid edge is not a gap", () => {
  const a = { x: 0, y: 0, w: 0.5, h: 0.5 }
  const b = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }
  assert.equal(boxesIntersect(a, b), true)
})

test("separated boxes do not intersect", () => {
  const a = { x: 0, y: 0, w: 0.2, h: 0.2 }
  const b = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }
  assert.equal(boxesIntersect(a, b), false)
})

test("padding is symmetric and grows the box", () => {
  const padded = padBox({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, 0.02)
  assertBox(padded, { x: 0.38, y: 0.38, w: 0.14, h: 0.14 })
})

test("area ignores negative dimensions", () => {
  assert.equal(boxArea({ x: 0, y: 0, w: -1, h: 0.5 }), 0)
  assert.equal(boxArea({ x: 0, y: 0, w: 0.5, h: 0.4 }), 0.2)
})

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const REGIONS = [
  { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, // 0
  { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, // 1
]

test("a record inside a region is matched to it", () => {
  const matches = matchItemsToRegions(REGIONS, [
    { item: "wall-a", box: { x: 0.15, y: 0.15, w: 0.02, h: 0.02 } },
  ])
  assert.equal(matches.length, 1)
  assert.deepEqual(matches[0].regionIndexes, [0])
})

test("a record far from every region is not reported at all", () => {
  const matches = matchItemsToRegions(REGIONS, [
    { item: "wall-b", box: { x: 0.45, y: 0.45, w: 0.01, h: 0.01 } },
  ])
  assert.equal(matches.length, 0)
})

test("a run crossing two edits is matched to both, in region order", () => {
  const matches = matchItemsToRegions(REGIONS, [
    { item: "long-wall", box: { x: 0.15, y: 0.15, w: 0.6, h: 0.6 } },
  ])
  assert.deepEqual(matches[0].regionIndexes, [0, 1])
})

test("a near miss inside the pad is matched — a missed impact is the costly error", () => {
  // 0.005 outside region 0, well inside the 0.01 default pad.
  const matches = matchItemsToRegions(REGIONS, [
    { item: "edge-wall", box: { x: 0.305, y: 0.2, w: 0.001, h: 0.001 } },
  ])
  assert.equal(matches.length, 1)
})

test("a pad of zero makes matching strict", () => {
  const matches = matchItemsToRegions(
    REGIONS,
    [{ item: "edge-wall", box: { x: 0.305, y: 0.2, w: 0.001, h: 0.001 } }],
    0,
  )
  assert.equal(matches.length, 0)
})

test("a record with no geometry is skipped, not crashed on", () => {
  const matches = matchItemsToRegions(REGIONS, [{ item: "no-geom", box: null }])
  assert.equal(matches.length, 0)
})

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

test("moved linework over a priced measurement is the top of the list", () => {
  assert.equal(changeSeverity({ kind: "modified", affectedRecords: 4, areaShare: 0.001 }), "high")
  assert.equal(changeSeverity({ kind: "added", affectedRecords: 1, areaShare: 0.0001 }), "high")
  assert.equal(changeSeverity({ kind: "removed", affectedRecords: 2, areaShare: 0.5 }), "high")
})

test("a big re-plotted title block never outranks a small moved wall", () => {
  const titleblock = changeSeverity({ kind: "titleblock", affectedRecords: 0, areaShare: 0.3 })
  const wall = changeSeverity({ kind: "modified", affectedRecords: 3, areaShare: 0.001 })
  assert.equal(titleblock, "low")
  assert.equal(wall, "high")
})

test("an annotation over priced work is worth a look but not an alarm", () => {
  assert.equal(changeSeverity({ kind: "annotation", affectedRecords: 2, areaShare: 0.01 }), "medium")
  assert.equal(changeSeverity({ kind: "annotation", affectedRecords: 0, areaShare: 0.01 }), "low")
})

test("noise is always low, whatever it overlaps", () => {
  assert.equal(changeSeverity({ kind: "noise", affectedRecords: 9, areaShare: 0.9 }), "low")
})

test("substantive change with no records ranks on size", () => {
  assert.equal(changeSeverity({ kind: "added", affectedRecords: 0, areaShare: 0.05 }), "medium")
  assert.equal(changeSeverity({ kind: "added", affectedRecords: 0, areaShare: 0.001 }), "low")
})

test("every declared kind produces a severity", () => {
  for (const kind of CHANGE_KINDS) {
    const severity = changeSeverity({ kind, affectedRecords: 1, areaShare: 0.02 })
    assert.ok(["high", "medium", "low"].includes(severity), `${kind} -> ${severity}`)
  }
})

test("only added/removed/modified can move a quantity", () => {
  assert.equal(isQuantityBearing("modified"), true)
  assert.equal(isQuantityBearing("annotation"), false)
  assert.equal(isQuantityBearing("titleblock"), false)
  assert.equal(isQuantityBearing("noise"), false)
})

// ---------------------------------------------------------------------------
// Ranking and summary
// ---------------------------------------------------------------------------

function region(kind, severity, size, affectedRecords = 0) {
  return {
    region: { x: 0, y: 0, w: size, h: size },
    kind,
    summary: `${kind} ${size}`,
    severity,
    affectedRecords,
  }
}

test("ranking puts severity before size", () => {
  const ranked = rankClassifiedRegions([
    region("titleblock", "low", 0.5),
    region("modified", "high", 0.02, 3),
    region("annotation", "medium", 0.1, 1),
  ])
  assert.deepEqual(
    ranked.map((entry) => entry.kind),
    ["modified", "annotation", "titleblock"],
  )
})

test("within a severity, the bigger region leads", () => {
  const ranked = rankClassifiedRegions([
    region("modified", "high", 0.02, 1),
    region("added", "high", 0.2, 1),
  ])
  assert.equal(ranked[0].kind, "added")
})

test("ranking does not mutate the input", () => {
  const input = [region("titleblock", "low", 0.5), region("modified", "high", 0.02, 1)]
  const before = input.map((entry) => entry.kind)
  rankClassifiedRegions(input)
  assert.deepEqual(
    input.map((entry) => entry.kind),
    before,
  )
})

test("an all-annotation re-issue is reported as moving nothing priced", () => {
  const summary = summarizeRevisionImpact(
    [region("annotation", "low", 0.02), region("titleblock", "low", 0.1)],
    0,
  )
  assert.equal(summary.noSubstantiveChange, true)
  assert.equal(summary.substantiveRegions, 0)
  assert.equal(summary.incidentalRegions, 2)
})

test("one moved wall is enough to make a re-issue substantive", () => {
  const summary = summarizeRevisionImpact(
    [region("annotation", "low", 0.02), region("modified", "high", 0.01, 4)],
    4,
  )
  assert.equal(summary.noSubstantiveChange, false)
  assert.equal(summary.substantiveRegions, 1)
  assert.equal(summary.highSeverity, 1)
  assert.equal(summary.affectedRecords, 4)
})

test("a sheet with no regions is not claimed to be unchanged-but-checked", () => {
  // Nothing to classify means the headline has nothing to stand on.
  const summary = summarizeRevisionImpact([], 0)
  assert.equal(summary.noSubstantiveChange, false)
  assert.equal(summary.totalRegions, 0)
})

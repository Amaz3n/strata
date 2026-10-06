require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  matchLevelTakeoff,
  segmentAlongWall,
  roomAtSheetPoint,
  roomOutlineOnSheet,
} = require("../lib/drawings/model-takeoff")

// A 1000 x 500 px sheet at 0.04 ft/px: the image is 40' x 20'. Two rooms split
// at x = 20', so normalized x = 0.5 is the partition.
const source = {
  sheetVersionId: "v1",
  sheetNumber: "A-101",
  sheetTitle: null,
  imageWidth: 1000,
  imageHeight: 500,
  feetPerImagePx: 0.04,
  originPxX: 0,
  originPxY: 0,
}

function wall(id, x0, y0, x1, y1, thicknessFt = 0.5) {
  return { id, x0, y0, x1, y1, thicknessFt, confidence: 1, source: "paired" }
}

const level = {
  id: "L1",
  name: "Level 1",
  order: 1,
  ceilingHeightFt: 9,
  source,
  walls: [wall("w-partition", 20, 0, 20, 20, 0.35), wall("w-top", 0, 0, 40, 0)],
  openings: [],
  rooms: [
    { id: "r-living", polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], label: "Living", areaSqft: 400, confidence: 1 },
    { id: "r-kitchen", polygon: [[20, 0], [40, 0], [40, 20], [20, 20]], label: "Kitchen", areaSqft: 400, confidence: 1 },
  ],
  confidence: { walls: 1, openings: 1, rooms: 1 },
}

const conditions = [
  { id: "c-lvp", color: "#2A5CDA", heightFt: null },
  { id: "c-walls", color: "#05893E", heightFt: 9 },
  { id: "c-base", color: "#C96900", heightFt: null },
]

test("an area measurement that covers a room counts that room", () => {
  const map = matchLevelTakeoff(
    level,
    [{ id: "m1", type: "area", conditionId: "c-lvp", points: [[0.01, 0.01], [0.49, 0.01], [0.49, 0.99], [0.01, 0.99]] }],
    conditions,
  )
  assert.equal(map["r-living"].conditionId, "c-lvp")
  assert.equal(map["r-kitchen"], undefined)
})

test("an area far smaller than the room it sits in does not count the room", () => {
  const map = matchLevelTakeoff(
    level,
    [{ id: "m1", type: "area", conditionId: "c-lvp", points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]] }],
    conditions,
  )
  assert.deepEqual(map, {})
})

test("deductions and unassigned measurements never count a room", () => {
  const full = [[0.01, 0.01], [0.49, 0.01], [0.49, 0.99], [0.01, 0.99]]
  const map = matchLevelTakeoff(
    level,
    [
      { id: "m1", type: "area", conditionId: "c-lvp", points: full, deduction: true },
      { id: "m2", type: "area", conditionId: null, points: full },
    ],
    conditions,
  )
  assert.deepEqual(map, {})
})

test("a wall-height run along a wall counts the wall; a plain linear run does not", () => {
  const along = [[0.5, 0.02], [0.5, 0.98]]
  const map = matchLevelTakeoff(
    level,
    [
      { id: "m1", type: "polyline", conditionId: "c-walls", points: along },
      { id: "m2", type: "polyline", conditionId: "c-base", points: [[0.02, 0], [0.98, 0]] },
    ],
    conditions,
  )
  assert.equal(map["w-partition"].conditionId, "c-walls")
  assert.equal(map["w-top"], undefined)
})

test("a run that covers under half a wall leaves it unmeasured", () => {
  const map = matchLevelTakeoff(
    level,
    [{ id: "m1", type: "polyline", conditionId: "c-walls", points: [[0.5, 0], [0.5, 0.3]] }],
    conditions,
  )
  assert.equal(map["w-partition"], undefined)
})

test("segmentAlongWall ignores crossing and offset segments", () => {
  const w = wall("w", 0, 0, 10, 0)
  assert.equal(segmentAlongWall([2, 0.1], [8, 0.1], w), 6)
  assert.equal(segmentAlongWall([5, -3], [5, 3], w), 0)
  assert.equal(segmentAlongWall([2, 4], [8, 4], w), 0)
  assert.equal(segmentAlongWall([-5, 0], [3, 0], w), 3)
})

test("sheet point ↔ model room round-trips through the source sheet", () => {
  assert.equal(roomAtSheetPoint(level, { x: 0.75, y: 0.5 }).id, "r-kitchen")
  assert.equal(roomAtSheetPoint(level, { x: 0.25, y: 0.5 }).id, "r-living")
  assert.equal(roomAtSheetPoint(level, { x: 0.5, y: 1.5 }), null)
  const outline = roomOutlineOnSheet(level, "r-kitchen")
  assert.deepEqual(outline[0], [0.5, 0])
  assert.deepEqual(outline[2], [1, 1])
})

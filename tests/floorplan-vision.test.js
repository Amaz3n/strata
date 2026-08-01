require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  applyVisionProposal,
  buildFloorplanVisionPrompt,
  parseFloorplanVisionProposal,
  VISION_WALL_CONFIDENCE,
} = require("../lib/drawings/floorplan-vision")

// 2400 × 1800 px at 0.02 ft/px → a 48' × 36' image space.
const SOURCE = {
  sheetVersionId: "sv-1",
  sheetNumber: "A2.1",
  sheetTitle: "First Floor Plan",
  imageWidth: 2400,
  imageHeight: 1800,
  feetPerImagePx: 0.02,
  originPxX: 0,
  originPxY: 0,
}
const toNorm = (xFt, yFt) => ({ x: xFt / 48, y: yFt / 36 })

const wall = (id, x0, y0, x1, y1) => ({
  id,
  x0,
  y0,
  x1,
  y1,
  thicknessFt: 0.5,
  confidence: 0.9,
  source: "paired",
})

/** A 20' × 12' room MISSING its south wall — the screenshot failure mode. */
function openLevel() {
  return {
    id: "L0",
    name: "First Floor",
    order: 0,
    ceilingHeightFt: 9,
    source: SOURCE,
    walls: [
      wall("w1", 0, 0, 20, 0),
      wall("w2", 20, 0, 20, 12),
      wall("w3", 0, 0, 0, 12),
    ],
    openings: [],
    rooms: [],
    confidence: { walls: 0.9, openings: 0, rooms: 0 },
  }
}

test("the prompt pins the coordinate contract", () => {
  const prompt = buildFloorplanVisionPrompt("First Floor")
  assert.match(prompt, /normalized/i)
  assert.match(prompt, /First Floor/)
})

test("proposals parse through code fences and prose; garbage does not", () => {
  const fenced = 'Here you go:\n```json\n{"walls":[{"x0":0,"y0":0.5,"x1":0.4,"y1":0.5}],"rooms":[]}\n```'
  const parsed = parseFloorplanVisionProposal(fenced)
  assert.equal(parsed.walls.length, 1)
  assert.equal(parseFloorplanVisionProposal("no json here"), null)
  assert.equal(parseFloorplanVisionProposal('{"walls":[],"rooms":[]}'), null)
  // Out-of-range coordinates clamp instead of poisoning the level.
  const clamped = parseFloorplanVisionProposal('{"walls":[{"x0":-2,"y0":0.5,"x1":9,"y1":0.5}]}')
  assert.equal(clamped.walls[0].x0, 0)
  assert.equal(clamped.walls[0].x1, 1)
})

test("a wall only the vision model saw is added low-confidence and closes the room", () => {
  const a = toNorm(0.4, 12.3)
  const b = toNorm(19.7, 11.8)
  const result = applyVisionProposal(openLevel(), {
    walls: [{ x0: a.x, y0: a.y, x1: b.x, y1: b.y }],
    rooms: [],
  })
  assert.equal(result.addedWalls, 1)
  const bridge = result.level.walls.find((candidate) => candidate.id.startsWith("wv"))
  assert.ok(bridge)
  assert.equal(bridge.confidence, VISION_WALL_CONFIDENCE)
  // Its wobbly endpoints snapped onto the existing wall ends.
  assert.equal(result.level.rooms.length, 1, "the room closes once the wall lands")
})

test("a wall both sources found boosts confidence instead of duplicating", () => {
  const a = toNorm(0.2, 0.1)
  const b = toNorm(19.8, -0.1)
  const result = applyVisionProposal(openLevel(), {
    walls: [{ x0: a.x, y0: a.y, x1: b.x, y1: b.y }],
    rooms: [],
  })
  assert.equal(result.addedWalls, 0)
  assert.equal(result.confirmedWalls, 1)
  const confirmed = result.level.walls.find((candidate) => candidate.id === "w1")
  assert.ok(confirmed.confidence > 0.9)
  assert.equal(result.level.walls.length, 3)
})

test("vision room names label unnamed rooms, gated by the lexicon", () => {
  const south = toNorm(0.4, 12)
  const southEnd = toNorm(19.7, 12)
  const inside = toNorm(10, 6)
  const result = applyVisionProposal(openLevel(), {
    walls: [{ x0: south.x, y0: south.y, x1: southEnd.x, y1: southEnd.y }],
    rooms: [
      { x: inside.x, y: inside.y, label: `12'-0" x 10'-0"` },
      { x: inside.x, y: inside.y, label: "KITCHEN" },
    ],
  })
  assert.equal(result.labeledRooms, 1)
  assert.equal(result.level.rooms[0].label, "KITCHEN", "the dimension string never becomes a name")
})

test("a scan (no vector walls) accepts the whole tracing at vision confidence", () => {
  const level = { ...openLevel(), walls: [] }
  const strokes = [
    [0, 0, 20, 0],
    [20, 0, 20, 12],
    [20, 12, 0, 12],
    [0, 12, 0, 0],
  ].map(([x0, y0, x1, y1]) => {
    const a = toNorm(x0, y0)
    const b = toNorm(x1, y1)
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y }
  })
  const result = applyVisionProposal(level, { walls: strokes, rooms: [] }, { acceptAllWalls: true })
  assert.equal(result.addedWalls, 4)
  assert.ok(result.level.walls.every((candidate) => candidate.confidence === VISION_WALL_CONFIDENCE))
  assert.equal(result.level.rooms.length, 1, "a fully traced scan still closes its room")
})

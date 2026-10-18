require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { snapToWall, clearanceIssues, roomContaining, placeInRoom } = require("../lib/drawings/furniture-layout")
const { FURNITURE_CATALOG, furnitureModel, furnitureObject } = require("../lib/drawings/furniture-catalog")
const { modelChangeSchema } = require("../lib/drawings/model-options")

// A 20' x 14' room, 6" walls on their centrelines, a 3' door in the south wall.
function wall(id, x0, y0, x1, y1) {
  return { id, x0, y0, x1, y1, thicknessFt: 0.5, confidence: 1, source: "paired" }
}
const level = {
  walls: [wall("north", 0, 0, 20, 0), wall("east", 20, 0, 20, 14), wall("south", 20, 14, 0, 14), wall("west", 0, 14, 0, 0)],
  openings: [{ id: "door", wallId: "south", kind: "door", offsetFt: 2, widthFt: 3, sillFt: 0, headFt: 6.75, confidence: 1 }],
  rooms: [{ id: "living", polygon: [[0, 0], [20, 0], [20, 14], [0, 14]], label: "LIVING", areaSqft: 280, confidence: 1 }],
}
const sofa = (at) => ({ ...furnitureObject(furnitureModel("sofa_02"), at), id: at.id ?? "sofa" })

test("every catalogue piece has a real size, a fallback kind and a model file id", () => {
  const ids = new Set()
  for (const model of FURNITURE_CATALOG) {
    assert.ok(model.widthFt > 0.3 && model.depthFt > 0.3 && model.heightFt > 0.5, model.id)
    assert.ok(!ids.has(model.id), `duplicate ${model.id}`)
    ids.add(model.id)
  }
  assert.equal(furnitureModel("nope"), null)
})

test("a sofa near a wall turns its back to it and sits flush", () => {
  const snap = snapToWall(level, { xFt: 10, yFt: 2.4, widthFt: 5.93, depthFt: 2.68 })
  assert.equal(snap.wallId, "north")
  // Back (+z) faces the north wall (−y): rotation 180°.
  assert.equal(Math.abs(snap.rotationDeg), 180)
  assert.ok(Math.abs(snap.yFt - (0.25 + 2.68 / 2)) < 1e-6, "back on the wall face")
  assert.ok(Math.abs(snap.xFt - 10) < 1e-6)

  const east = snapToWall(level, { xFt: 18, yFt: 7, widthFt: 5.93, depthFt: 2.68 })
  assert.equal(east.wallId, "east")
  assert.ok(Math.abs(east.xFt - (20 - 0.25 - 1.34)) < 1e-6)
  assert.equal(east.rotationDeg, -90)
})

test("a piece is slid along the wall so it never overhangs the wall's end", () => {
  const snap = snapToWall(level, { xFt: 19.5, yFt: 2, widthFt: 5.93, depthFt: 2.68 }, 3)
  assert.ok(snap.xFt <= 20 - 5.93 / 2 + 1e-6 || snap.wallId === "east")
})

test("nothing to snap to in the middle of a big room", () => {
  assert.equal(snapToWall(level, { xFt: 10, yFt: 7, widthFt: 3, depthFt: 2 }), null)
})

test("clearance: overlap, door swing, wall crossing, outside, and front clearance", () => {
  const ok = { ...level, objects: [sofa({ xFt: 10, yFt: 0.25 + 1.34, rotationDeg: 180 })] }
  assert.deepEqual(clearanceIssues(ok), [])

  const overlap = { ...level, objects: [sofa({ xFt: 10, yFt: 7 }), { ...sofa({ xFt: 11, yFt: 7 }), id: "sofa-b" }] }
  assert.deepEqual(clearanceIssues(overlap).map((issue) => issue.code), ["overlap"])

  const door = { ...level, objects: [{ ...sofa({ xFt: 16.5, yFt: 12.5 }), widthFt: 2, depthFt: 1.5, modelId: undefined }] }
  assert.ok(clearanceIssues(door).some((issue) => issue.code === "door_swing"))

  const wallHit = { ...level, objects: [{ ...sofa({ xFt: 10, yFt: 0.5 }), modelId: undefined }] }
  assert.ok(clearanceIssues(wallHit).some((issue) => issue.code === "crosses_wall"))

  const outside = { ...level, objects: [{ ...sofa({ xFt: 40, yFt: 40 }), modelId: undefined }] }
  assert.deepEqual(clearanceIssues(outside).map((issue) => issue.code), ["outside"])

  // Sofa facing the north wall from 1' away: no room to sit.
  const cramped = { ...level, objects: [sofa({ xFt: 10, yFt: 0.25 + 1 + 1.34, rotationDeg: 0 })] }
  assert.ok(clearanceIssues(cramped).some((issue) => issue.code === "front_clearance"))
})

test("a coffee table in front of a sofa is a companion, not a blocked front", () => {
  const sofaAt = sofa({ xFt: 10, yFt: 0.25 + 1.34, rotationDeg: 180 })
  const table = { ...furnitureObject(furnitureModel("modern_coffee_table_01"), { xFt: 10, yFt: 4.6 }), id: "table" }
  assert.deepEqual(clearanceIssues({ ...level, objects: [sofaAt, table] }), [])
})

test("a wall piece goes against the room's longest wall, a free piece in the middle", () => {
  const room = level.rooms[0]
  const wallPiece = placeInRoom(level, room, { widthFt: 5.93, depthFt: 2.68 }, true)
  assert.ok(roomContaining(level, wallPiece.xFt, wallPiece.yFt))
  assert.ok(Math.abs(wallPiece.yFt - 1.59) < 1e-6 || Math.abs(wallPiece.yFt - (14 - 1.59)) < 1e-6, "on a long wall")
  const free = placeInRoom(level, room, { widthFt: 4, depthFt: 4 }, false)
  assert.ok(Math.abs(free.xFt - 10) < 3 && Math.abs(free.yFt - 7) < 3)
})

test("model changes validate against the finish and furniture catalogues", () => {
  assert.ok(modelChangeSchema.safeParse({ kind: "floor_finish", finish: "oak", rooms: ["Bedroom"], unitPriceCents: 1200 }).success)
  assert.ok(!modelChangeSchema.safeParse({ kind: "floor_finish", finish: "gold", rooms: [], unitPriceCents: 1 }).success)
  assert.ok(modelChangeSchema.safeParse({ kind: "furniture", modelId: "sofa_03", rooms: ["Family"], priceCents: 250000 }).success)
  assert.ok(!modelChangeSchema.safeParse({ kind: "furniture", modelId: "../etc", rooms: [], priceCents: 1 }).success)
})

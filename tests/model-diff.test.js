require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { diffLevel, estimateDelta } = require("../lib/drawings/model-diff")

const wall = (id, x0, y0, x1, y1) => ({ id, x0, y0, x1, y1, thicknessFt: 0.5, confidence: 1, source: "paired" })
const room = (id, label, x0, y0, x1, y1) => ({
  id,
  label,
  polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
  areaSqft: (x1 - x0) * (y1 - y0),
  confidence: 1,
})

const before = {
  walls: [wall("a", 0, 0, 24, 0), wall("b", 24, 0, 24, 16), wall("c", 12, 0, 12, 16)],
  rooms: [room("k", "KITCHEN", 0, 0, 12, 16), room("d", "DEN", 12, 0, 24, 16)],
}
// The partition moves 2' east (kitchen grows, den shrinks) and a closet appears.
const after = {
  walls: [wall("a2", 24, 0, 0, 0), wall("b2", 24, 0, 24, 16), wall("c2", 14, 0, 14, 16), wall("e2", 20, 12, 24, 12)],
  rooms: [room("k2", "KITCHEN", 0, 0, 14, 16), room("d2", "DEN", 14, 0, 24, 12), room("cl", "CLOSET", 20, 12, 24, 16)],
}

test("rooms are matched across revisions and their area changes reported", () => {
  const diff = diffLevel(before, after)
  const byId = Object.fromEntries(diff.rooms.map((change) => [change.roomId, change]))
  assert.equal(byId.k2.status, "changed")
  assert.equal(byId.k2.afterSqft - byId.k2.beforeSqft, 32)
  assert.equal(byId.d2.status, "changed")
  assert.equal(byId.cl.status, "added")
  assert.equal(diff.rooms.length, 3)
})

test("walls match end to end in either direction; a moved wall is removed + added", () => {
  const diff = diffLevel(before, after)
  assert.deepEqual(diff.addedWalls.map((w) => w.id).sort(), ["c2", "e2"])
  assert.deepEqual(diff.removedWalls.map((w) => w.id), ["c"])
})

test("an unchanged floor has no diff", () => {
  const diff = diffLevel(before, before)
  assert.deepEqual(diff, { rooms: [], addedWalls: [], removedWalls: [] })
})

test("the estimate moves by Δ SF × waste × unit cost, only for SF items", () => {
  const diff = diffLevel(before, after)
  const countedBy = new Map([
    ["k2", ["floor"]],
    ["d2", ["floor", "paint"]],
  ])
  const delta = estimateDelta(diff, countedBy, [
    { conditionId: "floor", name: "LVP flooring", uom: "sf", wastePct: 10, unitCostCents: 500 },
    { conditionId: "paint", name: "Paint", uom: "gal", wastePct: 0, unitCostCents: 4000 },
  ])
  // Kitchen +32, den −72 (192 → 120) → floor −40 SF.
  const floor = delta.lines.find((line) => line.conditionId === "floor")
  assert.equal(floor.deltaSqft, -40)
  assert.equal(floor.deltaCents, Math.round(-40 * 1.1 * 500))
  assert.equal(delta.totalCents, floor.deltaCents)
  assert.deepEqual(delta.unpriced, ["Paint"])
})

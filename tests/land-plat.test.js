require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { resolvePlatLayout, compareLots, DEFAULT_PLAT_COLUMNS } = require("../lib/land/plat")

const lot = (id, overrides = {}) => ({
  id,
  lotNumber: id,
  block: null,
  phaseId: null,
  platX: null,
  platY: null,
  ...overrides,
})

test("stored coordinates are never moved by auto-layout", () => {
  const lots = [
    lot("a", { platX: 5, platY: 3 }),
    lot("b", { platX: 0, platY: 0 }),
    lot("c"),
  ]
  const { positions, unarranged } = resolvePlatLayout(lots)
  assert.deepEqual(positions.get("a"), { x: 5, y: 3 })
  assert.deepEqual(positions.get("b"), { x: 0, y: 0 })
  assert.equal(unarranged, 1)
  // The unarranged lot lands below the arranged plat, not on top of it.
  assert.ok(positions.get("c").y > 3)
})

test("every lot gets exactly one cell and no two lots share one", () => {
  const lots = Array.from({ length: 40 }, (_, index) => lot(String(index + 1)))
  const { positions } = resolvePlatLayout(lots)
  assert.equal(positions.size, 40)
  const cells = new Set([...positions.values()].map((p) => `${p.x},${p.y}`))
  assert.equal(cells.size, 40)
})

test("auto-layout wraps at the column count", () => {
  const lots = Array.from({ length: 15 }, (_, index) => lot(String(index + 1)))
  const { positions, columns } = resolvePlatLayout(lots, { columns: 6 })
  assert.equal(columns, 6)
  assert.ok([...positions.values()].every((p) => p.x < 6))
  assert.deepEqual(positions.get("1"), { x: 0, y: 0 })
  assert.deepEqual(positions.get("7"), { x: 0, y: 1 })
})

test("phases start on their own row", () => {
  const lots = [
    lot("1", { phaseId: "p1" }),
    lot("2", { phaseId: "p1" }),
    lot("3", { phaseId: "p2" }),
  ]
  const { positions } = resolvePlatLayout(lots, { columns: 6 })
  assert.equal(positions.get("1").y, positions.get("2").y)
  assert.ok(positions.get("3").y > positions.get("1").y)
})

test("duplicate stored coordinates do not stack lots on one cell", () => {
  const lots = [lot("a", { platX: 2, platY: 2 }), lot("b", { platX: 2, platY: 2 })]
  const { positions } = resolvePlatLayout(lots)
  assert.deepEqual(positions.get("a"), { x: 2, y: 2 })
  assert.notDeepEqual(positions.get("b"), { x: 2, y: 2 })
  assert.equal(positions.size, 2)
})

test("negative and non-finite stored coordinates fall back to auto-layout", () => {
  const lots = [lot("a", { platX: -1, platY: 0 }), lot("b", { platX: 0, platY: Number.NaN })]
  const { positions, unarranged } = resolvePlatLayout(lots)
  assert.equal(unarranged, 2)
  assert.equal(positions.size, 2)
})

test("lot numbers sort naturally, and blocks sort before unblocked lots", () => {
  const sorted = [lot("10"), lot("9"), lot("1")].sort(compareLots).map((entry) => entry.id)
  assert.deepEqual(sorted, ["1", "9", "10"])

  const blocked = [lot("x", { block: null }), lot("y", { block: "A" })].sort(compareLots).map((entry) => entry.id)
  assert.deepEqual(blocked, ["y", "x"])
})

test("an empty community lays out to nothing without throwing", () => {
  const { positions, rows, columns } = resolvePlatLayout([])
  assert.equal(positions.size, 0)
  assert.equal(rows, 0)
  assert.equal(columns, DEFAULT_PLAT_COLUMNS)
})

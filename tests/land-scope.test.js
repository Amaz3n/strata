require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  assertLotAttachTransition,
  assertLotDetachTransition,
  ATTACHED_LOT_STATUS,
  DETACHED_LOT_STATUS,
} = require("../lib/land/lot-lifecycle")
const { resolveDivisionScope, divisionIsInScope } = require("../lib/land/scope")
const { readAllRows } = require("../lib/land/paging")

/* -------------------------------------------------------------------------- */
/* Attaching and detaching a home go through the lot lifecycle                 */
/* -------------------------------------------------------------------------- */

test("attaching a home is a lifecycle move, not a way around one", () => {
  assert.equal(ATTACHED_LOT_STATUS, "started")

  // The ordinary path: dirt that is ready gets a house.
  assert.doesNotThrow(() => assertLotAttachTransition({ from: "developed" }))
  assert.doesNotThrow(() => assertLotAttachTransition({ from: "assigned" }))
  // Already building: nothing changes, so nothing to confirm.
  assert.doesNotThrow(() => assertLotAttachTransition({ from: "started" }))

  // The bug this closes: attaching a project to a settled lot silently reversed
  // the closing, with none of the confirmation `setLotStatus` demands.
  assert.throws(() => assertLotAttachTransition({ from: "closed" }), /force confirmation/i)
  assert.doesNotThrow(() => assertLotAttachTransition({ from: "closed", force: true }))
})

test("detaching a home is the backward half and asks before it reverses work", () => {
  assert.equal(DETACHED_LOT_STATUS, "assigned")

  // Correcting a link on a lot that is not building yet needs no ceremony.
  assert.doesNotThrow(() => assertLotDetachTransition({ from: "developed" }))
  assert.doesNotThrow(() => assertLotDetachTransition({ from: "assigned" }))

  // A house that is building, or one that has settled, does not quietly drop
  // back into inventory.
  assert.throws(() => assertLotDetachTransition({ from: "started" }), /force confirmation/i)
  assert.doesNotThrow(() => assertLotDetachTransition({ from: "started", force: true }))
  assert.throws(() => assertLotDetachTransition({ from: "closed" }), /force confirmation/i)
  assert.doesNotThrow(() => assertLotDetachTransition({ from: "closed", force: true }))
})

/* -------------------------------------------------------------------------- */
/* Division scope: the same decision on reads and on writes                    */
/* -------------------------------------------------------------------------- */

test("an unscoped caller sees everything, and the ambient lens narrows without escalating", () => {
  const openScope = { assignedOnly: false, divisionIds: [] }
  assert.deepEqual(resolveDivisionScope(openScope), { kind: "all" })
  assert.deepEqual(resolveDivisionScope(openScope, "west"), { kind: "limited", divisionIds: ["west"] })
})

test("a division-scoped caller is limited to their own divisions", () => {
  const scoped = { assignedOnly: true, divisionIds: ["west", "south"] }
  assert.deepEqual(resolveDivisionScope(scoped), { kind: "limited", divisionIds: ["west", "south"] })
  assert.deepEqual(resolveDivisionScope(scoped, "west"), { kind: "limited", divisionIds: ["west"] })
})

test("asking for a division outside scope resolves to nothing, never to everything", () => {
  const scoped = { assignedOnly: true, divisionIds: ["west"] }
  // The lens must never become an escalation: a division the caller cannot see
  // resolves to "none" rather than falling back to their own divisions.
  assert.deepEqual(resolveDivisionScope(scoped, "east"), { kind: "none" })
  // Scoped to nothing means scoped to nothing — not to the whole org.
  assert.deepEqual(resolveDivisionScope({ assignedOnly: true, divisionIds: [] }), { kind: "none" })
  assert.deepEqual(resolveDivisionScope({ assignedOnly: true, divisionIds: [] }, "west"), { kind: "none" })
})

test("the write gate answers the same question the read gate does", () => {
  const scoped = resolveDivisionScope({ assignedOnly: true, divisionIds: ["west"] })
  // This is the hole that let a division-scoped community.write holder edit —
  // and close takedowns in — a division they could not read.
  assert.equal(divisionIsInScope(scoped, "west"), true)
  assert.equal(divisionIsInScope(scoped, "east"), false)
  // A community with no division is not "everyone's" once scoping is on.
  assert.equal(divisionIsInScope(scoped, null), false)

  const open = resolveDivisionScope({ assignedOnly: false, divisionIds: [] })
  assert.equal(divisionIsInScope(open, null), true)
  assert.equal(divisionIsInScope(open, "east"), true)
  assert.equal(divisionIsInScope({ kind: "none" }, "west"), false)
})

/* -------------------------------------------------------------------------- */
/* Reading a whole set: pages to exhaustion, and says when it could not        */
/* -------------------------------------------------------------------------- */

function fakeSource(rowCount) {
  const calls = []
  const rows = Array.from({ length: rowCount }, (_, index) => ({ id: index }))
  return {
    calls,
    read: (from, to) => {
      calls.push([from, to])
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
    },
  }
}

test("a set smaller than one page costs exactly one read", async () => {
  const source = fakeSource(400)
  const result = await readAllRows(source.read, { cap: 20_000, label: "lots", pageSize: 1_000 })
  assert.equal(result.rows.length, 400)
  assert.equal(result.truncated, false)
  assert.equal(source.calls.length, 1)
})

test("a 400-lot community across fifteen communities is read whole, not to 5,000", async () => {
  // The exact shape that used to go quietly wrong: 15 x 400 = 6,000 rows behind
  // a flat 5,000-row cap.
  const source = fakeSource(6_000)
  const result = await readAllRows(source.read, { cap: 20_000, label: "lots", pageSize: 1_000 })
  assert.equal(result.rows.length, 6_000)
  assert.equal(result.truncated, false)
  assert.deepEqual(
    result.rows.map((row) => row.id).slice(0, 3),
    [0, 1, 2],
  )
  assert.equal(result.rows[5_999].id, 5_999)
})

test("hitting the ceiling is reported, never silently returned as a total", async () => {
  const source = fakeSource(10_000)
  const result = await readAllRows(source.read, { cap: 2_000, label: "lots", pageSize: 1_000 })
  assert.equal(result.rows.length, 2_000)
  assert.equal(result.truncated, true)
})

test("the last page is honoured even when the cap is not a multiple of the page", async () => {
  const source = fakeSource(10_000)
  const result = await readAllRows(source.read, { cap: 1_500, label: "lots", pageSize: 1_000 })
  assert.equal(result.rows.length, 1_500)
  assert.equal(result.truncated, true)
  assert.deepEqual(source.calls, [
    [0, 999],
    [1_000, 1_499],
  ])
})

test("a read error surfaces with the label rather than an empty result", async () => {
  await assert.rejects(
    readAllRows(() => Promise.resolve({ data: null, error: { message: "boom" } }), {
      cap: 1_000,
      label: "Failed to list communities",
    }),
    /Failed to list communities: boom/,
  )
})

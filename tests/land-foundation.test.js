require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { assertLotStatusTransition, verticalStartRefusal } = require("../lib/land/lot-lifecycle")
const { readLotDimensions, storeLotDimensions } = require("../lib/land/lot-dimensions")
const { expandLotRange } = require("../lib/land/lot-range")

test("lot ranges carry the block separately and reject batches larger than 500", () => {
  // The block is its own column, not a prefix baked into the lot number, so the
  // plat can group and sort by it.
  assert.deepEqual(expandLotRange({ fromNumber: 1, toNumber: 3, block: "A" }), [
    { lotNumber: "1", block: "A", address: null, phaseId: null, takedownId: null, status: "controlled", dimensions: {}, costBasisCents: null },
    { lotNumber: "2", block: "A", address: null, phaseId: null, takedownId: null, status: "controlled", dimensions: {}, costBasisCents: null },
    { lotNumber: "3", block: "A", address: null, phaseId: null, takedownId: null, status: "controlled", dimensions: {}, costBasisCents: null },
  ])
  assert.throws(() => expandLotRange({ fromNumber: 1, toNumber: 501 }), /at most 500/)
})

test("lot ranges generate sequential addresses and apply shared land facts", () => {
  const lots = expandLotRange({
    fromNumber: 10,
    toNumber: 12,
    status: "developed",
    street: "Cypress Landing Way",
    addressFrom: 4100,
    addressStep: 2,
    widthFt: 52,
    depthFt: 115,
    costBasisCents: 7_650_000,
  })
  assert.deepEqual(
    lots.map((lot) => lot.address),
    ["4100 Cypress Landing Way", "4102 Cypress Landing Way", "4104 Cypress Landing Way"],
  )
  assert.equal(lots[0].status, "developed")
  assert.deepEqual(lots[0].dimensions, { widthFt: 52, depthFt: 115 })
  assert.equal(lots[2].costBasisCents, 7_650_000)
})

test("lot ranges without a street produce no addresses", () => {
  const lots = expandLotRange({ fromNumber: 1, toNumber: 2, addressFrom: 4100 })
  assert.deepEqual(lots.map((lot) => lot.address), [null, null])
})

test("lot lifecycle requires projects for started and force for leaving terminal work states", () => {
  assert.throws(
    () => assertLotStatusTransition({ from: "assigned", to: "started", hasProject: false }),
    /project must be attached/i,
  )
  assert.doesNotThrow(() =>
    assertLotStatusTransition({ from: "assigned", to: "started", hasProject: true }),
  )
  assert.throws(
    () => assertLotStatusTransition({ from: "closed", to: "started", hasProject: true }),
    /force confirmation/i,
  )
  assert.doesNotThrow(() =>
    assertLotStatusTransition({ from: "closed", to: "assigned", hasProject: true, force: true }),
  )
})

test("a lot closes only with a home, and a home never sits on a lot in a land state", () => {
  assert.throws(() => assertLotStatusTransition({ from: "assigned", to: "closed", hasProject: false }), /cannot be closed without a home/i)
  assert.throws(() => assertLotStatusTransition({ from: "controlled", to: "closed", hasProject: false }), /cannot be closed without a home/i)
  assert.doesNotThrow(() => assertLotStatusTransition({ from: "started", to: "closed", hasProject: true, force: true }))
  for (const to of ["controlled", "owned", "developed"]) {
    assert.throws(() => assertLotStatusTransition({ from: "started", to, hasProject: true, force: true }), /detach the home first/i)
  }
  assert.doesNotThrow(() => assertLotStatusTransition({ from: "controlled", to: "developed", hasProject: false }))
})

test("forward imports may skip states while backward corrections are single-step", () => {
  assert.doesNotThrow(() =>
    assertLotStatusTransition({ from: "controlled", to: "assigned", hasProject: false }),
  )
  assert.throws(
    () => assertLotStatusTransition({ from: "assigned", to: "controlled", hasProject: false }),
    /only one step/i,
  )
})

test("lot dimensions are stored snake_case whichever writer saved them", () => {
  const edited = storeLotDimensions({ city: "Austin", widthFt: 40 }, { widthFt: 52, depthFt: 115 }, "replace")
  assert.deepEqual(edited, { city: "Austin", width_ft: 52, depth_ft: 115 })
  const imported = storeLotDimensions(null, { widthFt: 52, depthFt: 115, acreage: 0.25 }, "fill")
  assert.deepEqual(imported, { width_ft: 52, depth_ft: 115, acreage: 0.25 })
  assert.deepEqual(readLotDimensions(imported), readLotDimensions(storeLotDimensions(null, { widthFt: 52, depthFt: 115, acreage: 0.25 }, "replace")))
})

test("an import row fills what it supplies and never erases what the lot already has", () => {
  const existing = { width_ft: 52, depth_ft: 115, irregular: true }
  assert.deepEqual(storeLotDimensions(existing, { widthFt: 60, depthFt: null }, "fill"), { width_ft: 60, depth_ft: 115, irregular: true })
})

test("a dimensions edit replaces the measured fields and clears the ones left out", () => {
  assert.deepEqual(storeLotDimensions({ width_ft: 52, depth_ft: 115 }, { widthFt: 55 }, "replace"), { width_ft: 55 })
})

test("a lot's corner flag and own setbacks ride in the same stored shape", () => {
  const stored = storeLotDimensions({ city: "Austin" }, { widthFt: 60, corner: true, sideSetbackFt: 5, cornerSideSetbackFt: 10 }, "replace")
  assert.deepEqual(stored, { city: "Austin", width_ft: 60, corner_lot: true, side_setback_ft: 5, corner_side_setback_ft: 10 })
  assert.equal(readLotDimensions(stored).cornerSideSetbackFt, 10)
})

test("legacy camelCase dimensions are still read, and are removed on the next save", () => {
  assert.deepEqual(readLotDimensions({ widthFt: 52, depthFt: 115 }), {
    widthFt: 52, depthFt: 115, acreage: undefined, irregular: undefined, corner: undefined,
    frontSetbackFt: undefined, rearSetbackFt: undefined, sideSetbackFt: undefined, cornerSideSetbackFt: undefined,
  })
  assert.deepEqual(storeLotDimensions({ widthFt: 52, depthFt: 115 }, {}, "fill"), { width_ft: 52, depth_ft: 115 })
})

test("a house cannot start on a lot land development has not delivered, unless an exception is on the record", () => {
  const exception = { delivery_exception: { reason: "Lot finishes with the house pad", by: "00000000-0000-4000-8000-0000000000aa", at: "2026-10-01T00:00:00Z" } }
  assert.equal(verticalStartRefusal({ status: "developed", deliveredAt: "2026-06-01T00:00:00Z", metadata: {} }), null)
  assert.match(verticalStartRefusal({ status: "assigned", deliveredAt: null, metadata: {} }), /not been delivered/)
  assert.equal(verticalStartRefusal({ status: "assigned", deliveredAt: null, metadata: exception }), null)
  assert.match(verticalStartRefusal({ status: "assigned", deliveredAt: null, metadata: { delivery_exception: { reason: "short", by: "x", at: "y" } } }), /not been delivered/)
  assert.match(verticalStartRefusal({ status: "owned", deliveredAt: "2026-06-01T00:00:00Z", metadata: {} }), /Only developed or assigned/)
})

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { assertLotStatusTransition } = require("../lib/land/lot-lifecycle")
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

test("forward imports may skip states while backward corrections are single-step", () => {
  assert.doesNotThrow(() =>
    assertLotStatusTransition({ from: "controlled", to: "assigned", hasProject: false }),
  )
  assert.throws(
    () => assertLotStatusTransition({ from: "assigned", to: "controlled", hasProject: false }),
    /only one step/i,
  )
})

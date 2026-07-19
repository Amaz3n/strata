require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { assertLotStatusTransition } = require("../lib/land/lot-lifecycle")
const { expandLotRange } = require("../lib/land/lot-range")

test("lot ranges expand with prefixes and reject batches larger than 500", () => {
  assert.deepEqual(expandLotRange({ fromNumber: 1, toNumber: 3, prefix: "A-" }), [
    { lotNumber: "A-1", phaseId: null, takedownId: null },
    { lotNumber: "A-2", phaseId: null, takedownId: null },
    { lotNumber: "A-3", phaseId: null, takedownId: null },
  ])
  assert.throws(() => expandLotRange({ fromNumber: 1, toNumber: 501 }), /at most 500/)
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

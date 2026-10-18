"use strict"

/**
 * What a new plan version means for a home already carrying the plan
 * (`lib/plans/plan-change-impact.ts`): its state, what adopting may do to it,
 * and what moving it costs.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { freshRequire } = require("./support/modules")

const { adoptionPath, allowedDecisions, classifyAffectedHome, homeCostDelta, reviewIsDecided } = freshRequire("lib/plans/plan-change-impact.ts")

test("a home's state is its furthest commitment: released, then a binding agreement, then a home, else an unsold lot", () => {
  const cases = [
    [{ hasHome: false, agreement: "none", startReleased: false }, "unsold"],
    [{ hasHome: true, agreement: "none", startReleased: false }, "spec"],
    [{ hasHome: true, agreement: "draft", startReleased: false }, "spec"],
    [{ hasHome: true, agreement: "binding", startReleased: false }, "contracted"],
    [{ hasHome: true, agreement: "binding", startReleased: true }, "released"],
    [{ hasHome: true, agreement: "none", startReleased: true }, "released"],
  ]
  for (const [facts, state] of cases) assert.equal(classifyAffectedHome(facts), state, JSON.stringify(facts))
})

test("only an unsold or spec home re-pins; a sold home is amended by change order and a released one also revises its purchase orders", () => {
  const path = (state, extra = {}) => adoptionPath({ state, agreement: "none", held: false, toVersionNumber: 4, toVersionReleased: true, ...extra })
  assert.deepEqual(path("unsold"), { kind: "repin" })
  assert.deepEqual(path("spec"), { kind: "repin" })
  assert.deepEqual(path("contracted", { agreement: "binding" }), { kind: "change_order", buyerSignature: true, varianceOrders: false })
  assert.deepEqual(path("released", { agreement: "binding" }), { kind: "change_order", buyerSignature: true, varianceOrders: true })
  // A released spec home has no buyer to sign; the change order is internal.
  assert.deepEqual(path("released"), { kind: "change_order", buyerSignature: false, varianceOrders: true })
})

test("adopting waits for a released version, a lot nobody holds and an agreement nobody is writing", () => {
  const path = (state, extra) => adoptionPath({ state, agreement: "none", held: false, toVersionNumber: 4, toVersionReleased: true, ...extra })
  assert.match(path("unsold", { toVersionReleased: false }).reason, /Release v4/)
  assert.match(path("contracted", { toVersionReleased: false, agreement: "binding" }).reason, /Release v4/)
  assert.equal(path("unsold", { held: true }).kind, "blocked")
  assert.equal(path("spec", { agreement: "draft" }).kind, "blocked")
})

test("a home nobody has bought cannot keep an old edition; a sold one can", () => {
  assert.deepEqual(allowedDecisions("unsold"), ["adopt", "defer"])
  assert.deepEqual(allowedDecisions("spec"), ["adopt", "defer"])
  assert.deepEqual(allowedDecisions("contracted"), ["adopt", "decline", "defer"])
  assert.deepEqual(allowedDecisions("released"), ["adopt", "decline", "defer"])
})

test("the cost of moving a home counts the base lines and its own elevation's, by cost code", () => {
  const line = (id, overrides) => ({ id, elevation_id: null, cost_code_id: "framing", cost_type: null, description: "Framing", quantity: 1, uom: "ls", unit_cost_cents: 0, sort_order: 0, ...overrides })
  const before = [
    line("a", { unit_cost_cents: 1_000_000 }),
    line("b", { elevation_id: "elev-b", cost_code_id: "roof", description: "Roof", unit_cost_cents: 300_000 }),
    line("c", { elevation_id: "elev-c", cost_code_id: "stone", description: "Stone", unit_cost_cents: 500_000 }),
  ]
  const after = [
    line("a2", { unit_cost_cents: 1_150_000 }),
    line("b2", { elevation_id: "elev-b", cost_code_id: "roof", description: "Roof", unit_cost_cents: 250_000 }),
    line("c2", { elevation_id: "elev-c", cost_code_id: "stone", description: "Stone", unit_cost_cents: 900_000 }),
    line("d2", { cost_code_id: "window", description: "Egress window", quantity: 2, unit_cost_cents: 40_000 }),
  ]

  const b = homeCostDelta(before, after, "elev-b")
  assert.equal(b.costDeltaCents, 150_000 - 50_000 + 80_000)
  assert.deepEqual(b.byCostCode, [
    { costCodeId: "framing", costDeltaCents: 150_000 },
    { costCodeId: "roof", costDeltaCents: -50_000 },
    { costCodeId: "window", costDeltaCents: 80_000 },
  ])
  // The stone on elevation C is another house's change.
  assert.equal(homeCostDelta(before, after, "elev-b").changes.some((change) => change.key.includes("stone")), false)
  assert.equal(homeCostDelta(before, before, "elev-c").costDeltaCents, 0)
  assert.deepEqual(homeCostDelta(before, before, "elev-c").byCostCode, [])
})

test("a review is decided once no home is waiting", () => {
  assert.equal(reviewIsDecided(["adopt", "defer", "decline"]), true)
  assert.equal(reviewIsDecided(["adopt", "pending"]), false)
})

require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { changedPercentEntry, applyStoredMaterialMovement } = require("../lib/financials/pay-app-entry")

test("tabbing through a rounded percent never instructs a monetary change", () => {
  assert.equal(changedPercentEntry("12.35", "12.35"), null)
  assert.equal(changedPercentEntry("", "12.35"), null)
  assert.equal(changedPercentEntry("12.350", "12.35"), null)
  assert.equal(changedPercentEntry("12.4", "12.35"), 12.4)
  assert.equal(changedPercentEntry("abc", "12.35"), null)
  assert.equal(changedPercentEntry("101", "12.35"), null)
})

test("installing already billed stored material cannot bill it twice", () => {
  const result = applyStoredMaterialMovement({ workCents: 120034, storedCents: 500000, addedCents: 0, installedCents: 200000 })
  assert.deepEqual(result, { workCents: 320034, storedCents: 300000 })
  assert.equal(result.workCents + result.storedCents, 620034)
})

test("new stored material is the only new gross amount in a combined movement", () => {
  const result = applyStoredMaterialMovement({ workCents: 120034, storedCents: 500000, addedCents: 50099, installedCents: 200000 })
  assert.equal(result.workCents + result.storedCents, 670133)
  assert.throws(() => applyStoredMaterialMovement({ workCents: 0, storedCents: 10, addedCents: 0, installedCents: 11 }))
  assert.throws(() => applyStoredMaterialMovement({ workCents: 0, storedCents: 10, addedCents: -1, installedCents: 0 }))
})

test("editing reviewed progress detaches its provenance while material-only edits preserve it", () => {
  const { mergePayApplicationEntry } = require("../lib/financials/pay-app-entry")
  const evidence = { source_bill_ids: ["bill-one"], suggested_percent_complete: 45 }
  const accepted = mergePayApplicationEntry({ this_period: "0", stored: "0" }, { this_period: "4500", progress_evidence: evidence })
  assert.deepEqual(accepted.progress_evidence, evidence)
  assert.deepEqual(mergePayApplicationEntry(accepted, { stored: "100" }).progress_evidence, evidence)
  const edited = mergePayApplicationEntry(accepted, { this_period: "4700" })
  assert.equal(edited.this_period, "4700")
  assert.equal(edited.progress_evidence, undefined)
})

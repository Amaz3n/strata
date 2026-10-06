require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { hasTitleBlockEvidence, needsNumberVerification } = require("../lib/drawings/number-evidence")
const good = { sheet_number: "A2", confidence: "high", number_evidence: { text: "A2", location: "bottom right sheet number field", is_title_block: true } }
test("accepts a legible title-block number with matching evidence", () => {
  assert.equal(hasTitleBlockEvidence(good), true)
  assert.equal(needsNumberVerification(good, "A2"), false)
})
test("different text and vision readings trigger independent verification", () => {
  assert.equal(needsNumberVerification(good, "A5.2"), true)
})
test("low confidence cannot pass even with matching evidence", () => {
  assert.equal(hasTitleBlockEvidence({ ...good, confidence: "low" }), false)
})
test("invented digits and non-title-block references cannot pass", () => {
  assert.equal(hasTitleBlockEvidence({ ...good, sheet_number: "A5.2" }), false)
  assert.equal(hasTitleBlockEvidence({ ...good, number_evidence: { ...good.number_evidence, is_title_block: false } }), false)
  assert.equal(hasTitleBlockEvidence({ ...good, number_evidence: null }), false)
})

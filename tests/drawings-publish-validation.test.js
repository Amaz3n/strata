require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { duplicateIssuanceNumbers } = require("../lib/drawings/publish-validation")
const sheets = [{ sheet_id: "page5", sheet_number: "A5.1" }, { sheet_id: "page13", sheet_number: "A5.1" }]
test("detects duplicate AI proposals on different pages", () => {
  assert.deepEqual(duplicateIssuanceNumbers(sheets), ["A5.1"])
})
test("correcting a number resolves the conflict", () => {
  assert.deepEqual(duplicateIssuanceNumbers(sheets, {}, { page13: { sheet_number: "A5.2" } }), [])
})
test("excluded pages do not prevent publishing", () => {
  assert.deepEqual(duplicateIssuanceNumbers(sheets, { page13: false }), [])
})
test("empty edits still validate the proposed number", () => {
  assert.deepEqual(duplicateIssuanceNumbers(sheets, {}, { page13: { sheet_number: "" } }), ["A5.1"])
})

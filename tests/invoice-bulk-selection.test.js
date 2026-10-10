require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")

const { selectionAfterBulk, selectionStillVisible } = require("../lib/invoices/bulk-selection")

test("rows hidden by a search or a collapsed band leave the bulk selection", () => {
  assert.deepEqual(selectionStillVisible(["a", "b", "c"], ["c", "a", "z"]), ["a", "c"])
  assert.deepEqual(selectionStillVisible(["a"], []), [])
})

test("after a partial failure only the failed rows stay selected", () => {
  assert.deepEqual(selectionAfterBulk(["a", "b", "c"], new Set(["b"])), ["b"])
  assert.deepEqual(selectionAfterBulk(["a", "b"], new Set()), [])
})

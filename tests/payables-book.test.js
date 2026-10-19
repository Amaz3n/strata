"use strict"

/** The payables book's URL state (`parsePayablesBookQuery`, lib/financials/payables-book.ts). */

const assert = require("node:assert/strict")
const test = require("node:test")

require("../scripts/register-ts-node-test")
const { matchingSelectionSummary, parsePayablesBookQuery, parsePayableSort, payableBandPage } = require("@/lib/financials/payables-book")

test("a hostile or malformed URL falls back to safe sorting and bounded pages", () => {
  const query = parsePayablesBookQuery({
    sort: "DROP TABLE",
    direction: "bad",
    page_ready: Infinity,
    page_approval: "3",
    due: "overdue",
    tab: "paid",
  })
  assert.equal(query.sort, "due")
  assert.equal(query.direction, "asc")
  assert.equal(query.bandPages.ready, 1)
  assert.equal(query.bandPages.approval, 3)
  assert.equal(query.includePaid, true)
  assert.equal(query.due, undefined, "the retired due filter is not carried")
  assert.equal(parsePayableSort("amount"), "amount")
})

test("a band page is a positive whole number with a ceiling", () => {
  for (const [value, page] of [
    ["2", 2],
    [0, 1],
    [-4, 1],
    [1.5, 1],
    ["abc", 1],
    [10_000_000, 100_000],
  ]) {
    assert.equal(payableBandPage(value), page, String(value))
  }
})

test("selecting every match says so, and names both numbers when the filter holds more than the cap", () => {
  assert.deepEqual(matchingSelectionSummary(1, 1), { truncated: false, message: "1 payable selected" })
  assert.deepEqual(matchingSelectionSummary(500, 500), { truncated: false, message: "500 payables selected" })
  assert.deepEqual(matchingSelectionSummary(500, 1240), { truncated: true, message: "First 500 of 1240 matching payables selected" })
})

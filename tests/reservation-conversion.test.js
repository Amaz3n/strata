"use strict"

/**
 * `lib/sales/reservation-deposit.ts` — the earnest deposit a reservation takes:
 * dollars typed on the form become exact integer cents, and anything the invoice
 * column cannot hold is refused. The conversion itself is tested with the rest of
 * the sales moves in `tests/community-sales.test.js`.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

require("../scripts/register-ts-node-test")
const { parseReservationDeposit, reservationDepositInput } = require("../lib/sales/reservation-deposit")

test("a deposit typed in dollars becomes exact cents and back", () => {
  assert.equal(reservationDepositInput(500001), "5000.01")
  assert.equal(parseReservationDeposit("5000.01"), 500001)
  assert.equal(parseReservationDeposit("$5,000.01"), 500001)
  assert.equal(parseReservationDeposit("1.005"), 101)
  assert.equal(parseReservationDeposit("21474836.47"), 2147483647)
  assert.equal(parseReservationDeposit("0"), 0)
})

test("a blank, malformed or overflowing deposit is refused", () => {
  for (const value of ["", " ", "1.2.3", "-0.01", "21474836.48", "99999999999999999999"]) {
    assert.equal(parseReservationDeposit(value), null)
  }
})

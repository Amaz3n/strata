"use strict"

/** Invoice recipients pasted into the composer (`lib/invoices/composer-recipients.ts`). */

const assert = require("node:assert/strict")
const test = require("node:test")

require("../scripts/register-ts-node-test")
const { parseInvoiceRecipients, isInvoiceRecipientValid } = require("@/lib/invoices/composer-recipients")

test("pasted recipients are de-duplicated without regard to case, and display names are dropped", () => {
  assert.deepEqual(parseInvoiceRecipients("Owner <owner@example.com>; OWNER@example.com\naccounting@example.com"), [
    "owner@example.com",
    "accounting@example.com",
  ])
})

test("only deliverable-looking addresses are accepted", () => {
  for (const bad of ["a@", "a@b", "owner name@example.com", "name@example..com"]) {
    assert.equal(isInvoiceRecipientValid(bad), false, bad)
  }
  assert.equal(isInvoiceRecipientValid("owner+job@example.com"), true)
})

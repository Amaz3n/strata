"use strict"

/**
 * The payable form's starting state (`toFormState`,
 * components/payables/workspace/payable-form.tsx): which ledger's account id a
 * bill's coding line shows.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

require("../scripts/register-ts-node-test")
const { toFormState } = require("@/components/payables/workspace/payable-form")

const NATIVE_ACCOUNT = "b151b670-0689-4b46-b345-9810bf2325f1"
const bill = {
  id: "bill",
  total_cents: 100,
  qbo_expense_account_id: "qbo-42",
  actual_lines: [{ amount_cents: 100, qbo_expense_account_id: "qbo-42", arc_books_gl_account_id: NATIVE_ACCOUNT }],
}
const context = { costCodesEnabled: false, qboDefaults: {}, defaultBillable: () => false }

test("with Arc Books, a line shows its native account and never a QuickBooks id", () => {
  assert.equal(toFormState(bill, { ...context, nativeBooks: true }).splitLines[0].qboExpenseAccountId, NATIVE_ACCOUNT)
  assert.equal(toFormState({ ...bill, actual_lines: [] }, { ...context, nativeBooks: true }).qboExpenseAccountId, "")
})

test("with external books, a line keeps its QuickBooks account", () => {
  assert.equal(toFormState(bill, context).splitLines[0].qboExpenseAccountId, "qbo-42")
})

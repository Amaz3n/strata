const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

test("multi-invoice receipts preserve one projected payment per invoice", () => {
  const migration = read("supabase/migrations/20260818120338_books_workflow_completeness.sql")
  assert.match(migration, /create or replace function public\.apply_multi_invoice_payment_atomic/)
  assert.match(migration, /for v_allocation in[\s\S]*apply_invoice_payment_with_details_atomic/)
  assert.match(migration, /unique \(group_id, invoice_id\)/)
  assert.match(migration, /revoke all on table public\.receivable_payment_groups from public, anon, authenticated/)
})

test("deposit batching clears undeposited funds into the mapped bank line", () => {
  const service = read("lib/services/books/deposit-batches.ts")
  assert.match(service, /SYSTEM_ACCOUNT_CODES\.undepositedFunds/)
  assert.match(service, /debitCents: totalCents/)
  assert.match(service, /creditCents: totalCents/)
  assert.match(service, /confirmBankMatch/)
})

test("party activity has one project-client attribution contract and adaptive GL links", () => {
  const service = read("lib/services/financial-parties.ts")
  const activity = read("components/financial-parties/party-financial-activity.tsx")
  assert.match(service, /projects\.client_id|project\.client_id/)
  assert.match(service, /deliberately not an invoice-metadata union/i)
  assert.match(service, /permission: "books\.read"/)
  assert.match(activity, /summary\.can_view_books/)
  assert.match(activity, /Credit memo|credits, and write-offs/i)
})

test("Banking owns feed work and the old Transactions URL is only a redirect", () => {
  const client = read("app/(app)/books/books-client.tsx")
  const redirect = read("app/(app)/books/transactions/page.tsx")
  const ledger = read("components/books/books-journals.tsx")
  assert.doesNotMatch(client, /key: "transactions"/)
  assert.match(client, /<BankReviewTray/)
  assert.match(client, /<BankTransactionRegister/)
  assert.match(redirect, /redirect\("\/books\/banking"\)/)
  assert.match(ledger, /Memo, source, account, project, or entity/)
})

test("the accounting product remains Books", () => {
  const client = read("app/(app)/books/books-client.tsx")
  assert.match(client, /Arc Books/)
  assert.doesNotMatch(client, /Mainframe|Arc Ledger|Basis/)
})

test("company detail keeps vendor-bill runtime values out of the client graph", () => {
  const payables = read("components/companies/company-payables.tsx")
  assert.match(payables, /import \{ COMPANY_PAYABLE_LIMIT \} from "@\/lib\/financials\/vendor-bill-constants"/)
  assert.match(payables, /import type \{ VendorBillSummary \} from "@\/lib\/services\/vendor-bills"/)
  assert.doesNotMatch(payables, /import \{ COMPANY_PAYABLE_LIMIT,[^\n]+vendor-bills/)
})

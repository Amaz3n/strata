require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const { database } = require("./helpers/report-database")

test("historical aging ignores today's paid totals, keeps credits, excludes future bills and separates AP retainage", async () => {
  const db = database({
    invoices: [
      { id: "invoice", org_id: "org", status: "paid", issue_date: "2026-09-01", due_date: "2026-09-15", total_cents: 10000, balance_due_cents: 0 },
      { id: "credit", org_id: "org", status: "paid", issue_date: "2026-09-01", total_cents: -1000, balance_due_cents: 0 },
      { id: "deposit", org_id: "org", status: "sent", issue_date: "2026-09-01", total_cents: 50000, metadata: { invoice_kind: "earnest_deposit" } },
    ],
    vendor_bills: [
      { id: "bill", org_id: "org", status: "paid", bill_date: "2026-09-01", due_date: "2026-09-15", total_cents: 20000, retainage_cents: 2000, paid_cents: 18000 },
      { id: "vendor-credit", org_id: "org", status: "approved", bill_date: "2026-09-01", total_cents: -2000, retainage_cents: 0, paid_cents: 0 },
      { id: "future", org_id: "org", status: "approved", bill_date: "2026-10-01", total_cents: 999999, paid_cents: 0 },
    ],
    payments: [
      { id: "receipt", org_id: "org", invoice_id: "invoice", amount_cents: 10000, status: "succeeded", received_at: "2026-10-02T00:00:00Z" },
      { id: "disbursement", org_id: "org", bill_id: "bill", amount_cents: 18000, status: "succeeded", received_at: "2026-10-02T00:00:00Z" },
    ],
  })
  const original = Module._load
  let ar, ap
  try {
    Module._load = function(name, ...args) {
      if (name === "@/lib/services/context") return { requireOrgContext: async () => ({ supabase: db, orgId: "org", userId: "user" }) }
      if (name === "@/lib/services/permissions") return { requirePermission: async () => {} }
      if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => db }
      if (name === "@/lib/services/reporting-scope") return { getReportingExcludedProjectIds: async () => [], applyReportingExclusion: query => query }
      return original.call(this, name, ...args)
    }
    ar = require("../lib/services/reports/ar-aging").getArAgingReport
    ap = require("../lib/services/reports/ap-aging").getApAgingReport
  } finally { Module._load = original }
  const receivables = await ar({ asOf: "2026-09-30" })
  const payables = await ap({ asOf: "2026-09-30" })
  assert.equal(receivables.totals.total_open_cents, 9000)
  assert.equal(receivables.rows.find(row => row.invoice_id === "invoice").open_balance_cents, 10000)
  assert.equal(payables.totals.total_open_cents, 16000)
  assert.equal(payables.rows.find(row => row.bill_id === "bill").open_balance_cents, 18000)
  assert.equal(payables.rows.some(row => row.bill_id === "future"), false)
})

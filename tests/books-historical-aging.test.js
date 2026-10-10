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

test("a company's receivables and payables are its jobs' documents, company-level ones belong to the primary company, and the companies add up to the group", async () => {
  const PRIMARY = "00000000-0000-4000-8000-0000000000a1"
  const LAND = "00000000-0000-4000-8000-0000000000b2"
  const db = database({
    invoices: [
      { id: "land-invoice", org_id: "org", status: "sent", issue_date: "2026-09-01", due_date: "2026-09-15", total_cents: 7000, balance_due_cents: 7000, project: { name: "Land job", legal_entity_id: LAND } },
      { id: "builder-invoice", org_id: "org", status: "sent", issue_date: "2026-09-01", due_date: "2026-09-15", total_cents: 3000, balance_due_cents: 3000, project: { name: "Home", legal_entity_id: null } },
      { id: "company-level", org_id: "org", status: "sent", issue_date: "2026-09-01", due_date: "2026-09-15", total_cents: 500, balance_due_cents: 500, project: null },
    ],
    vendor_bills: [
      { id: "land-bill", org_id: "org", status: "approved", bill_date: "2026-09-01", due_date: "2026-09-15", total_cents: 4000, retainage_cents: 0, paid_cents: 0, project: { name: "Land job", legal_entity_id: LAND } },
      { id: "builder-bill", org_id: "org", status: "approved", bill_date: "2026-09-01", due_date: "2026-09-15", total_cents: 1200, retainage_cents: 0, paid_cents: 0, project: { name: "Home", legal_entity_id: PRIMARY } },
    ],
  })
  db.rpc = async () => ({ data: PRIMARY, error: null })
  const original = Module._load
  let ar, ap
  for (const module of ["reports/ar-aging", "reports/ap-aging", "books/legal-entities"]) delete require.cache[require.resolve(`../lib/services/${module}`)]
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

  const receivable = async (legalEntityId) => (await ar({ asOf: "2026-09-30", legalEntityId })).totals.total_open_cents
  const payable = async (legalEntityId) => (await ap({ asOf: "2026-09-30", legalEntityId })).totals.total_open_cents
  assert.deepEqual([await receivable(LAND), await receivable(PRIMARY)], [7000, 3500])
  assert.deepEqual([await payable(LAND), await payable(PRIMARY)], [4000, 1200])
  assert.equal(await receivable(null), 10500)
  assert.equal(await payable(null), 5200)
})

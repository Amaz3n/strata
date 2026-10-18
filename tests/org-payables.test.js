"use strict"

/**
 * The org payables desk (`loadOrgPayablesDesk`, lib/services/org-payables.ts):
 * which bills a desk or a bulk selection holds, and how its pages are bounded.
 *
 * Bill enrichment (`hydrateVendorBills`) is replaced with the identity — it has
 * its own suite, and a bulk selection must never need it. Everything else,
 * including the run-claim lookup and reporting exclusions, is real.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { supportPostgrestFilters } = require("./support/billing")
const { freshRequire, stubModule } = require("./support/modules")

let hydrated = 0
stubModule("@/lib/services/vendor-bills", {
  vendorBillSelect: "*",
  hydrateVendorBills: async (_supabase, _orgId, rows) => {
    hydrated += 1
    return rows
  },
})

const { loadOrgPayablesDesk } = freshRequire("lib/services/org-payables.ts")

const JOB = id(1)
const OTHER_JOB = id(2)
const EXCLUDED_JOB = id(3)
const ACME = id(10)
const BETA = id(11)
const RUN = id(20)
const PAST = "2026-01-01"
const FUTURE = "2999-01-01"

let sequence = 100
function bill(overrides = {}) {
  sequence += 1
  return {
    id: id(sequence),
    org_id: ORG,
    project_id: JOB,
    company_id: ACME,
    status: "approved",
    due_date: PAST,
    total_cents: 1000,
    paid_cents: 0,
    retainage_cents: 0,
    bill_number: `B-${sequence}`,
    qbo_vendor_name: null,
    metadata: {},
    ...overrides,
  }
}

const COMPANY_NAMES = { [ACME]: "Acme Concrete", [BETA]: "Beta Framing" }

// The database exposes bill_search_text (vendor + project name) as a
// computed column; the fake table carries the same value on every bill.
function withSearchText(row) {
  const project = `Job ${String(row.project_id).slice(-1)}`
  return { ...row, bill_search_text: [COMPANY_NAMES[row.company_id], project].filter(Boolean).join(" ") }
}

function desk(bills, { claimed = [], excludedJobs = [EXCLUDED_JOB] } = {}) {
  hydrated = 0
  return supportPostgrestFilters(
    createServiceHarness({
      permissions: ["bill.read"],
      tables: {
        orgs: [{ id: ORG, slug: null }],
        projects: [JOB, OTHER_JOB, EXCLUDED_JOB].map((projectId) => ({
          id: projectId,
          org_id: ORG,
          name: `Job ${projectId.slice(-1)}`,
          excluded_from_reporting: excludedJobs.includes(projectId),
        })),
        companies: [
          { id: ACME, org_id: ORG, name: COMPANY_NAMES[ACME] },
          { id: BETA, org_id: ORG, name: COMPANY_NAMES[BETA] },
        ],
        vendor_bills: bills.map(withSearchText),
        payment_run_items: claimed.map((billId, n) => ({
          id: id(500 + n),
          org_id: ORG,
          bill_id: billId,
          run_id: RUN,
          status: "pending_approval",
        })),
        disbursements: [],
        payment_runs: [],
      },
    }),
  )
}

const load = (service, projectIds, input) => service.run(() => loadOrgPayablesDesk(projectIds, input))

test("searching finds a bill by its vendor or project name however many vendors match", async () => {
  const onOtherJob = bill({ project_id: OTHER_JOB, company_id: BETA })
  const service = desk([bill(), onOtherJob, ...Array.from({ length: 300 }, () => bill({ company_id: ACME }))])

  const byProject = await load(service, null, { selectionOnly: true, tab: "ready", search: "Job 2" })
  const byVendor = await load(service, null, { selectionOnly: true, tab: "ready", search: "Beta" })

  assert.deepEqual(byProject.selectionIds, [onOtherJob.id])
  assert.deepEqual(byVendor.selectionIds, [onOtherJob.id])
})

test("a project's bulk selection honours the vendor search, the due filter and run claims, and needs no enrichment", async () => {
  const match = bill()
  const service = desk(
    [
      match,
      bill({ due_date: FUTURE }),
      bill({ company_id: BETA }),
      bill({ id: id(90) }),
      bill({ project_id: OTHER_JOB }),
      bill({ status: "pending" }),
    ],
    { claimed: [id(90)] },
  )

  const result = await load(service, [JOB], { projectScope: true, selectionOnly: true, tab: "ready", search: "Acme", due: "overdue" })

  assert.deepEqual(result.selectionIds, [match.id])
  assert.equal(hydrated, 0)
})

test("a project page includes its job even when that job is excluded from portfolio reporting", async () => {
  const onExcludedJob = bill({ project_id: EXCLUDED_JOB })
  const service = desk([onExcludedJob])
  const projectPage = await load(service, [EXCLUDED_JOB], { projectScope: true, selectionOnly: true, tab: "ready" })
  assert.deepEqual(projectPage.selectionIds, [onExcludedJob.id])

  const portfolio = await load(service, [JOB, EXCLUDED_JOB], { selectionOnly: true, tab: "ready" })
  assert.deepEqual(portfolio.selectionIds, [])
})

test("the in-flight selection is exactly the bills a payment run claims, within reporting scope", async () => {
  const claimed = bill()
  const claimedOnExcludedJob = bill({ project_id: EXCLUDED_JOB })
  const service = desk([claimed, claimedOnExcludedJob, bill()], { claimed: [claimed.id, claimedOnExcludedJob.id] })

  const result = await load(service, [JOB, EXCLUDED_JOB], { selectionOnly: true, tab: "inflight" })
  assert.deepEqual(result.selectionIds, [claimed.id])
})

test("a nonsense page request is bounded to a normal first page", async () => {
  const service = desk(Array.from({ length: 60 }, () => bill({ status: "pending" })))
  const result = await load(service, null, { page: Infinity, pageSize: Infinity })

  assert.equal(result.bills.length, 50)
  assert.deepEqual(result.pagination, { page: 1, pageSize: 50, total: 60, pageCount: 2 })
  assert.equal(result.truncated, true)
  assert.deepEqual(result.tabs.approval, { count: 60, amountCents: 60000 })
})

test("a failed totals read fails the desk instead of showing wrong totals", async () => {
  const service = desk([bill()])
  service.tamper("vendor_bills", replies.error("offline"))
  await assert.rejects(load(service, null, {}), /Failed to load payable totals: offline/)
})

test("each band pages and sorts on its own, and paid history is left out until asked for", async () => {
  const approvals = Array.from({ length: 60 }, (_, n) => bill({ status: "pending", total_cents: 1000 + (n % 7) * 100 }))
  const service = desk([...approvals, bill(), bill({ status: "paid", paid_cents: 1000 })])

  const result = await load(service, [JOB], {
    banded: true,
    projectScope: true,
    sort: "amount",
    direction: "desc",
    bandPages: { approval: 3 },
  })

  assert.deepEqual(
    result.bands.map((band) => band.key),
    ["drafts", "approval", "ready", "inflight", "credits"],
  )
  const approval = result.bands.find((band) => band.key === "approval")
  assert.deepEqual([approval.page, approval.pageCount, approval.total, approval.billIds.length], [3, 3, 60, 10])

  const ranked = [...approvals].sort((a, b) => b.total_cents - a.total_cents || a.id.localeCompare(b.id))
  assert.deepEqual(approval.billIds, ranked.slice(50, 60).map((row) => row.id))
  assert.equal(result.bands.find((band) => band.key === "ready").billIds.length, 1)
})

test("a banded bulk selection covers every open bill but never paid, rejected or credit rows", async () => {
  const open = [bill({ status: "pending" }), bill({ status: "approved" }), bill({ status: "partial" })]
  const service = desk([
    ...open,
    bill({ status: "paid" }),
    bill({ status: "rejected" }),
    bill({ status: "approved", metadata: { source: "vendor_credit" } }),
  ])

  const result = await load(service, null, { banded: true, selectionOnly: true })
  assert.deepEqual(result.selectionIds.sort(), open.map((row) => row.id).sort())
})

test("a bulk selection is capped at 500 bills", async () => {
  const service = desk(Array.from({ length: 520 }, () => bill()))
  const result = await load(service, null, { selectionOnly: true, tab: "ready" })
  assert.equal(result.selectionIds.length, 500)
  assert.equal(result.pagination.total, 520)
})

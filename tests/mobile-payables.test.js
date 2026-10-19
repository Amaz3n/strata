const assert = require("node:assert/strict")
const { beforeEach, describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, status } = require("./support/mobile")

const PROJECT_A = id(1)
const PROJECT_B = id(2)
const FOREIGN_ORG = id(3)
const FILE = id(4)
const STAMP = "2026-10-05T00:00:00+00:00"

// Sibling services the queue reads through (each has its own suite): the
// vendor-bill service owns hydration and every status change; compliance and
// hold evaluation decorate a row. Payment step-up always refuses here, to prove
// that approving a bill never asks for it.
const bills = { decisions: [], holds: 0, refusal: null }
stubModule("lib/services/vendor-bills.ts", {
  vendorBillSelect: "*",
  hydrateVendorBills: async (_supabase, _orgId, rows) => rows.map((row) => ({ ...row, actual_lines: [] })),
  async updateVendorBillStatus({ billId, orgId, input }) {
    bills.decisions.push({ billId, orgId, input })
    if (input.expected_updated_at !== STAMP) throw new Error("This payable changed since you opened it")
    if (bills.refusal) throw new Error(bills.refusal)
    return { id: billId, status: input.status, updated_at: "2026-10-06T00:00:00+00:00" }
  },
})
stubModule("lib/services/compliance.ts", { getComplianceRules: async () => ({ require_lien_waiver: false }) })
stubModule("lib/services/compliance-documents.ts", { getCompaniesComplianceStatus: async () => ({}) })
stubModule("lib/services/payment-holds.ts", { evaluateHolds: async () => ({ blockingCount: bills.holds }) })
stubModule("lib/services/payment-step-up.ts", {
  requireRecentMobilePaymentStepUp: async () => {
    throw new Error("Step-up required")
  },
})
const storage = require("@/lib/storage/files-storage")
stubModule("lib/storage/files-storage.ts", {
  ...storage,
  createFilesDownloadUrl: async ({ path }) => ({ downloadUrl: `https://files.test/${path}` }),
})

const { decideMobilePayable, getMobilePayable, listMobilePayables } = freshRequire("lib/mobile/payables.ts")

const bill = (n, overrides = {}) => ({
  id: id(100 + n),
  org_id: ORG,
  project_id: PROJECT_A,
  bill_number: `B-${n}`,
  status: "pending",
  total_cents: 10_000 * n,
  paid_cents: 0,
  retainage_cents: 0,
  payable_type: "bill",
  currency: "usd",
  due_date: `2026-10-${String(10 + n).padStart(2, "0")}`,
  created_at: STAMP,
  updated_at: STAMP,
  metadata: {},
  file_id: null,
  ...overrides,
})

const ALL_BILLS = [
  bill(1),
  bill(2, { project_id: PROJECT_B }),
  bill(3, { metadata: { creation_state: "draft" } }),
  bill(4, { metadata: { source: "vendor_credit" } }),
  bill(5, { status: "approved" }),
  bill(6, { org_id: FOREIGN_ORG }),
]

/**
 * `approves` is where the actor holds bill.approve: "org" (their org role) or
 * a list of projects (a project role on each, nothing org-wide).
 */
function harness({ approves = "org", vendorBills = ALL_BILLS, tables = {} } = {}) {
  const base = ["project.read", "bill.read"]
  const service = createServiceHarness({
    permissions: approves === "org" ? [...base, "bill.approve"] : base,
    projects: approves === "org" ? undefined : approves,
    tables: {
      projects: [
        { id: PROJECT_A, org_id: ORG },
        { id: PROJECT_B, org_id: ORG },
      ],
      vendor_bills: vendorBills,
      ...tables,
    },
  })
  if (approves !== "org" && approves.length) {
    for (const member of service.db.project_members) {
      member.role = { permissions: [...base, "bill.approve"].map((key) => ({ permission_key: key })) }
    }
  }
  service.context = mobileContext(service)
  return service
}

const listed = async (service, params) =>
  (await service.run(() => listMobilePayables(service.context, params))).payables.map((payable) => payable.bill_number)

beforeEach(() => {
  bills.decisions.length = 0
  bills.holds = 0
  bills.refusal = null
})

describe("the approval queue", () => {
  test("an org-wide approver sees every pending obligation in their org, oldest due first", async () => {
    const service = harness()
    assert.deepEqual(await listed(service), ["B-1", "B-2"])
  })

  test("a project approver sees only the projects where they hold bill.approve", async () => {
    assert.deepEqual(await listed(harness({ approves: [PROJECT_A] })), ["B-1"])
  })

  test("someone who cannot approve anywhere is refused rather than shown an empty queue", async () => {
    const service = harness({ approves: [] })
    await assert.rejects(service.run(() => listMobilePayables(service.context)), status(403))
    assert.deepEqual(service.reads("vendor_bills"), [])
  })

  test.todo("an assigned-only member whose org role holds bill.approve is still limited to their projects") // owner: payables — resolveApprovalScope treats any org-role bill.approve as org-wide (lib/mobile/payables.ts:95); an assigned-only approver is listed bills from projects they cannot open

  test("the page size is capped and the page count reports truncation", async () => {
    const many = Array.from({ length: 120 }, (_, n) => bill(10 + n, { due_date: "2026-11-01" }))
    const service = harness({ vendorBills: many })

    const page = await service.run(() => listMobilePayables(service.context, { pageSize: 500 }))

    assert.equal(page.payables.length, 100)
    assert.deepEqual(page.pagination, { page: 1, page_size: 100, total: 120, page_count: 2 })
  })

  test("a payable carries its outstanding amount, due countdown, lot and its own org's invoice document", async () => {
    const service = harness({
      vendorBills: [bill(1, { file_id: FILE, paid_cents: 2_500 })],
      tables: {
        files: [
          { id: FILE, org_id: ORG, file_name: "invoice.pdf", mime_type: "application/pdf", storage_path: `${ORG}/invoice.pdf` },
          { id: FILE, org_id: FOREIGN_ORG, file_name: "theirs.pdf", storage_path: `${FOREIGN_ORG}/theirs.pdf` },
        ],
        file_links: [],
        lots: [{ org_id: ORG, project_id: PROJECT_A, lot_number: "12", block: "C", community: { name: "Cypress Landing" } }],
      },
    })

    const [payable] = (await service.run(() => listMobilePayables(service.context))).payables

    assert.equal(payable.outstanding_cents, 7_500)
    assert.equal(payable.lot_label, "C-12")
    assert.equal(payable.community_name, "Cypress Landing")
    assert.equal(payable.document.download_url, `https://files.test/${ORG}/invoice.pdf`)
    assert.equal(typeof payable.days_until_due, "number")
  })
})

describe("one payable", () => {
  test("another org's payable is not found", async () => {
    const service = harness()
    await assert.rejects(service.run(() => getMobilePayable(service.context, bill(6).id)), status(404))
  })

  test("a blocking hold, or no approval right on its project, disables approval", async () => {
    bills.holds = 1
    const held = harness()
    assert.equal((await held.run(() => getMobilePayable(held.context, bill(1).id))).can_approve, false)

    bills.holds = 0
    const elsewhere = harness({ approves: [PROJECT_B] })
    assert.equal((await elsewhere.run(() => getMobilePayable(elsewhere.context, bill(1).id))).can_approve, false)

    const approver = harness()
    assert.equal((await approver.run(() => getMobilePayable(approver.context, bill(1).id))).can_approve, true)
  })
})

describe("deciding", () => {
  const decide = (body) => {
    const service = harness()
    return service.run(() => decideMobilePayable(service.context, bill(1).id, body))
  }

  test("an approval goes to the bill status service with the revision reviewed, without payment step-up", async () => {
    const result = await decide({ decision: "approved", expected_updated_at: STAMP })

    assert.equal(result.status, "approved")
    assert.deepEqual(bills.decisions, [
      { billId: bill(1).id, orgId: ORG, input: { status: "approved", expected_updated_at: STAMP } },
    ])
  })

  test("a decision made on a stale copy is a conflict", async () => {
    await assert.rejects(decide({ decision: "approved", expected_updated_at: "2026-01-01T00:00:00Z" }), status(409))
  })

  test("a decision without the reviewed revision, or a rejection without a reason, never reaches the service", async () => {
    for (const body of [{ decision: "approved" }, { decision: "rejected", expected_updated_at: STAMP, reason: "no" }]) {
      await assert.rejects(decide(body), status(400), JSON.stringify(body))
    }
    assert.deepEqual(bills.decisions, [])
  })

  test("a refusal from the status service is surfaced in its own words", async () => {
    bills.refusal = "This payable is no longer pending"
    await assert.rejects(
      decide({ decision: "approved", expected_updated_at: STAMP }),
      (error) => error.status === 422 && error.message === "This payable is no longer pending",
    )
  })

  test("a malformed payable id is refused", async () => {
    const service = harness()
    await assert.rejects(service.run(() => decideMobilePayable(service.context, "not-a-uuid", {})), status(400))
  })
})

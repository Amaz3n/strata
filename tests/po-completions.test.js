const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

// Boundaries: job-cost posting (the failure under test) and accounting delivery.
let postingFails = false
stubModule("lib/services/job-cost-actuals.ts", {
  async postJobCostActualsForVendorBill() {
    if (postingFails) throw new Error("Cost code is closed")
  },
})
stubModule("lib/services/accounting-sync.ts", {
  async enqueueVendorBillSync() {
    return { status: "skipped" }
  },
  async recordPayableAccountingEnqueueResult() {},
})

const { approvePoCompletion, listPortalPurchaseOrders } = freshRequire("lib/services/po-completions.ts")

const PROJECT = id(1)
const COMPANY = id(2)
const COMPLETION = id(3)
const PO = id(4)
const BILL = id(5)

describe("purchase orders on the trade portal", () => {
  const order = (n, status, changes = []) => ({
    id: id(100 + n),
    org_id: ORG,
    project_id: PROJECT,
    company_id: COMPANY,
    commitment_type: "purchase_order",
    title: `PO ${status}`,
    status,
    total_cents: 50_000,
    created_at: `2026-10-0${n}T00:00:00Z`,
    lines: [],
    changes,
    completions: [],
  })

  test("a trade sees only issued purchase orders and their approved revisions", async () => {
    const service = createServiceHarness({
      tables: {
        purchasing_settings: [{ org_id: ORG, pay_on_po_enabled: true }],
        lots: [],
        commitments: [
          order(1, "approved", [
            { id: id(201), title: "Approved VPO", status: "approved", total_cents: 1_000 },
            { id: id(202), title: "Pending VPO", status: "draft", total_cents: 9_000 },
          ]),
          order(2, "draft"),
          order(3, "cancelled"),
          order(4, "void"),
          order(5, "completed"),
        ],
      },
    })
    const access = { org_id: ORG, project_id: PROJECT, company_id: COMPANY, permissions: { can_view_purchase_orders: true } }

    const orders = await service.run(() => listPortalPurchaseOrders(access))

    assert.deepEqual(orders.map((po) => po.status).sort(), ["approved", "completed"])
    const approved = orders.find((po) => po.status === "approved")
    assert.deepEqual(approved.changes.map((change) => change.title), ["Approved VPO"])
  })
})

describe("approving a completion whose AP posting fails", () => {
  test("the minted bill is rejected and kept, and the completion returns to verified", async () => {
    postingFails = true
    const service = createServiceHarness({
      permissions: ["project.read", "bill.approve"],
      tables: {
        projects: [{ id: PROJECT, org_id: ORG }],
        po_completions: [{ id: COMPLETION, org_id: ORG, project_id: PROJECT, commitment_id: PO, status: "verified" }],
        vendor_bills: [],
      },
      rpc: {
        approve_po_completion: () => {
          service.db.vendor_bills.push({ id: BILL, org_id: ORG, commitment_id: PO, status: "approved", total_cents: 50_000 })
          Object.assign(service.db.po_completions[0], { status: "billed", vendor_bill_id: BILL, amount_cents: 50_000 })
          return { data: { completion_id: COMPLETION, vendor_bill_id: BILL, amount_cents: 50_000 }, error: null }
        },
      },
    })

    await assert.rejects(service.run(() => approvePoCompletion(COMPLETION)), /rolled back because AP posting failed: Cost code is closed/)

    assert.equal(service.db.vendor_bills.length, 1)
    assert.equal(service.db.vendor_bills[0].status, "rejected")
    assert.equal(service.db.vendor_bills[0].rejected_by, ACTOR)
    assert.match(service.db.vendor_bills[0].rejection_reason, /Cost code is closed/)
    assert.equal(service.db.po_completions[0].status, "verified")
    assert.equal(service.db.po_completions[0].vendor_bill_id, null)
    assert.deepEqual(service.writes("vendor_bills").map((write) => write.action), ["update"])
    postingFails = false
  })
})

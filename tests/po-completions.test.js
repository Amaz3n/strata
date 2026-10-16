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

const { approvePoCompletion, verifyPoCompletion } = freshRequire("lib/services/po-completions.ts")

const PROJECT = id(1)
const COMPANY = id(2)
const COMPLETION = id(3)
const PO = id(4)
const BILL = id(5)

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

describe("the money step needs a second person", () => {
  const OTHER = id(9)
  const INSPECTION = id(10)
  const setup = (completion, rpcCalls = []) => createServiceHarness({
    permissions: ["project.read", "bill.approve", "po_completion.verify"],
    tables: {
      projects: [{ id: PROJECT, org_id: ORG }],
      po_completions: [{ id: COMPLETION, org_id: ORG, project_id: PROJECT, commitment_id: PO, status: "verified", ...completion }],
      inspections: [
        { id: INSPECTION, org_id: ORG, project_id: PROJECT, status: "completed", result: "pass" },
        { id: id(11), org_id: ORG, project_id: PROJECT, status: "completed", result: "fail" },
      ],
      vendor_bills: [],
    },
    rpc: {
      approve_po_completion: () => {
        rpcCalls.push(true)
        return { data: { completion_id: COMPLETION, vendor_bill_id: BILL, amount_cents: 1_000 }, error: null }
      },
    },
  })

  test("whoever reported a completion cannot verify it", async () => {
    const service = setup({ status: "reported", reported_by_user_id: ACTOR })
    await assert.rejects(service.run(() => verifyPoCompletion(COMPLETION)), /someone else has to verify/)
    assert.equal(service.db.po_completions[0].status, "reported")
  })

  test("whoever reported or verified a completion cannot approve the payment", async () => {
    for (const row of [{ reported_by_user_id: ACTOR }, { verified_by: ACTOR }]) {
      const calls = []
      const service = setup(row, calls)
      await assert.rejects(service.run(() => approvePoCompletion(COMPLETION)), /someone else has to approve the payment/)
      assert.equal(calls.length, 0)
    }
    const calls = []
    const second = setup({ reported_by_user_id: OTHER, verified_by: OTHER }, calls)
    await second.run(() => approvePoCompletion(COMPLETION))
    assert.equal(calls.length, 1)
  })

  test("an inspection that did not pass cannot back an approval", async () => {
    const calls = []
    const service = setup({ verified_by: OTHER }, calls)
    await assert.rejects(service.run(() => approvePoCompletion(COMPLETION, undefined, { inspectionId: id(11) })), /completed, passed inspection/)
    assert.equal(calls.length, 0)
  })

  test("a passed inspection is stored with the completion before the approval runs", async () => {
    const service = setup({ verified_by: OTHER })
    await service.run(() => approvePoCompletion(COMPLETION, undefined, { inspectionId: INSPECTION }))
    assert.equal(service.db.po_completions[0].inspection_id, INSPECTION)
  })

  test("a waiver is recorded with who and why, and is audited as critical", async () => {
    const service = setup({ verified_by: OTHER })
    await assert.rejects(service.run(() => approvePoCompletion(COMPLETION, undefined, { inspectionWaiverReason: "no" })))
    await service.run(() => approvePoCompletion(COMPLETION, undefined, { inspectionWaiverReason: "Punch-list trade, nothing to inspect" }))
    const [row] = service.db.po_completions
    assert.equal(row.inspection_waived_reason, "Punch-list trade, nothing to inspect")
    assert.equal(row.inspection_waived_by, ACTOR)
    assert.ok(service.audits.some((entry) => entry.critical === true && entry.after?.inspection_waived_reason === "Punch-list trade, nothing to inspect"))
  })
})

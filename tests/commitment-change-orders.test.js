const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  approveCommitmentChangeOrder,
  createCommitmentChangeOrder,
  deleteCommitmentChangeOrder,
  listVarianceOrders,
  rejectVarianceOrder,
  updateCommitmentChangeOrder,
} = freshRequire("lib/services/commitment-change-orders.ts")

const PROJECT = id(1)
const PO = id(2)
const VPO = id(3)
const OVERAGE = id(4)
const BACKCHARGE = id(5)
const SOMEONE_ELSE = id(6)

const vpo = (overrides = {}) => ({
  id: VPO,
  org_id: ORG,
  project_id: PROJECT,
  commitment_id: PO,
  title: "VPO — Overage",
  status: "draft",
  total_cents: 25_000,
  reason_code_id: OVERAGE,
  requested_by: SOMEONE_ELSE,
  photo_file_ids: [],
  metadata: {},
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...overrides,
})

const HOME_FILE = id(8)
const FOREIGN_FILE = id(9)

function harness({ orders = [vpo()], permissions = ["project.read", "commitment.write", "vpo.request", "vpo.approve", "vpo.approve_large"] } = {}) {
  return createServiceHarness({
    permissions,
    tables: {
      files: [
        { id: HOME_FILE, org_id: ORG, project_id: PROJECT, archived_at: null },
        { id: FOREIGN_FILE, org_id: ORG, project_id: id(77), archived_at: null },
      ],
      projects: [{ id: PROJECT, org_id: ORG }],
      commitments: [{ id: PO, org_id: ORG, project_id: PROJECT, commitment_type: "purchase_order", title: "Framing PO", status: "approved" }],
      variance_reason_codes: [
        { id: OVERAGE, org_id: ORG, code: "OVR", label: "Overage", is_backcharge: false, is_active: true },
        { id: BACKCHARGE, org_id: ORG, code: "BC", label: "Damage", is_backcharge: true, is_active: true },
      ],
      purchasing_settings: [],
      commitment_change_orders: orders,
      commitment_change_order_lines: [],
    },
  })
}

const line = (unit_cost_cents) => ({ description: "Blocking", quantity: 1, unit_cost_cents })

describe("separation of duties on variance orders", () => {
  test("the requester is the signed-in actor, whatever the client sends", async () => {
    const service = harness({ orders: [] })

    const created = await service.run(() =>
      createCommitmentChangeOrder({
        input: { commitment_id: PO, reason_code_id: OVERAGE, title: "Extra blocking", requested_by: SOMEONE_ELSE, lines: [line(10_000)] },
      }),
    )

    assert.equal(created.requested_by, ACTOR)
    await assert.rejects(service.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: created.id })), /someone other than/)
  })

  test("a requested VPO keeps its reason: it cannot be cleared or swapped to change its approval band", async () => {
    const service = harness()
    for (const reason_code_id of [null, BACKCHARGE]) {
      await assert.rejects(
        service.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { reason_code_id } })),
        /cannot be changed/,
      )
    }
    assert.equal(service.db.commitment_change_orders[0].reason_code_id, OVERAGE)
  })

  test("a back-charge cannot be edited into a positive amount", async () => {
    const service = harness({ orders: [vpo({ reason_code_id: BACKCHARGE, total_cents: -5_000 })] })
    await assert.rejects(
      service.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { lines: [line(5_000)] } })),
      /negative total/,
    )
    assert.deepEqual(service.writes(), [])
  })
})

describe("deciding a variance order", () => {
  test("a pending VPO is approved by someone other than its requester", async () => {
    const service = harness()

    const approved = await service.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO }))

    assert.equal(approved.status, "approved")
    assert.equal(approved.approved_by, ACTOR)
    assert.equal(service.events.at(-1).eventType, "vpo.approved")
  })

  test("an approved VPO cannot be rejected, and a rejected one cannot be approved", async () => {
    const approved = harness({ orders: [vpo({ status: "approved" })] })
    await assert.rejects(approved.run(() => rejectVarianceOrder({ commitmentChangeOrderId: VPO, reason: "Too late" })), /pending/)
    assert.deepEqual(approved.writes(), [])

    const rejected = harness({ orders: [vpo({ status: "rejected" })] })
    await assert.rejects(rejected.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO })), /rejected/)
    assert.deepEqual(rejected.writes(), [])
  })

  test("a decision that lost a race to another decision reports it instead of overwriting", async () => {
    const service = harness()
    // Another reviewer rejects the VPO between this approver's read and write.
    service.tamper(
      "commitment_change_orders",
      (result) => {
        service.db.commitment_change_orders[0].status = "rejected"
        return result
      },
      { on: "select", times: 1 },
    )

    await assert.rejects(service.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO })), /changed while you were reviewing/)
    assert.equal(service.db.commitment_change_orders[0].status, "rejected")
    assert.equal(service.db.commitment_change_orders[0].approved_by ?? null, null)
  })
})

describe("the variance queue's division lens", () => {
  const NORTH = id(70)
  const SOUTH = id(71)
  const home = (n) => id(100 + n)
  // PostgREST's inner embed of the owning project, which the queue filters on.
  const order = (n) => vpo({ id: id(200 + n), project_id: home(n), title: `VPO ${n}`, project: { org_id: ORG } })

  function lensHarness(divisionIds) {
    return createServiceHarness({
      permissions: ["price_book.read", "project.read"],
      divisions: divisionIds ?? undefined,
      tables: {
        // 0: presold, the project has no division but its lot is North. 1: the project says North but its lot is South.
        // 2: ordinary North. 3: South.
        projects: [
          { id: home(0), org_id: ORG, division_id: null },
          { id: home(1), org_id: ORG, division_id: NORTH },
          { id: home(2), org_id: ORG, division_id: NORTH },
          { id: home(3), org_id: ORG, division_id: SOUTH },
        ],
        lots: [
          { id: id(300), org_id: ORG, project_id: home(0), division_id: NORTH },
          { id: id(301), org_id: ORG, project_id: home(1), division_id: SOUTH },
          { id: id(302), org_id: ORG, project_id: home(3), division_id: null },
        ],
        commitments: [],
        variance_reason_codes: [],
        commitment_change_orders: [0, 1, 2, 3].map(order),
        commitment_change_order_lines: [],
      },
    })
  }

  test("a home counts in the lot's division, falling back to the project's", async () => {
    const result = await lensHarness().run(() => listVarianceOrders({ divisionId: NORTH }))

    assert.deepEqual(result.items.map((item) => item.title).sort(), ["VPO 0", "VPO 2"])
    assert.equal(result.count, 2)
  })

  test("a lens outside the member's divisions lists nothing and reads nothing", async () => {
    const service = lensHarness([SOUTH])

    const result = await service.run(() => listVarianceOrders({ divisionId: NORTH }))

    assert.deepEqual(result.items, [])
    assert.deepEqual(service.reads().filter((query) => query.table === "commitment_change_orders"), [])
  })

  test("an unrestricted member with no lens sees every home", async () => {
    const result = await lensHarness().run(() => listVarianceOrders())

    assert.equal(result.items.length, 4)
  })
})

describe("a variance order an executed change order raised", () => {
  const raised = () => vpo({ origin: "design_studio_co", prime_change_order_id: id(50), requested_by: null, total_cents: 700_00 })

  test("purchasing re-prices it only with a reason, kept on the order", async () => {
    const service = harness({ orders: [raised()] })
    await assert.rejects(
      service.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { lines: [line(650_00)] } })),
      /Say why this variance order's price changed/,
    )
    assert.equal(service.db.commitment_change_orders[0].total_cents, 700_00)

    await service.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { lines: [line(650_00)], reprice_reason: "Vendor honoured the 2025 slab price" } }))
    const [order] = service.db.commitment_change_orders
    assert.equal(order.total_cents, 650_00)
    assert.deepEqual(order.metadata.repricings.map((entry) => [entry.reason, entry.from_cents, entry.to_cents]), [["Vendor honoured the 2025 slab price", 700_00, 650_00]])
  })

  test("it keeps its origin and is voided, never deleted", async () => {
    const service = harness({ orders: [raised()] })
    await assert.rejects(service.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { origin: "office" } })), /keeps its origin/)
    await assert.rejects(service.run(() => deleteCommitmentChangeOrder({ commitmentChangeOrderId: VPO })), /Void it instead/)
    assert.equal(service.db.commitment_change_orders.length, 1)
  })

  test("an office variance order is never passed off as one the change order raised", async () => {
    const service = harness()
    await assert.rejects(service.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { origin: "design_studio_co" } })), /keeps its origin/)
  })
})

describe("cost evidence and who may decide", () => {
  const large = (overrides = {}) => vpo({ total_cents: 150_000, evidence_file_ids: [], ...overrides })

  test("an order at or above the org's threshold is not approved without cost evidence", async () => {
    const service = harness({ orders: [large()] })
    await assert.rejects(service.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO })), /cost evidence/)
    assert.equal(service.db.commitment_change_orders[0].status, "draft")

    const attached = harness({ orders: [large({ evidence_file_ids: [HOME_FILE] })] })
    const approved = await attached.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO }))
    assert.equal(approved.status, "approved")
  })

  test("a back-charge always needs evidence, whatever the threshold says", async () => {
    const service = harness({ orders: [vpo({ reason_code_id: BACKCHARGE, total_cents: -5_000, evidence_file_ids: [] })] })
    await assert.rejects(service.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO })), /back-charge/i)
  })

  test("evidence the home does not own is refused when the order is raised or edited", async () => {
    const service = harness({ orders: [] })
    await assert.rejects(
      service.run(() => createCommitmentChangeOrder({ input: { commitment_id: PO, reason_code_id: OVERAGE, title: "Extra", evidence_file_ids: [FOREIGN_FILE], lines: [line(10_000)] } })),
      /cost evidence must be available and belong to this home/i,
    )
    assert.deepEqual(service.writes("commitment_change_orders"), [])

    const existing = harness()
    await assert.rejects(
      existing.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { evidence_file_ids: [FOREIGN_FILE] } })),
      /belong to this home/i,
    )
    await existing.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { evidence_file_ids: [HOME_FILE] } }))
    assert.deepEqual(existing.db.commitment_change_orders[0].evidence_file_ids, [HOME_FILE])
  })

  test("rejecting an order needs the same approver its amount does", async () => {
    const small = harness({ orders: [large({ evidence_file_ids: [HOME_FILE] })], permissions: ["project.read", "commitment.write", "vpo.approve"] })
    await assert.rejects(small.run(() => rejectVarianceOrder({ commitmentChangeOrderId: VPO, reason: "No" })))
    assert.equal(small.db.commitment_change_orders[0].status, "draft")

    const approver = harness({ orders: [large({ evidence_file_ids: [HOME_FILE] })] })
    assert.equal((await approver.run(() => rejectVarianceOrder({ commitmentChangeOrderId: VPO, reason: "No" }))).status, "rejected")
  })
})

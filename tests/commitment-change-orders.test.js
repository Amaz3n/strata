const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  approveCommitmentChangeOrder,
  createCommitmentChangeOrder,
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

function harness({ orders = [vpo()] } = {}) {
  return createServiceHarness({
    permissions: ["project.read", "commitment.write", "vpo.request", "vpo.approve", "vpo.approve_large"],
    tables: {
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

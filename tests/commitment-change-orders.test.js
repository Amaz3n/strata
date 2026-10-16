const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  approveCommitmentChangeOrder,
  createCommitmentChangeOrder,
  deleteCommitmentChangeOrder,
  createCommitmentChangeOrderFromClientChangeOrder,
  listVarianceOrders,
  markCommitmentChangeOrderExecutedFromEnvelope,
  rejectVarianceOrder,
  updateCommitmentChangeOrder,
  voidCommitmentChangeOrder,
  attachVarianceOrderEvidence,
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

const SUB = id(10)
const PO_LINE = id(11)
const HOME_BUDGET_LINE = id(12)
const FOREIGN_BUDGET_LINE = id(13)
const HOME_CODE = id(14)
const HOME_FILE = id(8)
const FOREIGN_FILE = id(9)

/** The locked edit the database performs: refuses a decided order or a stale revision, replaces lines, totals them. */
function reviseOrder(service) {
  return (args) => {
    const order = service.db.commitment_change_orders.find((row) => row.id === args.p_id)
    if (!order) return { data: null, error: { message: "Commitment change order not found" } }
    if (!["draft", "sent"].includes(order.status)) return { data: null, error: { message: "Only draft or sent commitment change orders can be edited." } }
    if ((order.updated_at ?? null) !== args.p_expected_updated_at) return { data: null, error: { message: "This change order changed while you were editing it. Reload and try again." } }
    if (args.p_lines) {
      service.db.commitment_change_order_lines = service.db.commitment_change_order_lines.filter((row) => row.commitment_change_order_id !== args.p_id)
      service.db.commitment_change_order_lines.push(...args.p_lines)
      order.total_cents = args.p_lines.reduce((sum, row) => sum + row.amount_cents, 0)
    }
    Object.assign(order, args.p_patch)
    return { data: order.total_cents, error: null }
  }
}

/** The locked void the database performs: refuses a claimed order or a stale status, then closes it with the reason. */
function voidOrder(service) {
  return (args) => {
    const order = service.db.commitment_change_orders.find((row) => row.id === args.p_id)
    if (!order) return { data: null, error: { message: "Commitment change order not found" } }
    if (order.status === "rejected") return { data: null, error: { message: "A rejected change order is already closed." } }
    if (order.status !== args.p_expected_status) return { data: null, error: { message: "This change order changed while you were reviewing it. Reload and try again." } }
    if (order.status === "approved" && service.db.po_completions.some((row) => row.commitment_id === order.commitment_id && ["reported", "verified", "approved", "billed"].includes(row.status) && (row.change_order_ids ?? []).includes(order.id))) {
      return { data: null, error: { message: "A completion already claims this variance order. Reject it, or raise an offsetting back-charge." } }
    }
    order.status = "voided"
    order.metadata = { ...order.metadata, void_reason: args.p_reason, voided_by: args.p_actor_id }
    return { data: order.id, error: null }
  }
}

/** The one-transaction create the database performs: the order with its total and every line, or nothing. */
function createOrder(service) {
  return (args) => {
    const commitment = service.db.commitments.find((row) => row.id === args.p_header.commitment_id)
    if (!commitment) return { data: null, error: { message: "Commitment not found" } }
    const orderId = id(500 + service.db.commitment_change_orders.length)
    service.db.commitment_change_orders.push({
      id: orderId, org_id: args.p_org_id, project_id: commitment.project_id, commitment_id: commitment.id, status: "draft",
      title: args.p_header.title, reason_code_id: args.p_header.reason_code_id, requested_by: args.p_header.requested_by, origin: args.p_header.origin,
      photo_file_ids: args.p_header.photo_file_ids, evidence_file_ids: args.p_header.evidence_file_ids, metadata: args.p_header.metadata,
      total_cents: args.p_lines.reduce((sum, row) => sum + row.amount_cents, 0), created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    })
    service.db.commitment_change_order_lines.push(...args.p_lines.map((row) => ({ ...row, commitment_change_order_id: orderId })))
    return { data: orderId, error: null }
  }
}

function harness({ orders = [vpo()], completions = [], permissions = ["project.read", "commitment.write", "vpo.request", "vpo.approve", "vpo.approve_large"] } = {}) {
  const service = createServiceHarness({
    rpc: { revise_commitment_change_order: (args) => reviseOrder(service)(args), void_commitment_change_order: (args) => voidOrder(service)(args), create_commitment_change_order: (args) => createOrder(service)(args) },
    permissions,
    tables: {
      files: [
        { id: HOME_FILE, org_id: ORG, project_id: PROJECT, archived_at: null },
        { id: FOREIGN_FILE, org_id: ORG, project_id: id(77), archived_at: null },
      ],
      projects: [{ id: PROJECT, org_id: ORG }],
      commitments: [
        { id: PO, org_id: ORG, project_id: PROJECT, commitment_type: "purchase_order", title: "Framing PO", status: "approved" },
        { id: SUB, org_id: ORG, project_id: PROJECT, commitment_type: "subcontract", title: "Framing subcontract", status: "approved" },
      ],
      commitment_lines: [{ id: PO_LINE, org_id: ORG, commitment_id: PO }],
      budget_lines: [{ id: HOME_BUDGET_LINE, org_id: ORG, budget: { project_id: PROJECT } }, { id: FOREIGN_BUDGET_LINE, org_id: ORG, budget: { project_id: id(77) } }],
      cost_codes: [{ id: HOME_CODE, org_id: ORG }],
      variance_reason_codes: [
        { id: OVERAGE, org_id: ORG, code: "OVR", label: "Overage", is_backcharge: false, is_active: true },
        { id: BACKCHARGE, org_id: ORG, code: "BC", label: "Damage", is_backcharge: true, is_active: true },
      ],
      purchasing_settings: [],
      commitment_change_orders: orders,
      commitment_change_order_lines: [],
      po_completions: completions,
    },
  })
  return service
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

describe("a change order on a purchase order is a variance order", () => {
  test("it needs a reason to be raised, whatever the settings say, and is never approved without one", async () => {
    const service = harness({ orders: [vpo({ reason_code_id: null, requested_by: null })] })
    service.db.purchasing_settings.push({ org_id: ORG, vpo_reason_code_required: false })

    await assert.rejects(service.run(() => createCommitmentChangeOrder({ input: { commitment_id: PO, title: "Extra", lines: [line(10_000)] } })), /variance reason is required/)
    await assert.rejects(service.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO })), /without a variance reason cannot be approved/)
    assert.equal(service.db.commitment_change_orders[0].status, "draft")
  })

  test("an order naming a home other than its commitment's is refused before anything is decided or written", async () => {
    const service = harness({ orders: [vpo({ project_id: id(78) })] })

    for (const act of [
      () => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO }),
      () => voidCommitmentChangeOrder({ commitmentChangeOrderId: VPO, reason: "Wrong home" }),
      () => rejectVarianceOrder({ commitmentChangeOrderId: VPO, reason: "Wrong home" }),
      () => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { title: "Renamed" } }),
    ]) await assert.rejects(service.run(act), /not on its commitment's home/)
    assert.deepEqual(service.writes("commitment_change_orders"), [])
  })

  test("an approval misses when the order was revised after it was read, so replaced evidence is never waved through", async () => {
    const service = harness({ orders: [vpo({ total_cents: 150_000, evidence_file_ids: [HOME_FILE] })] })
    service.tamper("commitment_change_orders", (result) => {
      Object.assign(service.db.commitment_change_orders[0], { evidence_file_ids: [], updated_at: "2026-10-02T00:00:00Z" })
      return result
    }, { on: "select", times: 1 })

    await assert.rejects(service.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO })), /changed while you were reviewing/)
    assert.equal(service.db.commitment_change_orders[0].status, "draft")
  })
})

describe("the variance queue's division lens", () => {
  const NORTH = id(70)
  const SOUTH = id(71)
  const home = (n) => id(100 + n)
  // PostgREST's inner embed of the owning project, which the queue filters on.
  const order = (n) => vpo({ id: id(200 + n), project_id: home(n), title: `VPO ${n}`, project: { org_id: ORG }, commitment: { commitment_type: "purchase_order" } })

  // What list_variance_order_page answers: this page's ids in newest-first order and the lens's exact count.
  const lensRpc = (service) => (args) => {
    const homes = new Set(service.db.projects.filter((project) => args.p_division_ids.includes(project.division_id)).map((project) => project.id))
    const inLens = service.db.commitment_change_orders.filter((row) => homes.has(row.project_id))
    return { data: inLens.slice(args.p_offset, args.p_offset + args.p_limit).map((row) => ({ id: row.id, total_count: String(inLens.length) })), error: null }
  }

  function lensHarness(divisionIds) {
    const service = createServiceHarness({
      permissions: ["price_book.read", "project.read"],
      divisions: divisionIds ?? undefined,
      rpc: { list_variance_order_page: (args) => lensRpc(service)(args) },
      tables: {
        projects: [
          { id: home(0), org_id: ORG, division_id: NORTH },
          { id: home(1), org_id: ORG, division_id: NORTH },
          { id: home(2), org_id: ORG, division_id: NORTH },
          { id: home(3), org_id: ORG, division_id: SOUTH },
        ],
        lots: [],
        commitments: [],
        variance_reason_codes: [],
        commitment_change_orders: [0, 1, 2, 3].map(order),
        commitment_change_order_lines: [],
      },
    })
    return service
  }

  test("a division lens pages through the database function, keeping its order and exact count", async () => {
    const service = lensHarness()
    const first = await service.run(() => listVarianceOrders({ divisionId: NORTH, pageSize: 2 }))
    const second = await service.run(() => listVarianceOrders({ divisionId: NORTH, pageSize: 2, page: 2 }))

    assert.deepEqual(first.items.map((item) => item.title), ["VPO 0", "VPO 1"])
    assert.deepEqual(second.items.map((item) => item.title), ["VPO 2"])
    assert.deepEqual([first.count, second.count], [3, 3])
    assert.deepEqual(service.writes().filter((query) => !query.table.startsWith("rpc:")), [])
  })

  test("a division with hundreds of homes pages instead of erroring", async () => {
    const homes = Array.from({ length: 450 }, (_, n) => n)
    const service = createServiceHarness({
      permissions: ["price_book.read", "project.read"],
      rpc: { list_variance_order_page: (args) => ({ data: homes.slice(args.p_offset, args.p_offset + args.p_limit).map((n) => ({ id: id(200 + n), total_count: "450" })), error: null }) },
      tables: {
        projects: homes.map((n) => ({ id: home(n), org_id: ORG, division_id: NORTH })),
        commitments: [],
        variance_reason_codes: [],
        commitment_change_orders: homes.map(order),
        commitment_change_order_lines: [],
      },
    })
    const result = await service.run(() => listVarianceOrders({ divisionId: NORTH, pageSize: 50, page: 9 }))
    assert.equal(result.items.length, 50)
    assert.equal(result.count, 450)
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

describe("voiding, editing and evidence on a decided order", () => {
  const approved = (overrides = {}) => vpo({ status: "approved", total_cents: 150_000, evidence_file_ids: [HOME_FILE], ...overrides })

  test("voiding needs the order's band permission and a reason, and is announced and audited", async () => {
    const small = harness({ orders: [approved()], permissions: ["project.read", "commitment.write", "vpo.approve"] })
    await assert.rejects(small.run(() => voidCommitmentChangeOrder({ commitmentChangeOrderId: VPO, reason: "Wrong vendor" })))
    assert.equal(small.db.commitment_change_orders[0].status, "approved")

    const approver = harness({ orders: [approved()] })
    await assert.rejects(approver.run(() => voidCommitmentChangeOrder({ commitmentChangeOrderId: VPO, reason: "" })), /why/i)
    const voided = await approver.run(() => voidCommitmentChangeOrder({ commitmentChangeOrderId: VPO, reason: "Wrong vendor" }))
    assert.equal(voided.status, "voided")
    assert.equal(voided.metadata.void_reason, "Wrong vendor")
    assert.equal(approver.events.at(-1).eventType, "vpo.voided")
    assert.equal(approver.audits.at(-1).critical, true)
  })

  test("an order a live completion claims cannot be voided, and a rejected one is closed", async () => {
    const claimed = harness({ orders: [approved()], completions: [{ id: id(30), org_id: ORG, commitment_id: PO, status: "billed", change_order_ids: [VPO] }] })
    await assert.rejects(claimed.run(() => voidCommitmentChangeOrder({ commitmentChangeOrderId: VPO, reason: "Wrong vendor" })), /completion already claims/)
    assert.equal(claimed.db.commitment_change_orders[0].status, "approved")
    const rejected = harness({ orders: [vpo({ status: "rejected" })] })
    await assert.rejects(rejected.run(() => voidCommitmentChangeOrder({ commitmentChangeOrderId: VPO, reason: "Wrong vendor" })), /already closed/)
  })

  test("a void that lost a race to another decision reports it", async () => {
    const service = harness({ orders: [vpo()] })
    service.tamper("commitment_change_orders", (result) => {
      service.db.commitment_change_orders[0].status = "approved"
      return result
    }, { on: "select", times: 1 })
    await assert.rejects(service.run(() => voidCommitmentChangeOrder({ commitmentChangeOrderId: VPO, reason: "Wrong vendor" })), /changed while you were reviewing/)
    assert.equal(service.db.commitment_change_orders[0].status, "approved")
  })

  test("an edit never lands on an order approved while it was being edited", async () => {
    const service = harness({ orders: [vpo({ updated_at: "2026-10-01T00:00:00Z" })] })
    service.tamper("commitment_change_orders", (result) => {
      service.db.commitment_change_orders[0].status = "approved"
      return result
    }, { on: "select", times: 1 })
    await assert.rejects(service.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { lines: [line(9_000_000)] } })), /Only draft or sent/)
    assert.equal(service.db.commitment_change_orders[0].total_cents, 25_000)
  })

  test("a stale edit is refused rather than overwriting a newer one", async () => {
    const service = harness({ orders: [vpo({ updated_at: "2026-10-01T00:00:00Z" })] })
    service.tamper("commitment_change_orders", (result) => {
      service.db.commitment_change_orders[0].updated_at = "2026-10-02T00:00:00Z"
      return result
    }, { on: "select", times: 1 })
    await assert.rejects(service.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { title: "Renamed" } })), /changed while you were editing/)
  })

  test("a requester or an approver attaches evidence to a pending order; a decided order is a record", async () => {
    const requester = harness({ permissions: ["project.read", "vpo.request"] })
    const attached = await requester.run(() => attachVarianceOrderEvidence({ commitmentChangeOrderId: VPO, fileIds: [HOME_FILE] }))
    assert.deepEqual(attached.evidence_file_ids, [HOME_FILE])
    const nobody = harness({ permissions: ["project.read"] })
    await assert.rejects(nobody.run(() => attachVarianceOrderEvidence({ commitmentChangeOrderId: VPO, fileIds: [HOME_FILE] })))
    const decided = harness({ orders: [approved({ evidence_file_ids: [] })] })
    await assert.rejects(decided.run(() => attachVarianceOrderEvidence({ commitmentChangeOrderId: VPO, fileIds: [HOME_FILE] })), /before a variance order is decided/)
    await assert.rejects(requester.run(() => attachVarianceOrderEvidence({ commitmentChangeOrderId: VPO, fileIds: [FOREIGN_FILE] })), /belong to this home/i)
  })
})

describe("creating and approving a variance order", () => {
  test("header and lines go through one database step, so a refused line leaves no order", async () => {
    const service = harness({ orders: [] })
    const created = await service.run(() => createCommitmentChangeOrder({
      input: { commitment_id: PO, reason_code_id: OVERAGE, title: "Extra", lines: [line(10_000), { ...line(5_000), budget_line_id: HOME_BUDGET_LINE, cost_code_id: HOME_CODE, commitment_line_id: PO_LINE }] },
    }))
    assert.equal(created.total_cents, 15_000)
    assert.equal(created.lines.length, 2)
    assert.deepEqual(service.writes("commitment_change_orders"), [])

    const refused = harness({ orders: [] })
    await assert.rejects(refused.run(() => createCommitmentChangeOrder({
      input: { commitment_id: PO, reason_code_id: OVERAGE, title: "Extra", lines: [{ ...line(5_000), budget_line_id: FOREIGN_BUDGET_LINE }] },
    })), /budget line does not belong to this home/)
    await assert.rejects(refused.run(() => createCommitmentChangeOrder({
      input: { commitment_id: PO, reason_code_id: OVERAGE, title: "Extra", lines: [{ ...line(5_000), cost_code_id: id(99) }] },
    })), /cost code was not found/)
    await assert.rejects(refused.run(() => createCommitmentChangeOrder({
      input: { commitment_id: PO, reason_code_id: OVERAGE, title: "Extra", lines: [{ ...line(5_000), commitment_line_id: id(98) }] },
    })), /purchase order line does not belong/)
    assert.deepEqual(refused.writes(), [])
    assert.deepEqual(refused.db.commitment_change_orders, [])
  })

  test("an edit's references are checked the same way", async () => {
    const service = harness()
    await assert.rejects(service.run(() => updateCommitmentChangeOrder({ commitmentChangeOrderId: VPO, input: { lines: [{ ...line(5_000), budget_line_id: FOREIGN_BUDGET_LINE }] } })), /budget line does not belong to this home/)
    assert.deepEqual(service.writes(), [])
  })

  test("an order is raised and approved only on an issued purchase order", async () => {
    for (const status of ["draft", "canceled", "complete"]) {
      const service = harness({ orders: [vpo()] })
      service.db.commitments[0].status = status
      await assert.rejects(service.run(() => createCommitmentChangeOrder({ input: { commitment_id: PO, reason_code_id: OVERAGE, title: "Extra", lines: [line(10_000)] } })), new RegExp(`this one is ${status}`))
      await assert.rejects(service.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO })), new RegExp(`this one is ${status}`))
      assert.equal(service.db.commitment_change_orders[0].status, "draft")
    }
  })

  test("money inputs stay inside the 32-bit columns", async () => {
    const service = harness({ orders: [] })
    const raise = (lines) => service.run(() => createCommitmentChangeOrder({ input: { commitment_id: PO, reason_code_id: OVERAGE, title: "Extra", lines } }))
    await assert.rejects(raise([line(3_000_000_000)]))
    await assert.rejects(raise([{ ...line(2_000_000_000), quantity: 2 }]))
    await assert.rejects(raise([line(2_000_000_000), line(2_000_000_000)]))
    await assert.rejects(raise([{ ...line(1), quantity: 2_000_000 }]))
    assert.deepEqual(service.db.commitment_change_orders, [])
  })
})

describe("an executed signature on a change order", () => {
  const signature = (commitmentChangeOrderId) => ({ orgId: ORG, commitmentChangeOrderId, envelopeId: id(40), documentId: id(41), executedFileId: HOME_FILE, signerEmail: "vendor@example.com" })
  const subcontractOrder = (overrides = {}) => vpo({ commitment_id: SUB, reason_code_id: null, requested_by: null, ...overrides })

  test("approves a plain subcontract change order and records the signature", async () => {
    const service = harness({ orders: [subcontractOrder()] })
    const executed = await service.run(() => markCommitmentChangeOrderExecutedFromEnvelope(signature(VPO)))
    assert.equal(executed.status, "approved")
    assert.equal(executed.executed_file_id, HOME_FILE)
    assert.equal(executed.metadata.executed_signature.signer_email, "vendor@example.com")
  })

  test("records but never approves a purchase-order change, however large and without evidence", async () => {
    const service = harness({ orders: [vpo({ total_cents: 25_000_000 })] })
    const executed = await service.run(() => markCommitmentChangeOrderExecutedFromEnvelope(signature(VPO)))
    assert.equal(executed.status, "draft")
    assert.equal(executed.approved_by ?? null, null)
    assert.equal(executed.executed_file_id, HOME_FILE)
  })

  test("never reopens a rejected or voided order", async () => {
    for (const status of ["rejected", "voided"]) {
      const service = harness({ orders: [subcontractOrder({ status })] })
      const result = await service.run(() => markCommitmentChangeOrderExecutedFromEnvelope(signature(VPO)))
      assert.equal(result.status, status)
      assert.deepEqual(service.writes("commitment_change_orders"), [])
    }
  })

  test("yields to a decision that landed while it was running", async () => {
    const service = harness({ orders: [subcontractOrder()] })
    service.tamper("commitment_change_orders", (result) => {
      service.db.commitment_change_orders[0].status = "rejected"
      return result
    }, { on: "select", times: 1 })
    await service.run(() => markCommitmentChangeOrderExecutedFromEnvelope(signature(VPO)))
    assert.equal(service.db.commitment_change_orders[0].status, "rejected")
    assert.equal(service.db.commitment_change_orders[0].executed_file_id ?? null, null)
  })
})

describe("a client change order's subcontract bridge", () => {
  test("does not offer purchase orders: their change is a variance order with a reason", async () => {
    const service = harness({ orders: [], permissions: ["project.read", "change_order.read", "commitment.write", "vpo.request"] })
    service.db.change_orders = [{ id: id(60), org_id: ORG, project_id: PROJECT, title: "Owner CO", total_cents: 1_000, lines: [] }]
    await assert.rejects(
      service.run(() => createCommitmentChangeOrderFromClientChangeOrder({ input: { change_order_id: id(60), commitment_id: PO } })),
      /raised as a variance order from Purchasing/,
    )
    assert.deepEqual(service.writes(), [])
  })
})

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")
const { mobileContext, status } = require("./support/mobile")

const {
  createMobileVarianceOrder,
  listMobileProjectPurchaseOrders,
  listMobileVarianceReasonCodes,
} = freshRequire("lib/mobile/purchasing.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const FOREIGN_PROJECT = id(3)
const PO = id(10)
const COMPANY = id(11)
const OVERAGE = id(20)
const BACKCHARGE = id(21)
const RETIRED = id(22)

const po = (n, overrides = {}) => ({
  id: id(10 + n),
  org_id: ORG,
  project_id: PROJECT,
  commitment_type: "purchase_order",
  title: `PO ${n}`,
  contract_number: `PO-${n}`,
  status: "approved",
  total_cents: 100_000,
  company_id: COMPANY,
  company: { name: "Framing Co" },
  ...overrides,
})

function harness({ permissions = ["project.read", "price_book.read", "vpo.request"], projects } = {}) {
  const service = createServiceHarness({
    permissions,
    projects,
    tables: {
      projects: [
        { id: PROJECT, org_id: ORG },
        { id: OTHER_PROJECT, org_id: ORG },
        { id: FOREIGN_PROJECT, org_id: id(99) },
      ],
      commitments: [
        po(0),
        po(1, { status: "draft" }),
        po(2, { status: "cancelled" }),
        po(3, { commitment_type: "subcontract" }),
        po(4, { project_id: OTHER_PROJECT }),
      ],
      variance_reason_codes: [
        { id: OVERAGE, org_id: ORG, label: "Overage", is_backcharge: false, is_active: true },
        { id: BACKCHARGE, org_id: ORG, label: "Damage", is_backcharge: true, is_active: true },
        { id: RETIRED, org_id: ORG, label: "Old", is_backcharge: false, is_active: false },
      ],
      commitment_change_orders: [],
      commitment_change_order_lines: [],
    },
  })
  service.context = mobileContext(service)
  return service
}

describe("purchase orders a field variance can be charged against", () => {
  test("only this project's issued purchase orders are offered", async () => {
    const service = harness()

    const orders = await service.run(() => listMobileProjectPurchaseOrders(service.context, PROJECT))

    assert.deepEqual(orders.map((order) => order.contract_number), ["PO-0"])
    assert.equal(orders[0].company_name, "Framing Co")
  })

  test("another org's project is not found, and a reader without price_book.read is refused", async () => {
    const service = harness()
    await assert.rejects(service.run(() => listMobileProjectPurchaseOrders(service.context, FOREIGN_PROJECT)), status(404))
    const noAccess = harness({ permissions: ["project.read"] })
    await assert.rejects(noAccess.run(() => listMobileProjectPurchaseOrders(noAccess.context, PROJECT)), status(403))
  })

  test("a member assigned to other projects cannot read or charge this project's purchase orders", async () => {
    const service = harness({ projects: [OTHER_PROJECT] })

    await assert.rejects(service.run(() => listMobileProjectPurchaseOrders(service.context, PROJECT)), status(403))
    await assert.rejects(
      service.run(() => createMobileVarianceOrder(service.context, PROJECT, { commitment_id: PO, reason_code_id: OVERAGE, amount_cents: 100, note: "x" })),
      status(403),
    )
    assert.deepEqual(service.writes(), [])
  })
})

describe("requesting a variance purchase order", () => {
  const request = (overrides = {}) => ({
    commitment_id: PO,
    reason_code_id: OVERAGE,
    amount_cents: 25_000,
    note: "Extra blocking at stair",
    client_id: id(30),
    ...overrides,
  })
  const create = (service, input, projectId = PROJECT) =>
    service.run(() => createMobileVarianceOrder(service.context, projectId, input))

  test("a request becomes a draft VPO with its line, and a retry returns the same record", async () => {
    const service = harness()

    const first = await create(service, request())
    const retry = await create(service, request())

    assert.equal(first.id, id(30))
    assert.equal(retry.id, first.id)
    assert.equal(first.status, "draft")
    assert.equal(first.origin, "field_mobile")
    assert.equal(first.requested_by, ACTOR)
    assert.equal(service.db.commitment_change_orders.length, 1)
    assert.deepEqual(
      service.db.commitment_change_order_lines.map((line) => line.amount_cents),
      [25_000],
    )
    assert.equal(service.events[0].eventType, "vpo.requested")
  })

  test("a positive backcharge, a retired reason, or a purchase order from elsewhere is refused", async () => {
    const service = harness()
    const invalid = [
      [request({ reason_code_id: BACKCHARGE }), PROJECT],
      [request({ reason_code_id: RETIRED }), PROJECT],
      [request({ commitment_id: id(14) }), PROJECT], // another project's PO
      [request({ commitment_id: id(13) }), PROJECT], // a subcontract
      [request({ amount_cents: 0 }), PROJECT],
    ]
    for (const [input, projectId] of invalid) {
      await assert.rejects(create(service, input, projectId), status(422), JSON.stringify(input))
    }
    assert.deepEqual(service.writes(), [])
  })

  test("a retry id that names another project's VPO is a conflict, not a read of it", async () => {
    const service = harness()
    await create(service, request({ commitment_id: id(14) }), OTHER_PROJECT)

    await assert.rejects(create(service, request()), status(409))
    assert.equal(service.db.commitment_change_orders.length, 1)
    assert.equal(service.db.commitment_change_orders[0].project_id, OTHER_PROJECT)
  })

  test("a backcharge is recorded as a credit", async () => {
    const service = harness()
    const vpo = await create(service, request({ reason_code_id: BACKCHARGE, amount_cents: -5_000 }))
    assert.equal(vpo.total_cents, -5_000)
  })
})

test("reason codes are only served for the caller's own organization", async () => {
  const service = harness()

  await assert.rejects(service.run(() => listMobileVarianceReasonCodes(service.context, id(99))), status(403))
  const codes = await service.run(() => listMobileVarianceReasonCodes(service.context, ORG))
  assert.deepEqual(codes.map((code) => code.label).sort(), ["Damage", "Overage"])
})

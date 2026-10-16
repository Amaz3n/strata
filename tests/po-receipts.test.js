"use strict"

/**
 * `lib/services/po-receipts.ts` — receiving against issued purchase orders and
 * purchasing's answer to a shortage. The rules that need a transaction (over-
 * receipt, idempotency, one shortage per line, the sweep) are proved in
 * po-receipts-db.test.js; this suite proves who may act, what is asked of the
 * database, who is told, and that a VPO raised for a shortage goes through the
 * variance-order service.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const notified = []
stubModule("@/lib/services/notifications", {
  NotificationService: class {
    async createAndQueue(input) {
      notified.push(input)
      return id(999)
    }
  },
})
const raised = []
stubModule("@/lib/services/commitment-change-orders", {
  createCommitmentChangeOrder: async (args) => {
    raised.push(args)
    return { id: id(70) }
  },
})

const receipts = freshRequire("lib/services/po-receipts.ts")

const PROJECT = id(1)
const PO = id(2)
const STUDS = id(3)
const SHORTAGE = id(4)
const RESOLVER = id(41)
const RESOLVER_ROLE = id(81)
const REASON = id(60)

const tables = () => ({
  projects: [{ id: PROJECT, org_id: ORG, name: "Lot 12" }],
  commitments: [{ id: PO, org_id: ORG, project_id: PROJECT, title: "Framing package", commitment_type: "purchase_order", status: "approved" }],
  commitment_lines: [{ id: STUDS, org_id: ORG, commitment_id: PO, description: "Studs", quantity: 100, unit: "ea", cost_code_id: null, budget_line_id: null, needed_by: "2026-11-02" }],
  po_shortages: [{ id: SHORTAGE, org_id: ORG, project_id: PROJECT, commitment_id: PO, commitment_line_id: STUDS, status: "open" }],
})

function harness({ permissions = ["po_receipt.record"], rpc = {} } = {}) {
  notified.length = 0
  raised.length = 0
  const service = createServiceHarness({
    tables: tables(),
    permissions,
    projects: [PROJECT],
    rpc: {
      record_po_receipt: () => ({ data: { id: id(10), project_id: PROJECT, commitment_id: PO, replayed: false, shortages: [] }, error: null }),
      close_po_line_short: () => ({ data: { id: SHORTAGE, project_id: PROJECT, opened: true }, error: null }),
      resolve_po_shortage: () => ({ data: { id: SHORTAGE }, error: null }),
      void_po_receipt: () => ({ data: { id: id(10) }, error: null }),
      ...rpc,
    },
  })
  // A purchasing manager, on a role that holds po_exception.resolve, besides the actor.
  service.db.memberships.push({ id: id(82), org_id: ORG, user_id: RESOLVER, status: "active", role_id: RESOLVER_ROLE, project_scope: "all", division_scope: "all", role: { permissions: [{ permission_key: "po_exception.resolve" }] } })
  service.db.project_members.push({ project_id: PROJECT, org_id: ORG, user_id: RESOLVER, status: "active", role: { permissions: [{ permission_key: "po_exception.resolve" }] } })
  service.db.memberships[0].role_id = id(80)
  service.db.role_permissions = [
    { role_id: RESOLVER_ROLE, permission_key: "po_exception.resolve" },
    ...permissions.map((permission_key) => ({ role_id: id(80), permission_key })),
  ]
  return service
}

const calls = (service, name) => service.queries.filter((query) => query.action === "rpc" && query.table === `rpc:${name}`)

const ticket = (overrides = {}) => ({
  commitmentId: PO,
  idempotencyKey: "ticket-1",
  lines: [{ commitmentLineId: STUDS, quantity: 40 }],
  ...overrides,
})

describe("receiving a delivery", () => {
  test("needs po_receipt.record on the home and asks the database for nothing otherwise", async () => {
    const service = harness({ permissions: ["commitment.read"] })
    await assert.rejects(service.run(() => receipts.recordPoReceipt(ticket())), /po_receipt\.record/)
    assert.deepEqual(calls(service, "record_po_receipt"), [])
  })

  test("sends the ticket, the lines and the retry key, in the receiver's name", async () => {
    const service = harness()
    const result = await service.run(() => receipts.recordPoReceipt(ticket({ ticketNumber: "T-9" })))
    const [call] = calls(service, "record_po_receipt")
    assert.equal(call.payload.p_idempotency_key, "ticket-1")
    assert.equal(call.payload.p_actor_id, service.userId)
    assert.equal(call.payload.p_ticket_number, "T-9")
    assert.deepEqual(call.payload.p_lines, [{ commitment_line_id: STUDS, quantity: 40, condition: "ok", note: null, over_receipt_reason: null }])
    assert.deepEqual(result, { id: id(10), replayed: false, shortageIds: [] })
    assert.deepEqual(notified, [])
  })

  test("refuses a ticket with nothing on it, the same line twice or a quantity of zero", async () => {
    const service = harness()
    await assert.rejects(service.run(() => receipts.recordPoReceipt(ticket({ lines: [] }))), /Receive at least one line/)
    await assert.rejects(
      service.run(() => receipts.recordPoReceipt(ticket({ lines: [{ commitmentLineId: STUDS, quantity: 1 }, { commitmentLineId: STUDS, quantity: 2 }] }))),
      /once per ticket/,
    )
    await assert.rejects(service.run(() => receipts.recordPoReceipt(ticket({ lines: [{ commitmentLineId: STUDS, quantity: 0 }] }))), /more than zero/)
    assert.deepEqual(calls(service, "record_po_receipt"), [])
  })

  test("a damaged line tells the people who resolve shortages, not the receiver", async () => {
    const service = harness({
      rpc: { record_po_receipt: () => ({ data: { id: id(10), project_id: PROJECT, commitment_id: PO, replayed: false, shortages: [{ id: SHORTAGE, commitment_line_id: STUDS, reason: "damaged" }] }, error: null }) },
    })
    await service.run(() => receipts.recordPoReceipt(ticket({ lines: [{ commitmentLineId: STUDS, quantity: 40, condition: "damaged", note: "Wet" }] })))
    assert.deepEqual(notified.map((note) => [note.userId, note.type, note.entityId]), [[RESOLVER, "po_shortage_opened", SHORTAGE]])
  })

  test("the database's refusal reaches the receiver", async () => {
    const service = harness({ rpc: { record_po_receipt: () => ({ data: null, error: { message: 'Receiving 101 of "Studs" puts it over the 100 ordered; say why' } }) } })
    await assert.rejects(service.run(() => receipts.recordPoReceipt(ticket())), /say why/)
  })

  test("closing a line short needs the same permission and tells purchasing once", async () => {
    const denied = harness({ permissions: ["commitment.read"] })
    await assert.rejects(denied.run(() => receipts.closePoLineShort({ commitmentLineId: STUDS, reason: "vendor_short" })), /po_receipt\.record/)
    const service = harness()
    await service.run(() => receipts.closePoLineShort({ commitmentLineId: STUDS, reason: "vendor_short", note: "Mill is out" }))
    assert.equal(calls(service, "close_po_line_short").length, 1)
    assert.deepEqual(notified.map((note) => note.userId), [RESOLVER])
  })
})

describe("purchasing answers a shortage", () => {
  const resolve = (service, input) => service.run(() => receipts.resolvePoShortage({ shortageId: SHORTAGE, ...input }))

  test("needs po_exception.resolve", async () => {
    const service = harness({ permissions: ["po_receipt.record"] })
    await assert.rejects(resolve(service, { resolution: "accepted_short", note: "Build with it" }), /po_exception\.resolve/)
    assert.deepEqual(calls(service, "resolve_po_shortage"), [])
  })

  test("a back-order needs a date that has not passed; accepting short or cancelling needs a reason", async () => {
    const service = harness({ permissions: ["po_exception.resolve"] })
    await assert.rejects(resolve(service, { resolution: "backordered" }), /date the back-order/)
    await assert.rejects(resolve(service, { resolution: "backordered", backorderDate: "2020-01-01" }), /passed/)
    await assert.rejects(resolve(service, { resolution: "accepted_short" }), /Say why/)
    await assert.rejects(resolve(service, { resolution: "cancelled", note: "no" }), /Say why/)
    assert.deepEqual(calls(service, "resolve_po_shortage"), [])
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
    await resolve(service, { resolution: "backordered", backorderDate: future })
    assert.equal(calls(service, "resolve_po_shortage")[0].payload.p_backorder_date, future)
  })

  test("a VPO is raised through the variance-order service and linked to the shortage", async () => {
    const service = harness({ permissions: ["po_exception.resolve"] })
    const result = await resolve(service, { resolution: "vpo", vpo: { reasonCodeId: REASON, quantity: 60, unitCostCents: 450 } })
    assert.equal(result.vpoId, id(70))
    assert.equal(raised.length, 1)
    assert.equal(raised[0].input.commitment_id, PO)
    assert.equal(raised[0].input.reason_code_id, REASON)
    assert.deepEqual(raised[0].input.lines.map((line) => [line.commitment_line_id, line.quantity, line.unit_cost_cents]), [[STUDS, 60, 450]])
    assert.equal(calls(service, "resolve_po_shortage")[0].payload.p_vpo_id, id(70))
  })

  test("a shortage that is already resolved raises nothing", async () => {
    const service = harness({ permissions: ["po_exception.resolve"] })
    service.db.po_shortages[0].status = "accepted_short"
    await assert.rejects(resolve(service, { resolution: "vpo", vpo: { reasonCodeId: REASON, quantity: 1, unitCostCents: 1 } }), /already resolved/)
    assert.deepEqual(raised, [])
  })

  test("voiding a receipt needs po_exception.resolve and a reason", async () => {
    const service = harness({ permissions: ["po_receipt.record"] })
    service.db.po_receipts = [{ id: id(10), org_id: ORG, project_id: PROJECT }]
    await assert.rejects(service.run(() => receipts.voidPoReceipt({ receiptId: id(10), reason: "Wrong PO" })), /po_exception\.resolve/)
    const buyer = harness({ permissions: ["po_exception.resolve"] })
    buyer.db.po_receipts = [{ id: id(10), org_id: ORG, project_id: PROJECT }]
    await assert.rejects(buyer.run(() => receipts.voidPoReceipt({ receiptId: id(10), reason: "x" })), /Say why/)
    await buyer.run(() => receipts.voidPoReceipt({ receiptId: id(10), reason: "Wrong PO" }))
    assert.equal(calls(buyer, "void_po_receipt").length, 1)
  })
})

describe("the need-by date", () => {
  test("needs commitment.write, is written once, and is audited with what it replaced", async () => {
    const denied = harness({ permissions: ["po_receipt.record"] })
    await assert.rejects(denied.run(() => receipts.setLineNeededBy({ commitmentLineId: STUDS, neededBy: "2026-11-09" })), /commitment\.write/)
    assert.deepEqual(denied.writes("commitment_lines"), [])

    const service = harness({ permissions: ["commitment.write"] })
    await service.run(() => receipts.setLineNeededBy({ commitmentLineId: STUDS, neededBy: "2026-11-09" }))
    assert.equal(service.db.commitment_lines[0].needed_by, "2026-11-09")
    assert.deepEqual(service.audits.map((audit) => [audit.entityType, audit.before, audit.after]), [["commitment_line", { needed_by: "2026-11-02" }, { needed_by: "2026-11-09" }]])
    assert.equal(service.events[0].eventType, "commitment_line.needed_by_set")

    await service.run(() => receipts.setLineNeededBy({ commitmentLineId: STUDS, neededBy: "2026-11-09" }))
    assert.equal(service.audits.length, 1, "setting the same date again changes nothing")
  })

  test("a date cannot be set on a complete order", async () => {
    const service = harness({ permissions: ["commitment.write"] })
    service.db.commitments[0].status = "complete"
    await assert.rejects(service.run(() => receipts.setLineNeededBy({ commitmentLineId: STUDS, neededBy: "2026-11-09" })), /complete or canceled/)
  })
})

describe("the Deliveries desk", () => {
  const queueRow = { line_id: STUDS, commitment_id: PO, project_id: PROJECT, project_name: "Lot 12", po_title: "Framing package", contract_number: null, vendor_name: "Lumber Co", cost_code_id: null, description: "Studs", unit: "ea", ordered: "100", received: "40", outstanding: "60", needed_by: "2026-11-02", expected_date: "2026-11-02", days_late: 3, state: "late", shortage_id: null, shortage_status: null, shortage_reason: null, backorder_date: null, total_count: "7" }

  test("reads through the queue with the reader's division scope and says how many there are", async () => {
    const division = id(5)
    const service = createServiceHarness({
      tables: tables(), permissions: ["price_book.read"], divisions: [division],
      rpc: { list_po_delivery_queue: () => ({ data: [queueRow], error: null }) },
    })
    const result = await service.run(() => receipts.listPoDeliveries({ state: "late", page: 2, pageSize: 10 }))
    const [call] = calls(service, "list_po_delivery_queue")
    assert.deepEqual([call.payload.p_division_ids, call.payload.p_state, call.payload.p_limit, call.payload.p_offset], [[division], "late", 10, 10])
    assert.deepEqual([result.total, result.rows[0].outstanding, result.rows[0].state, result.rows[0].daysLate], [7, 60, "late", 3])
  })

  test("a lens outside the reader's divisions reads nothing", async () => {
    const service = createServiceHarness({
      tables: tables(), permissions: ["price_book.read"], divisions: [id(5)],
      rpc: { list_po_delivery_queue: () => ({ data: [queueRow], error: null }) },
    })
    const result = await service.run(() => receipts.listPoDeliveries({ divisionId: id(6) }))
    assert.deepEqual([result.rows, result.total], [[], 0])
    assert.deepEqual(calls(service, "list_po_delivery_queue"), [])
  })

  test("needs price_book.read", async () => {
    const service = harness({ permissions: ["po_receipt.record"] })
    await assert.rejects(service.run(() => receipts.listPoDeliveries({})), /price_book\.read/)
  })
})

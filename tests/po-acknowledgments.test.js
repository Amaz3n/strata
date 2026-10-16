"use strict"

/**
 * The vendor-facing half of purchase order acknowledgment: what a vendor's
 * portal lists (every home on an account link, capped and counted, with no
 * pay-on-PO gate on visibility), who may answer, and the pure state rules.
 * Transaction rules (stale version, one open answer, the lock) are proved in
 * po-acknowledgments-db.test.js.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

stubModule("@/lib/services/notifications", { NotificationService: class { async createAndQueue() { return id(999) } } })

const PROJECT = id(1)
const OTHER = id(2)
const COMPANY = id(3)

const order = (n, status, project = PROJECT, changes = []) => ({
  id: id(100 + n), org_id: ORG, project_id: project, company_id: COMPANY, commitment_type: "purchase_order",
  title: `PO ${status}`, status, total_cents: 50_000, created_at: `2026-10-0${n}T00:00:00Z`,
  project: { name: project === PROJECT ? "Lot 12" : "Lot 40" }, lines: [], changes, completions: [],
})

describe("purchase orders on the trade portal", () => {
  const portal = freshRequire("lib/services/portal-purchase-orders.ts")
  const harness = (commitments, extra = {}) => createServiceHarness({
    tables: { purchasing_settings: [], lots: [], po_issue_versions: [], po_acknowledgments: [], commitments, ...extra },
  })
  const access = (overrides = {}) => ({
    org_id: ORG, project_id: PROJECT, company_id: COMPANY, permissions: { can_view_purchase_orders: true }, ...overrides,
  })

  test("a trade sees only issued purchase orders and their approved revisions, pay-on-PO or not", async () => {
    const service = harness([
      order(1, "approved", PROJECT, [
        { id: id(201), title: "Approved VPO", status: "approved", total_cents: 1_000 },
        { id: id(202), title: "Pending VPO", status: "draft", total_cents: 9_000 },
      ]),
      order(2, "draft"), order(3, "cancelled"), order(4, "void"), order(5, "completed"),
    ])
    const { orders, canReportCompletion } = await service.run(() => portal.listPortalPurchaseOrders(access()))
    assert.deepEqual(orders.map((po) => po.status).sort(), ["approved", "completed"])
    assert.deepEqual(orders.find((po) => po.status === "approved").changes.map((change) => change.title), ["Approved VPO"])
    assert.equal(canReportCompletion, false)
  })

  test("a vendor-account link lists every home, a home's link only its own, and a missing permission is refused", async () => {
    const rows = [order(1, "approved", PROJECT), order(2, "approved", OTHER)]
    const all = await harness(rows).run(() => portal.listPortalPurchaseOrders(access({ project_id: null })))
    assert.deepEqual(all.orders.map((po) => po.projectName).sort(), ["Lot 12", "Lot 40"])
    assert.equal(all.total, 2)
    const one = await harness(rows).run(() => portal.listPortalPurchaseOrders(access()))
    assert.deepEqual(one.orders.map((po) => po.projectName), ["Lot 12"])
    await assert.rejects(harness(rows).run(() => portal.listPortalPurchaseOrders(access({ permissions: {} }))), /Access denied/)
  })

  test("the page is capped and says how many it left out", async () => {
    const many = Array.from({ length: portal.PORTAL_PURCHASE_ORDER_CAP + 5 }, (_, i) => ({ ...order(1, "approved"), id: id(1000 + i) }))
    const result = await harness(many).run(() => portal.listPortalPurchaseOrders(access({ project_id: null })))
    assert.equal(result.orders.length, portal.PORTAL_PURCHASE_ORDER_CAP)
    assert.equal(result.total, portal.PORTAL_PURCHASE_ORDER_CAP + 5)
  })
})

describe("answering from the portal", () => {
  const acknowledgments = freshRequire("lib/services/po-acknowledgments.ts")
  const PO = id(150)
  const input = (overrides = {}) => ({
    commitmentId: PO, issueVersionId: id(160), termsHash: "a".repeat(64), response: "accepted", ...overrides,
  })
  const run = (access, payload, rpc = () => ({ data: { id: id(170), project_id: PROJECT, title: "PO", contract_number: null, revision: 1, created_by: null }, error: null })) =>
    createServiceHarness({
      tables: { commitments: [{ id: PO, org_id: ORG, project_id: PROJECT }], memberships: [], role_permissions: [], projects: [] },
      rpc: { record_po_acknowledgment: rpc },
    }).run(() => acknowledgments.acknowledgePoFromPortal(access, payload, "Frame Co"))
  const link = (overrides = {}) => ({ id: id(61), org_id: ORG, project_id: PROJECT, company_id: COMPANY, permissions: { can_acknowledge_purchase_orders: true }, ...overrides })

  test("needs the acknowledge permission and a company", async () => {
    await assert.rejects(run(link({ permissions: { can_view_purchase_orders: true } }), input()), /permission/)
    await assert.rejects(run(link({ company_id: null }), input()), /permission/)
    assert.deepEqual(await run(link(), input()), { id: id(170) })
  })

  test("a home's link cannot answer another home's order", async () => {
    await assert.rejects(run(link({ project_id: OTHER }), input()), /not part of this link/)
  })

  test("a dispute needs a reason and a line, and a stale answer is the database's refusal", async () => {
    await assert.rejects(run(link(), input({ response: "disputed" })), /why|line/i)
    const line = { commitmentLineId: id(180), kind: "quantity", proposedQuantity: 80 }
    await assert.rejects(run(link(), input({ response: "disputed", reason: "Short", lines: [line] }), () => ({ data: null, error: { message: "The purchase order changed; reload to see the current version" } })), /changed; reload/)
  })
})

describe("acknowledgment state", () => {
  const state = freshRequire("lib/purchasing/po-acknowledgment-state.ts")
  const lock = freshRequire("lib/purchasing/po-lock.ts")

  test("state follows the current version's answer; a revision or re-issue asks again", () => {
    const derive = (answer, earlier = false, backfill = false) => state.derivePoAckState({ answer, answeredEarlierVersion: earlier, versionIsBackfill: backfill })
    assert.equal(derive(null), "pending")
    assert.equal(derive(null, true), "revised")
    assert.equal(derive(null, false, true), "unrequested")
    assert.equal(derive({ response: "accepted", status: "open", resolution: null }), "accepted")
    assert.equal(derive({ response: "disputed", status: "open", resolution: null }), "disputed")
    assert.equal(derive({ response: "disputed", status: "resolved", resolution: "upheld" }), "pending")
    assert.equal(derive({ response: "disputed", status: "resolved", resolution: "withdrawn" }), "closed")
    assert.equal(state.poAckWarning("accepted"), null)
    assert.match(state.poAckWarning("disputed"), /disputes/)
  })

  test("version changes are described and the obligation is the order plus approved VPOs", () => {
    const line = (qty) => ({ id: "l1", description: "Studs", quantity: qty, unit: "ea", unit_cost_cents: 100, scheduled_value_cents: qty * 100 })
    const snap = (qty, changes = []) => ({ title: "PO", contract_number: null, scope: null, terms: null, start_date: null, end_date: null, total_cents: qty * 100, retainage_percent: 0, company_id: "c", lines: [line(qty)], changes })
    assert.deepEqual(state.describeVersionChanges(null, snap(1)), [])
    assert.deepEqual(state.describeVersionChanges(snap(10), snap(10)), [])
    assert.deepEqual(state.describeVersionChanges(snap(10), snap(12, [{ id: "v", title: "Extra", total_cents: 500 }])),
      ["Studs: quantity 10 to 12", "Variance order approved: Extra ($5.00)"])
    assert.equal(state.revisedObligationCents(snap(10, [{ id: "v", title: "x", total_cents: 500 }])), 1500)
  })

  test("the lock names exactly the terms an update changes", () => {
    const existing = { title: "PO", scope: "S", terms: null, contract_number: "1", total_cents: 100, retainage_percent: 0, start_date: null, end_date: null }
    assert.deepEqual(lock.lockedTermsChanged(existing, { title: "PO", scope: "S", terms: "", total_cents: 100, retainage_percent: 0, start_date: "" }), [])
    assert.deepEqual(lock.lockedTermsChanged(existing, { scope: "T", total_cents: 200 }), ["scope", "amount"])
    assert.ok(lock.isIssuedPurchaseOrder("purchase_order", "approved"))
    assert.ok(!lock.isIssuedPurchaseOrder("purchase_order", "draft"))
    assert.ok(!lock.isIssuedPurchaseOrder("subcontract", "approved"))
  })
})

"use strict"

/**
 * `lib/services/trade-responses.ts` — a trade answers its assigned work from the
 * portal; coordinators close declines and approve new dates. The transaction
 * rules (stale dates, assignment, one open answer) are proved in
 * trade-responses-db.test.js; this suite proves who may ask, who is told, and
 * that approving dates goes through the one bulk schedule move.
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

const responses = freshRequire("lib/services/trade-responses.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const COMPANY = id(3)
const FRAMING = id(11)
const ROOFING = id(12)
const SUPERINTENDENT = id(41)
const REQUEST = id(51)
const TOKEN = id(61)
const STAMP = "2026-10-01T12:00:00.000000+00:00"

const item = (itemId, projectId, name, start, end) => ({
  id: itemId, org_id: ORG, project_id: projectId, name, item_type: "task", status: "planned",
  start_date: start, end_date: end, constraint_type: "asap", updated_at: STAMP,
})

const tables = (requestOverrides = {}) => ({
  projects: [
    { id: PROJECT, org_id: ORG, name: "Lot 12", superintendent_id: SUPERINTENDENT },
    { id: OTHER_PROJECT, org_id: ORG, name: "Lot 13", superintendent_id: null },
  ],
  schedule_items: [
    item(FRAMING, PROJECT, "Framing", "2026-11-02", "2026-11-06"),
    item(ROOFING, OTHER_PROJECT, "Roofing", "2026-11-09", "2026-11-12"),
  ],
  schedule_dependencies: [],
  closings: [],
  outbox: [],
  trade_work_responses: [{
    id: REQUEST, org_id: ORG, schedule_item_id: FRAMING, status: "open", response: "reschedule_requested",
    issued_start: "2026-11-02", issued_end: "2026-11-06", proposed_start: "2026-11-09", proposed_end: "2026-11-13",
    ...requestOverrides,
  }],
})

// The actor is the home's coordinator: their role grants start.write.
const COORDINATOR_ROLE = id(81)

function harness({ permissions = ["start.write", "schedule.edit"], requestOverrides, rpc = {} } = {}) {
  notified.length = 0
  const service = createServiceHarness({
    tables: tables(requestOverrides),
    permissions,
    projects: [PROJECT],
    rpc: {
      record_trade_response: () => ({ data: { id: id(52), project_id: PROJECT, schedule_item_name: "Framing" }, error: null }),
      apply_schedule_reschedule: (args) => ({
        data: args.p_changes.map((change) => ({ id: change.id, project_id: PROJECT, old_start: "2026-11-02", new_start: change.start_date })),
        error: null,
      }),
      ...rpc,
    },
  })
  service.db.memberships[0].role_id = COORDINATOR_ROLE
  service.db.role_permissions = permissions.map((permission_key) => ({ role_id: COORDINATOR_ROLE, permission_key }))
  return service
}

const rpcCalls = (service, name) => service.queries.filter((query) => query.action === "rpc" && query.table === `rpc:${name}`)

const answer = (overrides) => ({
  orgId: ORG, companyId: COMPANY, portalTokenId: TOKEN, companyName: "Frame Co",
  response: {
    scheduleItemId: FRAMING, response: "accepted", issuedStart: "2026-11-02", issuedEnd: "2026-11-06", ...overrides,
  },
})

describe("a trade answers its work", () => {
  test("an acceptance is recorded and nobody is interrupted", async () => {
    const service = harness()
    await service.run(() => responses.respondToTradeWork(answer()))
    assert.equal(rpcCalls(service, "record_trade_response").length, 1)
    assert.deepEqual(notified, [])
  })

  test("a decline tells the home's superintendent and the coordinators who can act", async () => {
    const service = harness()
    await service.run(() => responses.respondToTradeWork(answer({ response: "declined", reason: "Crew is on another job" })))
    assert.deepEqual(notified.map((note) => note.userId).sort(), [service.userId, SUPERINTENDENT].sort())
    assert.ok(notified.every((note) => note.type === "trade_response_received" && note.projectId === PROJECT))
  })

  test("an answer needs a reason unless it is an acceptance, and new dates need both ends", async () => {
    const service = harness()
    await assert.rejects(service.run(() => responses.respondToTradeWork(answer({ response: "declined" }))), /Tell the builder why/)
    await assert.rejects(
      service.run(() => responses.respondToTradeWork(answer({ response: "reschedule_requested", reason: "Crew busy" }))),
      /Say which dates/,
    )
    assert.deepEqual(rpcCalls(service, "record_trade_response"), [])
  })

  test("a link scoped to one home cannot answer another home's task", async () => {
    const service = harness()
    await assert.rejects(
      service.run(() => responses.respondToTradeWork({ ...answer({ scheduleItemId: ROOFING }), projectId: PROJECT })),
      /not part of this link/,
    )
    assert.deepEqual(rpcCalls(service, "record_trade_response"), [])
  })

  test("the database's refusal reaches the trade", async () => {
    const service = harness({ rpc: { record_trade_response: () => ({ data: null, error: { message: "The dates changed; reload to see the current schedule" } }) } })
    await assert.rejects(service.run(() => responses.respondToTradeWork(answer())), /dates changed/)
  })
})

describe("a coordinator closes an answer", () => {
  test("closing needs start.write", async () => {
    const service = harness({ permissions: ["schedule.edit"] })
    await assert.rejects(
      service.run(() => responses.resolveTradeResponse({ responseId: REQUEST, resolution: "reschedule_declined" })),
      /start\.write/,
    )
    assert.deepEqual(rpcCalls(service, "resolve_trade_response"), [])
  })

  test("an answer the coordinator's session cannot see is not closed", async () => {
    const service = harness()
    await assert.rejects(
      service.run(() => responses.resolveTradeResponse({ responseId: id(77), resolution: "acknowledged" })),
      /not found/,
    )
    assert.deepEqual(rpcCalls(service, "resolve_trade_response"), [])
  })

  test("approving new dates applies them through the bulk move and closes the request with it", async () => {
    const service = harness()
    await service.run(() => responses.approveTradeReschedule({ responseId: REQUEST }))
    const [call] = rpcCalls(service, "apply_schedule_reschedule")
    assert.equal(call.payload.p_response_id, REQUEST)
    assert.deepEqual(call.payload.p_changes.map((change) => [change.id, change.start_date, change.end_date]), [[FRAMING, "2026-11-09", "2026-11-13"]])
  })

  test("a request whose task has since moved cannot be approved", async () => {
    const service = harness({ requestOverrides: { issued_end: "2026-11-05" } })
    await assert.rejects(service.run(() => responses.approveTradeReschedule({ responseId: REQUEST })), /moved after the trade asked/)
    assert.deepEqual(rpcCalls(service, "apply_schedule_reschedule"), [])
  })

  test("a request that is already closed cannot be approved again", async () => {
    const service = harness({ requestOverrides: { status: "resolved" } })
    await assert.rejects(service.run(() => responses.approveTradeReschedule({ responseId: REQUEST })), /already closed/)
  })
})

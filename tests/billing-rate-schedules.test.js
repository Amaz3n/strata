"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { assignBillingRateScheduleToProject } = freshRequire("lib/services/billing-rate-schedules.ts")

const PROJECT = id(1)
const SCHEDULE = id(2)
const CONTRACT = id(3)

const MANAGER = ["project.manage"]

/** A T&M project with an active $5,000 contract and an active rate schedule. */
function project({ settings = null, scheduleStatus = "active", permissions = MANAGER } = {}) {
  return createServiceHarness({
    tables: {
      projects: [{ id: PROJECT, org_id: ORG, name: "Original project" }],
      billing_rate_schedules: [{ id: SCHEDULE, org_id: ORG, status: scheduleStatus }],
      contracts: [
        {
          id: CONTRACT,
          org_id: ORG,
          project_id: PROJECT,
          status: "active",
          contract_type: "time_materials",
          title: "Original contract",
          total_cents: 500000,
          currency: "usd",
          snapshot: { preserved: "original" },
          created_at: "2026-09-01T00:00:00Z",
        },
      ],
      project_financial_settings: settings ? [{ id: id(4), org_id: ORG, project_id: PROJECT, ...settings }] : [],
    },
    permissions,
  })
}

const contract = (service) => service.db.contracts.find((row) => row.id === CONTRACT)

test("assigning a schedule keeps the contract's money and snapshot and records who did it", async () => {
  const service = project()

  await service.run(() => assignBillingRateScheduleToProject({ projectId: PROJECT, rateScheduleId: SCHEDULE }))

  const saved = contract(service)
  assert.equal(saved.rate_schedule_id, SCHEDULE)
  assert.equal(saved.total_cents, 500000)
  assert.equal(saved.title, "Original contract")
  assert.equal(saved.snapshot.preserved, "original")
  assert.equal(saved.snapshot.rate_schedule_id, SCHEDULE)
  assert.equal(service.audits.at(-1).actorId, ACTOR)
  assert.deepEqual(
    service.events.map((event) => [event.eventType, event.payload.rate_schedule_id]),
    [["billing_rate_schedule_assigned", SCHEDULE]],
  )
})

test("the project's cost-approval and open-book requirements survive assigning and removing a schedule", async () => {
  for (const rateScheduleId of [SCHEDULE, null]) {
    const service = project({
      settings: { billing_model: "time_and_materials", client_cost_approval_required: true, open_book_required: false },
    })
    await service.run(() => assignBillingRateScheduleToProject({ projectId: PROJECT, rateScheduleId }))

    const saved = contract(service)
    assert.equal(saved.rate_schedule_id, rateScheduleId)
    assert.equal(saved.requires_client_cost_approval, true)
    assert.equal(saved.open_book, false)
  }
})

test("assignment is refused without permission, for an archived schedule, a fixed-price project or unreadable settings", async () => {
  const cases = [
    { name: "no project.manage", options: { permissions: [] } },
    { name: "archived schedule", options: { scheduleStatus: "archived" }, error: /Archived/ },
    { name: "fixed-price project", options: { settings: { billing_model: "fixed_price" } }, error: /time-and-materials/ },
    { name: "settings read fails", tamper: true, error: /Failed to load project financial settings/ },
  ]
  for (const { name, options = {}, tamper, error } of cases) {
    const service = project(options)
    if (tamper) service.tamper("project_financial_settings", replies.error("settings query unavailable"))
    await assert.rejects(
      service.run(() => assignBillingRateScheduleToProject({ projectId: PROJECT, rateScheduleId: SCHEDULE })),
      error,
      name,
    )
    assert.deepEqual(service.writes("contracts"), [], name)
    assert.deepEqual(service.events, [], name)
  }
})

const { approveTimeEntry } = freshRequire("lib/services/cost-plus.ts")

const ENTRY = id(10)

function pendingTime(permissions, { trade = false } = {}) {
  return createServiceHarness({
    tables: {
      org_settings: trade ? [{ org_id: ORG, settings: { business_profile: { kind: "trade", specialty: "Electrical" } } }] : [],
      projects: [{ id: PROJECT, org_id: ORG, name: "T&M job", property_type: "residential" }],
      contracts: [
        {
          id: CONTRACT,
          org_id: ORG,
          project_id: PROJECT,
          status: "active",
          contract_type: "time_materials",
          total_cents: 0,
          snapshot: {},
          requires_client_cost_approval: false,
          created_at: "2026-09-01T00:00:00Z",
        },
      ],
      project_financial_settings: [{ id: id(4), org_id: ORG, project_id: PROJECT, cost_codes_enabled: false, billing_model: "time_and_materials" }],
      time_entries: [
        {
          id: ENTRY,
          org_id: ORG,
          project_id: PROJECT,
          status: "submitted",
          worker_name: "Crew",
          hours: 8,
          work_date: "2026-10-01",
          base_rate_cents: 3000,
          burden_multiplier: 1,
          is_billable: true,
        },
      ],
    },
    permissions,
  })
}

test("a foreman's time.approve is enough to approve crew time, in a trade or builder org; bill.approve still is; neither is refused", async () => {
  for (const trade of [true, false]) {
    for (const permissions of [["time.approve", "project.read"], ["bill.approve", "project.read"]]) {
      const service = pendingTime(permissions, { trade })
      const approved = await service.run(() => approveTimeEntry(ENTRY))
      const label = `${trade ? "trade" : "builder"} ${permissions[0]}`
      assert.equal(approved.status, "pm_approved", label)
      assert.equal(approved.approved_by_pm_user_id, ACTOR, label)
      assert.equal(service.db.billable_costs?.length, 1, `${label}: approval makes the time a billable cost without a second step`)
      assert.equal(service.db.billable_costs[0].status, "open", label)
      // No rate schedule, person rate or membership bill rate: the hours are kept at $0, never guessed.
      assert.equal(service.db.billable_costs[0].metadata.billing_rate_source, "none", label)
    }

    const refused = pendingTime(["time.write", "invoice.write", "project.read"], { trade })
    await assert.rejects(refused.run(() => approveTimeEntry(ENTRY)))
    assert.deepEqual(refused.writes("time_entries"), [])
  }
})

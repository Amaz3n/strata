"use strict"

/**
 * Scheduled report delivery (`lib/services/report-configs.ts`): one email per
 * occurrence however many workers wake up, and a failed send is retried with
 * the very same snapshot, attachment and idempotency key.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { stubModule, freshRequire } = require("./support/modules")
require("./support/reports")

// Building the report is the report workspace's contract (its own suite);
// rendering and sending are external boundaries. The catalog is the shared
// report fixture.
let renders = 0
let evaluations = 0
let sent = []
let sendSucceeds = true
stubModule("@/lib/services/report-workspace", {
  authorizeReport: async () => ({}),
  evaluateReport: async (_definition, context) => ({
    context,
    result: { provenance: { generatedAt: `evaluation-${++evaluations}` }, tables: [] },
  }),
})
stubModule("@/lib/pdfs/report", { renderReportPdf: async () => Buffer.from(`pdf-render-${++renders}`) })
stubModule("@/lib/services/mailer", {
  escapeHtml: (value) => value,
  getOrgSenderEmail: () => "reports@example.test",
  renderStandardEmailLayout: () => "<p>Report</p>",
  sendEmail: async (payload) => {
    sent.push(structuredClone(payload))
    return sendSucceeds
  },
})

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")

const { nextScheduledRun, processDueReportSchedules } = freshRequire("lib/services/report-configs.ts")

const SCHEDULE = id(1)
const CONFIG = id(2)
const DUE = "2026-01-01T13:00:00.000Z"

function reports({ permissions = ["report.read"] } = {}) {
  renders = 0
  evaluations = 0
  sent = []
  sendSucceeds = true
  return createServiceHarness({
    tables: {
      orgs: [{ id: ORG, product_tier: "residential" }],
      report_runs: [],
      report_schedules: [
        {
          id: SCHEDULE,
          org_id: ORG,
          saved_config_id: CONFIG,
          created_by: ACTOR,
          recipient_emails: ["owner@example.test"],
          is_active: true,
          next_run_at: DUE,
          cadence: "monthly",
          month_day: 1,
          send_hour_utc: 13,
          delivery_claimed_until: null,
          delivery_payload: null,
          last_error: null,
          config: {
            id: CONFIG,
            org_id: ORG,
            user_id: ACTOR,
            name: "Monthly receivables",
            slug: "ops",
            scope: "org",
            project_id: null,
            division_id: null,
            community_id: null,
            params: { period: "lastmonth" },
            format: "pdf",
          },
        },
      ],
    },
    permissions,
  })
}

const schedule = (service) => service.db.report_schedules[0]

test("overlapping workers deliver an occurrence once and move the schedule on", async () => {
  const service = reports()

  await service.run(() => Promise.all([processDueReportSchedules(), processDueReportSchedules()]))

  assert.equal(sent.length, 1)
  assert.equal(sent[0].idempotencyKey, `report-schedule/${SCHEDULE}:${DUE}`)
  assert.deepEqual(sent[0].to, ["owner@example.test"])
  assert.equal(service.db.report_runs.length, 1)
  assert.equal(schedule(service).delivery_claimed_until, null)
  assert.ok(schedule(service).next_run_at > DUE)
})

test("a failed send is retried with the same snapshot, attachment and idempotency key", async () => {
  const service = reports()
  sendSucceeds = false

  const [failure] = await service.run(() => processDueReportSchedules())
  assert.equal(failure.ok, false)
  assert.match(schedule(service).last_error, /not sent/)
  assert.equal(schedule(service).next_run_at, DUE)

  schedule(service).delivery_claimed_until = null // the lease expires
  sendSucceeds = true
  const [success] = await service.run(() => processDueReportSchedules())

  assert.equal(success.ok, true)
  assert.equal(service.db.report_runs.length, 1)
  assert.equal(sent.length, 2)
  assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey)
  assert.deepEqual(sent[0].attachments, sent[1].attachments)
  assert.equal(schedule(service).delivery_payload, null)
})

test("a schedule whose owner lost report access sends nothing", async () => {
  const service = reports({ permissions: [] })

  const [outcome] = await service.run(() => processDueReportSchedules())

  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /no longer has permission/)
  assert.deepEqual(sent, [])
  assert.equal(schedule(service).next_run_at, DUE)
})

test("the next run is always in the future, across month and year ends", () => {
  const cases = [
    [{ cadence: "monthly", month_day: 1, send_hour_utc: 13 }, "2026-12-31T16:00:00Z", "2027-01-01T13:00:00.000Z"],
    [{ cadence: "monthly", month_day: 15, send_hour_utc: 9 }, "2026-03-15T09:00:00Z", "2026-04-15T09:00:00.000Z"],
    [{ cadence: "weekly", weekday: 1, send_hour_utc: 8 }, "2026-10-05T08:00:00Z", "2026-10-12T08:00:00.000Z"],
    [{ cadence: "daily", send_hour_utc: 6 }, "2026-10-05T05:00:00Z", "2026-10-05T06:00:00.000Z"],
  ]
  for (const [schedule, from, expected] of cases) {
    assert.equal(nextScheduledRun(schedule, new Date(from)), expected, JSON.stringify(schedule))
  }
})

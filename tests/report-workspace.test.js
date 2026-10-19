"use strict"

/**
 * Who may run a report, and what the server does with its parameters
 * (`lib/services/report-workspace.ts`).
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { stubModule, freshRequire } = require("./support/modules")
const reports = require("./support/reports")

const { createServiceHarness, id, ORG } = require("./support/service")

const { authorizeReport, buildReportPacket, evaluateReport } = freshRequire("lib/services/report-workspace.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const SAVED = id(3)
const COLLEAGUE = id(4)

function workspace({ permissions = ["report.read"], projects, savedConfigs = [], booksEnabled = true } = {}) {
  reports.reset({ booksEnabled })
  return createServiceHarness({
    tables: {
      projects: [
        { id: PROJECT, org_id: ORG, name: "Lot 12" },
        { id: OTHER_PROJECT, org_id: ORG, name: "Lot 13" },
      ],
      saved_report_configs: savedConfigs,
    },
    permissions,
    projects,
  })
}

const orgContext = (params) => ({ scope: "org", scopeLabel: "Organization-wide", posture: "residential", params })

test("report.read opens operational reports but not Books statements or margins", async () => {
  const service = workspace()
  await service.run(() => authorizeReport("ops"))
  await assert.rejects(service.run(() => authorizeReport("books-test")), /do not have access/)
  await assert.rejects(service.run(() => authorizeReport("margin")), /do not have access/)
})

test("Books statements stay closed while Arc Books is disabled, even for an administrator", async () => {
  const service = workspace({ permissions: ["*"], booksEnabled: false })
  await assert.rejects(service.run(() => authorizeReport("books-test")), /Enable Arc Books/)
  await service.run(() => authorizeReport("ops"))
})

test("a project report also needs access to that project", async () => {
  const service = workspace({ permissions: ["report.read", "project.read"], projects: [OTHER_PROJECT] })
  await assert.rejects(service.run(() => authorizeReport("ops", PROJECT)))
  await service.run(() => authorizeReport("ops", OTHER_PROJECT))
})

test("a custom range reaches the report while the saved parameters keep their relative meaning", async () => {
  const service = workspace()
  const result = await service.run(() =>
    evaluateReport(reports.definitions.ops, orgContext({ period: "custom", _from: "2026-02-01", _to: "2026-02-28" })),
  )
  assert.equal(reports.lastRun().params.period, "range:2026-02-01:2026-02-28")
  assert.equal(result.context.params.period, "custom")
  assert.equal(result.context.params._division, "")
})

test("impossible dates and backwards ranges are refused rather than reported", async () => {
  const service = workspace()
  for (const [from, to, error] of [
    ["2026-02-30", "2026-03-01", /valid date/],
    ["2026-03-01", "2026-02-01", /Start date/],
  ]) {
    await assert.rejects(
      service.run(() => evaluateReport(reports.definitions.ops, orgContext({ period: "custom", _from: from, _to: to }))),
      error,
    )
  }
})

test("the server applies the saved layout and commentary on top of the untouched base report", async () => {
  const service = workspace()
  const layout = JSON.stringify({ tables: { data: { labels: { amount: "Receivable" } } }, notes: "Owner review" })
  const result = await service.run(() => evaluateReport(reports.definitions.ops, orgContext({ _layout: layout })))
  assert.equal(result.result.tables[0].columns[1].header, "Receivable")
  assert.equal(result.base.tables[0].columns[1].header, "Amount")
  assert.equal(result.result.commentary, "Owner review")
})

test("a packet only includes members the actor may see, and remembers them for later reads", async () => {
  const member = (overrides) => ({
    id: SAVED,
    org_id: ORG,
    name: "Ops",
    slug: "ops",
    scope: "org",
    project_id: null,
    division_id: null,
    community_id: null,
    params: {},
    ...overrides,
  })
  const packet = orgContext({ _packet: JSON.stringify([SAVED]) })

  const restricted = workspace({ savedConfigs: [member({ slug: "books-test", user_id: reports.ACTOR })] })
  await assert.rejects(restricted.run(() => buildReportPacket(packet)), /do not have access/)

  const privateToColleague = workspace({ savedConfigs: [member({ user_id: COLLEAGUE })] })
  await assert.rejects(privateToColleague.run(() => buildReportPacket(packet)), /private/)

  const shared = workspace({ savedConfigs: [member({ user_id: COLLEAGUE, params: { _visibility: "team" } })] })
  const result = await shared.run(() => buildReportPacket(packet))
  assert.deepEqual(result.sources, [{ slug: "ops", projectId: undefined }])
  assert.equal(result.tables[0].title, "Ops")
  assert.equal(result.tables[0].locked, true)
})

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

const { freshRequire } = require("./support/modules")
const reports = require("./support/reports")

const { createServiceHarness, id, ORG } = require("./support/service")

const { getReportRun } = freshRequire("lib/services/report-runs.ts")

const RUN = id(1)

function savedPacket(permissions) {
  reports.reset()
  return createServiceHarness({
    tables: {
      report_runs: [
        {
          id: RUN,
          org_id: ORG,
          slug: "report-packet",
          scope: "org",
          project_id: null,
          params: {},
          title: "Board packet",
          format: "view",
          created_at: "2026-10-01T00:00:00Z",
          snapshot: { tables: [], sources: [{ slug: "ops" }, { slug: "books-test" }] },
        },
      ],
    },
    permissions,
  })
}

test("reading a saved packet rechecks access to every report inside it", async () => {
  await assert.rejects(savedPacket(["report.read"]).run(() => getReportRun(RUN)), /do not have access/)

  const run = await savedPacket(["report.read", "books.read"]).run(() => getReportRun(RUN))
  assert.equal(run.id, RUN)
  assert.deepEqual(
    run.snapshot.sources.map((source) => source.slug),
    ["ops", "books-test"],
  )
})

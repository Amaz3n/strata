// Repository-wide rules that no single module owns. Each one cites where the
// rule is written down; a rule nobody wrote down does not belong here.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8")

// docs/repository-health.md: "Cron handlers return HTTP 207 for partial
// failure so job_runs records them as failed rather than green."
test("fan-out cron handlers report partial failure as HTTP 207", () => {
  const fanOut = [
    "app/api/accounting/process-outbox/route.ts",
    "app/api/jobs/invoice-schedules/route.ts",
    "app/api/jobs/process-outbox/route.ts",
    "app/api/jobs/report-schedules/route.ts",
    "app/api/jobs/weekly-executive-snapshot/route.ts",
  ]
  assert.deepEqual(fanOut.filter((route) => !/\b207\b/.test(read(route))), [])
})

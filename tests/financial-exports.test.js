const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { createAccountingExport } = freshRequire("lib/services/financial-exports.ts")

const OWN_DIVISION = id(10)
const OTHER_DIVISION = id(11)

test("a division-limited exporter exports only their division's job cost", async () => {
  const service = createServiceHarness({
    tables: {
      projects: [
        { id: id(21), org_id: ORG, name: "Maple Lot 4", division_id: OWN_DIVISION, phase: "delivery", division: null },
        { id: id(22), org_id: ORG, name: "Oak Lot 9", division_id: OTHER_DIVISION, phase: "delivery", division: null },
      ],
      lots: [],
      job_cost_entries: [
        { id: id(31), org_id: ORG, project_id: id(21), incurred_on: "2026-09-10", cost_cents: 1_200_00, status: "posted", cost_code: null },
        { id: id(32), org_id: ORG, project_id: id(22), incurred_on: "2026-09-12", cost_cents: 9_900_00, status: "posted", cost_code: null },
      ],
    },
    permissions: ["financials.export", "project.read"],
    divisions: [OWN_DIVISION],
  })

  const { csv } = await service.run(() =>
    createAccountingExport({ kind: "job_cost", startDate: "2026-09-01", endDate: "2026-09-30" }),
  )

  const lines = csv.split("\n").slice(1)
  assert.deepEqual(lines, [`Maple Lot 4,${id(21)},,,Uncoded,2026-09,120000`])
})

describe("exports past PostgREST's 1,000-row response cap", () => {
  const PROJECT = id(41)
  const bill = (n) => ({
    id: id(5000 + n), org_id: ORG, project_id: PROJECT, bill_number: `B${n}`, bill_date: "2026-09-10", due_date: null,
    total_cents: 100, accounting_coding: null, company: { name: "Acme" }, commitment: null, status: "approved",
  })

  function scope(entries, bills = []) {
    return createServiceHarness({
      tables: {
        projects: [{ id: PROJECT, org_id: ORG, name: "Maple Lot 4", division_id: null, phase: "delivery", division: null }],
        lots: [],
        payments: [],
        vendor_bills: bills,
        job_cost_entries: entries,
      },
      permissions: ["financials.export", "project.read"],
      maxRows: 1000,
    })
  }
  const cost = (n) => ({ id: id(9000 + n), org_id: ORG, project_id: PROJECT, incurred_on: "2026-09-10", cost_cents: 100, status: "posted", cost_code: null })

  test("a job-cost export of 2,500 entries totals all of them", async () => {
    const service = scope(Array.from({ length: 2500 }, (_, n) => cost(n)))
    const { csv } = await service.run(() => createAccountingExport({ kind: "job_cost", startDate: "2026-09-01", endDate: "2026-09-30" }))
    assert.deepEqual(csv.split("\n").slice(1), [`Maple Lot 4,${PROJECT},,,Uncoded,2026-09,250000`])
  })

  test("an AP export of 1,500 bills lists every bill", async () => {
    const service = scope([], Array.from({ length: 1500 }, (_, n) => bill(n)))
    const { csv } = await service.run(() => createAccountingExport({ kind: "ap", startDate: "2026-09-01", endDate: "2026-09-30" }))
    assert.equal(csv.split("\n").length, 1501)
  })

  test("an export beyond the row ceiling fails instead of truncating", async () => {
    const service = scope(Array.from({ length: 50_001 }, (_, n) => cost(n)))
    await assert.rejects(
      service.run(() => createAccountingExport({ kind: "job_cost", startDate: "2026-09-01", endDate: "2026-09-30" })),
      /job-cost export: Validation limit exceeded/,
    )
  })
})

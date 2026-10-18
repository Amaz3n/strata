require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { reconcileDevelopment } = require("../lib/land/development-reconciliation")

const lots = [
  { id: "l1", phaseId: "p1", delivered: true },
  { id: "l2", phaseId: "p1", delivered: true },
  { id: "l3", phaseId: "p2", delivered: true },
  { id: "l4", phaseId: "p2", delivered: false },
  { id: "l5", phaseId: "p3", delivered: false },
]

test("actual cost is gross: the allocation's own job cost reversal is not netted out of it", () => {
  const { jobs } = reconcileDevelopment({
    phases: [{ id: "p1", developmentProjectId: "job" }],
    jobs: [{ projectId: "job", budgetCents: 500_000_00, committedCents: 450_000_00 }],
    costEntries: [
      { projectId: "job", sourceType: "vendor_bill", costCents: 300_000_00 },
      { projectId: "job", sourceType: "inventory_event", costCents: -120_000_00 },
    ],
    allocations: [{ projectId: "job", status: "approved", shares: [{ lotId: "l1", amountCents: 60_000_00 }, { lotId: "l2", amountCents: 60_000_00 }] }],
    lots,
  })
  assert.deepEqual(jobs, [{
    projectId: "job",
    phaseIds: ["p1"],
    budgetCents: 500_000_00,
    committedCents: 450_000_00,
    actualCents: 300_000_00,
    allocatedCents: 120_000_00,
    unallocatedCents: 180_000_00,
    flags: [],
  }])
})

test("a job shared by two phases reports its money once and lands allocations on each phase by its lots", () => {
  const { jobs, phases } = reconcileDevelopment({
    phases: [{ id: "p1", developmentProjectId: "job" }, { id: "p2", developmentProjectId: "job" }, { id: "p3", developmentProjectId: null }],
    jobs: [{ projectId: "job", budgetCents: 100_00, committedCents: 0 }],
    costEntries: [{ projectId: "job", sourceType: "vendor_bill", costCents: 90_00 }],
    allocations: [
      { projectId: "job", status: "approved", shares: [{ lotId: "l1", amountCents: 30_00 }, { lotId: "l3", amountCents: 20_00 }] },
      { projectId: "job", status: "proposed", shares: [{ lotId: "l4", amountCents: 40_00 }] },
    ],
    lots,
  })
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].allocatedCents, 50_00)
  assert.deepEqual(phases.map((phase) => [phase.phaseId, phase.allocatedCents, phase.deliveredLots, phase.lots, phase.sharedWithPhaseIds]), [
    ["p1", 30_00, 2, 2, ["p2"]],
    ["p2", 20_00, 1, 2, ["p1"]],
    ["p3", 0, 0, 1, []],
  ])
})

test("over budget, over-allocated and delivered-but-unallocated are flagged, and unallocated is never clamped", () => {
  const { jobs, phases } = reconcileDevelopment({
    phases: [{ id: "p1", developmentProjectId: "job" }, { id: "p2", developmentProjectId: "job" }],
    jobs: [{ projectId: "job", budgetCents: 100_00, committedCents: 0 }],
    costEntries: [{ projectId: "job", sourceType: null, costCents: 150_00 }],
    allocations: [{ projectId: "job", status: "approved", shares: [{ lotId: "l1", amountCents: 200_00 }] }],
    lots,
  })
  assert.deepEqual(jobs[0].flags, ["over_budget", "allocated_exceeds_actual"])
  assert.equal(jobs[0].unallocatedCents, -50_00)
  assert.deepEqual(phases.map((phase) => phase.flags), [[], ["delivered_without_allocation"]])
})

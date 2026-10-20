require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { projectModuleVisible, surfaceAllowsModule, workspaceModuleTitle, workspaceModules, workspaceRecord } = require("../lib/mobile/workspace-catalog")
const { BUILDER_SURFACE, resolveWorkspaceSurface } = require("../lib/workspace-surface")

const moduleNamed = (id) => workspaceModules.find((module) => module.id === id)

test("a native record carries only the module's declared fields", () => {
  const record = workspaceRecord(
    moduleNamed("tasks"),
    {
      id: "t1",
      title: "Inspect roof",
      description: "North wing",
      status: "todo",
      org_id: "secret",
      metadata: { private: true },
      access_token: "secret",
    },
    0,
  )

  assert.equal(record.title, "Inspect roof")
  assert.equal(record.fields.find((field) => field.key === "description").value, "North wing")
  assert.ok(!JSON.stringify(record).includes("secret"))
})

test("camelCase service DTOs project onto the same fields without losing dates", () => {
  const record = workspaceRecord(moduleNamed("ledger"), { id: "j1", entryKind: "adjustment", entryDate: "2026-10-01", memo: "Correction" }, 0)

  assert.equal(record.fields.find((field) => field.key === "entry_date").value, "2026-10-01")
  assert.equal(record.fields.find((field) => field.key === "entry_kind").value, "adjustment")
})

test("budget amounts are the service's integer cents", () => {
  const record = workspaceRecord(moduleNamed("budget"), { id: "b1", description: "Concrete", amount_cents: 12345 }, 0)
  assert.equal(record.fields.find((field) => field.key === "amount_cents").value, "12345")
})

test("a module's visibility follows the project's posture, phase and explicit overrides", () => {
  const meetings = moduleNamed("meetings")
  const cases = [
    [["residential", "construction"], false],
    [["commercial", "construction"], true],
    [["commercial", "construction", { meetings: false }], false],
    [["residential", "construction", { meetings: true }], true],
    [["commercial", "precon"], false],
  ]
  for (const [args, visible] of cases) {
    assert.equal(projectModuleVisible(meetings, ...args), visible, JSON.stringify(args))
  }
})

test("a trade company's catalog drops builder modules and names crew time, on the org and the job", () => {
  const trade = resolveWorkspaceSurface({ profile: { kind: "trade", specialty: "Electrical" }, planName: "Arc Trade", entitlements: [], now: new Date("2026-10-19T00:00:00Z") })
  const hidden = ["estimates", "bids", "selections", "sales", "communities", "plans", "design-studio", "starts", "purchasing", "warranty", "closeout"]
  for (const id of hidden) {
    const catalogModule = moduleNamed(id)
    if (catalogModule.scope !== "project") assert.equal(surfaceAllowsModule(catalogModule, trade), false, `${id} on the org`)
    if (catalogModule.scope !== "organization") assert.equal(surfaceAllowsModule(catalogModule, trade, {}), false, `${id} on a job`)
    assert.equal(surfaceAllowsModule(catalogModule, BUILDER_SURFACE, catalogModule.scope === "organization" ? undefined : {}), true, `${id} for a builder`)
  }
  for (const id of ["time", "billing", "payables", "change-orders", "tm-tickets", "schedule", "punch"]) {
    assert.equal(surfaceAllowsModule(moduleNamed(id), trade, {}), true, id)
  }
  assert.equal(surfaceAllowsModule(moduleNamed("rfis"), trade, {}), false, "RFIs join a trade job only by override")
  assert.equal(surfaceAllowsModule(moduleNamed("rfis"), trade, { rfis: true }), true)
  assert.equal(surfaceAllowsModule(moduleNamed("bids"), trade, { bids: true }), true, "a job's module override reopens bids")
  assert.equal(workspaceModuleTitle(moduleNamed("time"), trade), "Crew time")
  assert.equal(workspaceModuleTitle(moduleNamed("time"), BUILDER_SURFACE), "Time")
})

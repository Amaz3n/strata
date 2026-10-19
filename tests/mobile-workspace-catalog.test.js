require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { projectModuleVisible, workspaceModules, workspaceRecord } = require("../lib/mobile/workspace-catalog")

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

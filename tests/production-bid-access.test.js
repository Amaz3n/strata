"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubModule, freshRequire } = require("./support/modules")
const { createQueryRecorder } = require("./support/query-recorder")

let access = { assignedOnly: true, divisionIds: ["a"] }
stubModule("@/lib/services/authorization", { getDivisionAccessForUser: async () => access })
const { assertProductionBidAccess } = freshRequire("lib/services/production-bid-access.ts")

function check(scope, { limited = true, divisionIds = ["a"], rows }) {
  access = { assignedOnly: limited, divisionIds }
  const { client, calls } = createQueryRecorder((call) => ({ data: rows[call.table] ?? null, error: null }))
  return { run: assertProductionBidAccess(scope, { supabase: client, orgId: "org", userId: "user" }), calls }
}

test("a division-limited buyer is refused a community or plan outside their divisions", async () => {
  for (const [key, table] of [["community_id", "communities"], ["house_plan_id", "house_plans"]]) {
    await assert.rejects(check({ [key]: "parent" }, { rows: { [table]: { id: "parent", division_id: "b" } } }).run, /outside your division access/)
  }
})

test("both parents must pass, and every lookup is organization scoped", async () => {
  const { run, calls } = check(
    { community_id: "c", house_plan_id: "p" },
    { rows: { communities: { id: "c", division_id: "a" }, house_plans: { id: "p", division_id: null } } },
  )
  await run
  const scoped = calls.filter((call) => call.filters.some(([op, key, value]) => op === "eq" && key === "org_id" && value === "org"))
  assert.equal(scoped.length, 2)
})

test("an organization-wide plan on its own is refused with the reason, beside a community it is allowed", async () => {
  const rows = { communities: { id: "c", division_id: "a" }, house_plans: { id: "p", division_id: null } }
  await assert.rejects(check({ house_plan_id: "p" }, { rows }).run, /prices every division. Choose one of your communities/)
  await check({ community_id: "c", house_plan_id: "p" }, { rows }).run
})

test("unassigned communities and missing parents fail closed", async () => {
  await assert.rejects(check({ community_id: "c" }, { divisionIds: [], rows: { communities: { id: "c", division_id: null } } }).run, /outside your division access/)
  await assert.rejects(check({ house_plan_id: "missing" }, { rows: {} }).run, /not found/)
})

test("an unrestricted member may use any community and plan", async () => {
  await check({ community_id: "c" }, { limited: false, rows: { communities: { id: "c", division_id: "z" } } }).run
})

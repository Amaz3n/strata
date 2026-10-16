"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubModule, freshRequire } = require("./support/modules")
const { createQueryRecorder } = require("./support/query-recorder")

const division = "00000000-0000-4000-8000-000000000001"
const community = "00000000-0000-4000-8000-000000000002"

const state = { scope: { assignedOnly: false, divisionIds: [] }, denied: false }
stubModule("@/lib/services/context", { requireOrgContext: async () => state.context })
stubModule("@/lib/services/authorization", { getDivisionAccessForUser: async () => state.scope })
stubModule("@/lib/services/permissions", {
  requirePermission: async () => {
    if (state.denied) throw new Error("Forbidden")
  },
})
const { listProductionBidQueue } = freshRequire("lib/services/production-bid-queue.ts")

function harness({ scope = { assignedOnly: false, divisionIds: [] }, denied = false, errorTable = null, responses = [], rows = [], total = 1203 } = {}) {
  const { client, calls } = createQueryRecorder((call) => {
    // PostgREST answers 416 when the offset is past the last row, and still reports the total on a one-row page.
    if (call.table === "bid_packages" && call.range[0] >= total && call.range[0] > 0) {
      return { data: null, count: null, error: { code: "PGRST103", message: "Requested range not satisfiable" } }
    }
    const data = call.table === "bid_packages"
      ? (call.range[0] === 0 && call.range[1] === 0 ? rows.slice(0, 1) : rows)
      : responses.slice(call.range[0], call.range[1] + 1)
    return { data, count: total, error: errorTable === call.table ? { message: "database unavailable" } : null }
  })
  state.scope = scope
  state.denied = denied
  state.context = { supabase: client, orgId: "org", userId: "buyer" }
  return { calls, run: listProductionBidQueue }
}
const row = { id: "package", title: "Framing", status: "open", due_at: null, community: { name: "Oak" }, plan: { name: "A" }, invites: [{ count: 25 }] }

test("queue selects only production packages before applying stable pagination", async () => {
  const { run, calls } = harness({ rows: [row] })
  const result = await run({ page: 3, pageSize: 50, communityId: community })
  assert.equal(result.count, 1203)
  assert.deepEqual(calls[0].range, [100, 149])
  assert.ok(calls[0].filters.some(([op, key, value]) => op === "eq" && key === "award_target" && value === "price_agreement"))
  assert.ok(calls[0].filters.some(([op, key, value]) => op === "eq" && key === "community_id" && value === community))
  assert.equal(result.items[0].jobName, "Oak — A")
  assert.equal(result.items[0].invites, 25)
})

test("assigned division scope filters both parents without loading org ID rosters", async () => {
  const { run, calls } = harness({ scope: { assignedOnly: true, divisionIds: [division] } })
  await run()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].filters.some(([op, key, values]) => op === "in" && key === "community.division_id" && values[0] === division))
  assert.ok(calls[0].filters.some(([op, expression]) => op === "or" && expression.includes("plan.not.is.null")))
  assert.ok(calls[0].filters.some(([op, key, , value]) => op === "not" && key === "community_id" && value === null), "a plan-only package is not listed to a division-limited member")
})

test("forbidden and empty division access never read bid rows", async () => {
  const forbidden = harness({ denied: true })
  await assert.rejects(forbidden.run(), /Forbidden/)
  assert.equal(forbidden.calls.length, 0)
  const empty = harness({ scope: { assignedOnly: true, divisionIds: [] } })
  assert.equal((await empty.run()).count, 0)
  assert.equal(empty.calls.length, 0)
})

test("response totals read beyond the default database cap and stay within visible packages", async () => {
  const { run, calls } = harness({ rows: [row], responses: Array.from({ length: 1203 }, () => ({ invite: { bid_package_id: "package" } })) })
  const result = await run()
  assert.equal(result.items[0].responses, 1203)
  const reads = calls.filter((call) => call.table === "bid_submissions")
  assert.equal(reads.length, 3)
  assert.ok(reads.every((call) => call.filters.some(([op, key, ids]) => op === "in" && key === "invite.bid_package_id" && ids.length === 1 && ids[0] === "package")))
})

test("database failures cannot become empty queues or zero response totals", async () => {
  for (const errorTable of ["bid_packages", "bid_submissions"]) {
    const { run } = harness({ errorTable, rows: [row] })
    await assert.rejects(run(), /database unavailable/)
  }
})


test("search and explicit status filtering happen before pagination, including cancelled history", async () => {
  const { run, calls } = harness()
  await run({ search: "Framing_50%", status: "cancelled" })
  assert.ok(calls[0].filters.some(([op, key, value]) => op === "eq" && key === "status" && value === "cancelled"))
  assert.equal(calls[0].filters.some(([op, key]) => op === "neq" && key === "status"), false)
  assert.ok(calls[0].filters.some(([op, key, value]) => op === "ilike" && key === "title" && value === "%Framing\\_50\\%%"))
})

test("a page past the last row is an empty page that still reports the total", async () => {
  const { run } = harness({ rows: [row], total: 51 })
  const result = await run({ page: 4, pageSize: 25 })
  assert.equal(result.count, 51)
  assert.equal(result.items.length, 0)
})

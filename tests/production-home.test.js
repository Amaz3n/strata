const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")
const { createFakeSupabase } = require("./support/fake-supabase")
const { runWithServiceSupabaseClient } = require("@/lib/supabase/service-client-context")

const { getProductionHomeData } = freshRequire("lib/services/production-home.ts")

test("a failed project scope is an error, never an empty Home", async () => {
  const service = createServiceHarness({
    tables: {
      projects: [
        { id: id(1), org_id: ORG, phase: "delivery", property_type: "production", status: "active" },
      ],
    },
  })
  service.tamper("projects", replies.error("connection lost"))

  await assert.rejects(
    service.run(() => getProductionHomeData()),
    /Failed to scope production Home projects: connection lost/,
  )
  // Home never summarised an empty project list as "no active houses".
  assert.ok(!service.queries.some((query) => query.table === "rpc:production_home_stat_rollup"))
})

test("the stat rollup is called with the service client over the caller's authorized houses", async () => {
  const service = createServiceHarness({
    tables: {
      projects: [
        { id: id(1), org_id: ORG, phase: "delivery", property_type: "production", status: "active" },
      ],
    },
    // The signed-in client has no grant on the service-role-only function.
    rpc: {
      production_home_stat_rollup: () => ({ data: null, error: { message: "permission denied for function production_home_stat_rollup" } }),
    },
  })
  const calls = []
  const privileged = createFakeSupabase({}, {
    production_home_stat_rollup: (args) => {
      calls.push(args)
      return { data: { under_construction: 1 }, error: null }
    },
  })

  await service.run(() => runWithServiceSupabaseClient(privileged, () => getProductionHomeData()))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].p_org_id, ORG)
  assert.deepEqual(calls[0].p_project_ids, [id(1)])
})

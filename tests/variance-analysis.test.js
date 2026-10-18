"use strict"

/**
 * The purchasing variance report (`lib/services/reports/variance-analysis.ts`).
 * Org-wide it reads the `get_variance_analysis` aggregate; a division-limited
 * reader gets the same numbers computed from that division's homes. Either way
 * every row is read, budgets are counted once per home, and a failed read is
 * never a smaller total.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")
const { withTableRpc } = require("./support/postgrest-extras")

const { getVarianceAnalysis } = freshRequire("lib/services/reports/variance-analysis.ts")

const DIVISION = id(1)
const OTHER_DIVISION = id(2)
const SUPER = id(3)
const FIELD_ROLE = id(4)
const JANUARY = { startDate: "2026-01-01", endDate: "2026-01-31" }

/**
 * `homes` homes in DIVISION, each with one $1 approved variance order and a
 * latest budget of $100 (an older $50 version too); home 0 has a second order
 * under another reason.
 */
function homes(count) {
  const projects = Array.from({ length: count }, (_, i) => ({
    id: id(10_000 + i),
    org_id: ORG,
    division_id: DIVISION,
    division: { name: "North" },
  }))
  const order = (project, i, overrides = {}) => ({
    id: id(20_000 + i),
    org_id: ORG,
    project_id: project.id,
    status: "approved",
    total_cents: 100,
    approved_at: "2026-01-05T00:00:00Z",
    reason_code_id: "overrun",
    reason: { label: "Overrun" },
    company_id: "vendor",
    company: { name: "Vendor" },
    commitment: { commitment_type: "purchase_order" },
    ...overrides,
  })
  const orders = projects.map((project, i) => order(project, i))
  if (count) orders.push(order(projects[0], count, { reason_code_id: "redesign", reason: { label: "Redesign" } }))
  return {
    projects,
    commitment_change_orders: orders,
    lots: projects.map((project, i) => ({
      id: id(30_000 + i),
      org_id: ORG,
      project_id: project.id,
      division_id: DIVISION,
      community_id: "community",
      community: { name: "Cypress" },
      house_plan_id: "plan",
      house_plan: { name: "Aster" },
    })),
    budgets: projects.flatMap((project, i) => [
      { id: id(40_000 + i), org_id: ORG, project_id: project.id, total_cents: 10000, version: 2 },
      { id: id(50_000 + i), org_id: ORG, project_id: project.id, total_cents: 5000, version: 1 },
    ]),
    roles: [{ id: FIELD_ROLE, key: "field" }],
    project_members: projects.map((project, i) => ({
      id: id(60_000 + i),
      org_id: ORG,
      project_id: project.id,
      user_id: SUPER,
      role_id: FIELD_ROLE,
      status: "active",
      created_at: "2026-01-01",
      user: { full_name: "Sam Super" },
    })),
  }
}

const DATA_TABLES = ["projects", "commitment_change_orders", "lots", "budgets", "roles", "project_members"]

/**
 * A reader limited to `divisions` (or unrestricted), over `tables`. PostgREST
 * answers at most 1,000 rows per request. `aggregate` is what the org-wide
 * `get_variance_analysis` function returns.
 */
function report({ tables = homes(0), divisions = [DIVISION], permissions = ["price_book.read"], aggregate = [] } = {}) {
  const service = createServiceHarness({
    tables: { ...tables, get_variance_analysis: aggregate },
    permissions,
    divisions: divisions ?? undefined,
    maxRows: 1000,
  })
  // The aggregate is a set-returning function, which PostgREST pages like a table.
  withTableRpc(service, "get_variance_analysis", (args) => ({ org_id: args.p_org_id }))
  return service
}

const businessReads = (service) =>
  service.queries.filter((query) => query.action === "rpc" || DATA_TABLES.includes(query.table))

test("a division report counts every home past the first page and each home's latest budget once", async () => {
  const service = report({ tables: homes(1001) })

  const result = await service.run(() => getVarianceAnalysis({ ...JANUARY, divisionId: DIVISION }))

  assert.equal(result.scoped, true)
  assert.deepEqual(
    {
      incidence: result.summary.incidence,
      totalAbsoluteCents: result.summary.totalAbsoluteCents,
      directCostBudgetCents: result.summary.directCostBudgetCents,
      varianceRate: result.summary.varianceRate,
    },
    { incidence: 1002, totalAbsoluteCents: 100200, directCostBudgetCents: 10010000, varianceRate: 100200 / 10010000 },
  )
  const byDimension = (dimension) => result.rows.filter((row) => row.dimension === dimension)
  for (const dimension of ["superintendent", "community", "plan", "division", "vendor"]) {
    assert.equal(byDimension(dimension)[0].incidence, 1002, dimension)
  }
  assert.deepEqual(
    byDimension("reason").map((row) => [row.dimension_label, row.incidence]),
    [
      ["Overrun", 1001],
      ["Redesign", 1],
    ],
  )
})

test("a home whose project has no division counts through its lot, and a lot in another division does not", async () => {
  const tables = homes(3)
  // Home 0: presold, the project carries no division but the lot is in the reader's. Home 1: the project says
  // DIVISION but the lot is in another division, which the report (lot first) honours. Home 2: ordinary.
  tables.projects[0].division_id = null
  tables.lots[1].division_id = OTHER_DIVISION

  const result = await report({ tables }).run(() => getVarianceAnalysis({ ...JANUARY, divisionId: DIVISION }))

  assert.equal(result.summary.incidence, 3) // homes 0 (two orders) and 2
})

test("only orders approved inside the range count, up to the end of its last day", async () => {
  const tables = homes(4)
  const stamps = ["2025-12-31T23:59:59Z", "2026-01-01T00:00:00Z", "2026-01-31T23:30:00Z", "2026-02-01T00:00:00Z"]
  tables.commitment_change_orders = tables.commitment_change_orders
    .slice(0, 4)
    .map((order, i) => ({ ...order, approved_at: stamps[i] }))

  const result = await report({ tables }).run(() => getVarianceAnalysis({ ...JANUARY, divisionId: DIVISION }))

  assert.equal(result.summary.incidence, 2)
})

test("an unauthorized reader is refused and a forbidden division reads nothing", async () => {
  const denied = report({ tables: homes(2), permissions: [] })
  await assert.rejects(denied.run(() => getVarianceAnalysis({ ...JANUARY, divisionId: DIVISION })), /Missing permission/)
  assert.deepEqual(businessReads(denied), [])

  const hidden = report({ tables: homes(2), divisions: [OTHER_DIVISION] })
  const result = await hidden.run(() => getVarianceAnalysis({ ...JANUARY, divisionId: DIVISION }))
  assert.equal(result.summary.incidence, 0)
  assert.deepEqual(businessReads(hidden), [])
})

test("a failed read of any input fails the report instead of shrinking it", async () => {
  for (const table of DATA_TABLES) {
    const service = report({ tables: homes(2) })
    service.tamper(table, replies.error("offline"))
    await assert.rejects(service.run(() => getVarianceAnalysis({ ...JANUARY, divisionId: DIVISION })), /offline/, table)
  }
})

test("invalid ranges are refused before anything is read", async () => {
  for (const range of [
    { startDate: "2026-02-30", endDate: "2026-03-31" },
    { startDate: "2026-01-01", endDate: "2025-12-31" },
    { startDate: "2026-01-01", endDate: "2026-01-31T23:00:00Z" },
  ]) {
    const service = report({ tables: homes(1) })
    await assert.rejects(service.run(() => getVarianceAnalysis({ ...range, divisionId: DIVISION })), /Report/)
    assert.deepEqual(businessReads(service), [], JSON.stringify(range))
  }
})

test("the org-wide report reads every aggregate group and takes the budget from division groups only", async () => {
  const group = (dimension, i, overrides = {}) => ({
    org_id: ORG,
    dimension,
    dimension_id: `${dimension}-${String(i).padStart(5, "0")}`,
    dimension_label: `${dimension} ${i}`,
    net_variance_cents: 100,
    absolute_variance_cents: 100,
    incidence: 1,
    direct_cost_budget_cents: 10000,
    variance_rate: 0.01,
    ...overrides,
  })
  const aggregate = [
    ...Array.from({ length: 1001 }, (_, i) => group("reason", i)),
    group("division", 0, { incidence: 1001, absolute_variance_cents: 100100, direct_cost_budget_cents: 10000 }),
  ]
  const service = report({ divisions: null, aggregate, permissions: ["price_book.read", "project.read"] })

  const result = await service.run(() => getVarianceAnalysis(JANUARY))

  assert.equal(result.scoped, false)
  assert.equal(result.rows.length, 1002)
  assert.equal(result.summary.incidence, 1001)
  assert.equal(result.summary.directCostBudgetCents, 10000)

  const failing = report({ divisions: null, aggregate, permissions: ["price_book.read", "project.read"] })
  failing.tamper("get_variance_analysis", replies.error("offline"))
  await assert.rejects(failing.run(() => getVarianceAnalysis(JANUARY)), /offline/)
})

test("a home the division backstop hides from the member still reports, and the consistency check stays strict", async () => {
  const { runWithServiceOrgContext } = require("@/lib/services/context")
  const { runWithServiceSupabaseClient } = require("@/lib/supabase/service-client-context")
  const tables = homes(2)
  tables.projects[0].division_id = null // visible through its lot, hidden from a division-assigned member by RLS
  const service = report({ tables })
  const serviceClient = service.client
  // The member client sees no project row without a division; the privileged client sees everything.
  const memberClient = {
    ...serviceClient,
    from: (table) => {
      const query = serviceClient.from(table)
      if (table !== "projects") return query
      const select = query.select.bind(query)
      query.select = (...args) => select(...args).not("division_id", "is", null)
      return query
    },
  }
  const context = { supabase: memberClient, orgId: ORG, userId: service.userId, productTier: "residential" }
  const run = (work) => runWithServiceSupabaseClient(serviceClient, () => runWithServiceOrgContext(context, work))

  const result = await run(() => getVarianceAnalysis({ ...JANUARY, divisionId: DIVISION }))
  assert.equal(result.summary.incidence, 3)

  const missing = report({ tables: homes(2) })
  missing.db.projects.splice(0, 1)
  await assert.rejects(
    missing.run(() => getVarianceAnalysis({ ...JANUARY, divisionId: DIVISION })),
    /references missing projects/,
  )
})

test("a member limited to their own homes still sees their superintendents named, on the homes they can see only", async () => {
  const { runWithServiceOrgContext } = require("@/lib/services/context")
  const { runWithServiceSupabaseClient } = require("@/lib/supabase/service-client-context")
  const everything = homes(2)
  const mine = { ...homes(2), commitment_change_orders: everything.commitment_change_orders.filter((order) => order.project_id === everything.projects[0].id) }
  const privileged = report({ tables: everything, divisions: null, permissions: ["price_book.read"] })
  const member = report({ tables: mine, divisions: null, permissions: ["price_book.read"] })
  // The harness stands the actor up through project_members, so the report's own rows go in afterwards.
  privileged.db.project_members.push(...everything.project_members)
  const context = { supabase: member.client, orgId: ORG, userId: member.userId, productTier: "residential" }
  const run = () => runWithServiceSupabaseClient(privileged.client, () => runWithServiceOrgContext(context, () => getVarianceAnalysis(JANUARY)))

  const result = await run()

  assert.equal(result.scoped, true)
  const supers = result.rows.filter((row) => row.dimension === "superintendent")
  assert.deepEqual(supers.map((row) => [row.dimension_label, row.incidence]), [["Sam Super", 2]])
  assert.equal(result.summary.incidence, 2) // home 0's two orders; home 1 is not theirs
  assert.equal(privileged.queries.filter((query) => query.action === "rpc").length, 0)
})

test("the org-wide report reads the aggregate as the service role over an exclusive timestamp window", async () => {
  const { runWithServiceOrgContext } = require("@/lib/services/context")
  const { runWithServiceSupabaseClient } = require("@/lib/supabase/service-client-context")
  const aggregate = [
    { org_id: ORG, dimension: "superintendent", dimension_id: SUPER, dimension_label: "Sam Super", net_variance_cents: 100, absolute_variance_cents: 100, incidence: 1, direct_cost_budget_cents: 10000, variance_rate: 0.01 },
  ]
  const privileged = report({ divisions: null, aggregate, permissions: ["price_book.read", "project.read"] })
  const member = report({ divisions: null, aggregate: [], permissions: ["price_book.read", "project.read"] })
  const context = { supabase: member.client, orgId: ORG, userId: member.userId, productTier: "residential" }

  const result = await runWithServiceSupabaseClient(privileged.client, () =>
    runWithServiceOrgContext(context, () => getVarianceAnalysis(JANUARY)))

  assert.deepEqual(result.rows.map((row) => row.dimension_label), ["Sam Super"])
  const [call] = privileged.queries.filter((query) => query.action === "rpc")
  assert.deepEqual(
    [call.payload.p_start, call.payload.p_end_exclusive],
    ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
  )
})

"use strict"

/**
 * `lib/services/trade-lookahead.ts`: what a trade's look-ahead contains, how it
 * is paged and scoped, and what notices are built from it. Notice delivery
 * (reserve, send, record) is tested in trade-notices.test.js; here the delivery
 * function is a recorder that runs `build()`, so the tests see the exact notice
 * a trade would be sent.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { stubModule, freshRequire } = require("./support/modules")
const { createFakeSupabase } = require("./support/fake-supabase")
const { LOOKAHEAD_EXCLUDED_STATUSES, LOOKAHEAD_PO_STATUSES, scheduleChangeIsNotifiable, lookaheadWindow, overlapsWindow } = require("../lib/starts/lookahead-rules")

const ORG = "10000000-0000-4000-8000-000000000001"
const COMPANY = "10000000-0000-4000-8000-000000000002"
const COMMUNITY = "10000000-0000-4000-8000-000000000003"
const DIVISION = "10000000-0000-4000-8000-000000000004"
const ACTOR = "10000000-0000-4000-8000-000000000005"
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

function schedule(i, { multipleTrades = false, unresolved = false, status = "planned", start = 0, end = 1 } = {}) {
  return {
    id: `item-${String(i).padStart(6, "0")}`, org_id: ORG, project_id: `project-${i}`,
    "project.org_id": ORG, "project.property_type": "production", "project.status": "active", "project.division_id": "division",
    "project.access.org_id": ORG, "project.access.user_id": "user", "project.access.status": "active",
    "project.lot.org_id": ORG, "project.lot.community.org_id": ORG, "project.lot.community_id": COMMUNITY,
    project: { lot: { lot_number: i, community_id: COMMUNITY, community: { name: "Community" } } },
    assignments: unresolved ? [] : [{ company_id: COMPANY, company: { name: "Partner" } }],
    name: `Task ${i}`, trade: multipleTrades ? `trade-${i}` : "trade", status, start_date: day(start), end_date: day(end), cost_code_id: "cost",
  }
}

function purchaseOrderLine(i, { status = "approved", company = COMPANY, name = "Partner" } = {}) {
  return {
    id: `line-${i}-${company}`, org_id: ORG, cost_code_id: "cost", "commitment.project_id": `project-${i}`, "commitment.org_id": ORG,
    "commitment.commitment_type": "purchase_order", "commitment.status": status,
    commitment: { project_id: `project-${i}`, company_id: company, company: { name } },
  }
}

function harness({
  count = 5001, assignedOnly = false, divisionIds = ["division"], unresolved = false, fail = null, denied = false, multipleTrades = false,
  providerCap = null, client = null, projectMembershipRequired = false, databaseWorkspace = false, actorId = "user", contacts = 1001,
} = {}) {
  const tables = {
    schedule_items: Array.from({ length: count }, (_, i) => schedule(i, { multipleTrades, unresolved })),
    commitment_lines: Array.from({ length: count }, (_, i) => purchaseOrderLine(i)),
    contacts: Array.from({ length: contacts }, (_, i) => ({ id: `contact-${i}`, org_id: ORG, company_id: COMPANY, email: `person${i}@example.test` })),
    orgs: [{ id: ORG, name: "Builder" }], portal_access_tokens: [],
  }
  const db = client ?? createFakeSupabase(tables)
  const reads = [], deliveries = []
  const from = db.from.bind(db)
  db.from = (table) => {
    const q = from(table)
    if (typeof q.run !== "function") return q
    const run = q.run.bind(q), originalIn = q.in.bind(q), originalGt = q.gt.bind(q), originalLimit = q.limit.bind(q)
    let after = null, refs = null
    q.gt = (key, value) => { if (key === "id") after = value; return originalGt(key, value) }
    q.limit = (value) => originalLimit(providerCap ? Math.min(value, providerCap) : value)
    q.in = (key, ids) => {
      if (key === "commitment.project_id") refs = ids
      if (["commitment.project_id", "cost_code_id"].includes(key)) assert.ok(ids.length <= 100)
      return originalIn(key, ids)
    }
    q.run = () => { reads.push({ table, range: q.rangeValue, after, refs }); return table === fail ? { data: null, count: null, error: { message: "offline" } } : run() }
    return q
  }
  stubModule("@/lib/services/context", { requireOrgContext: async () => ({ supabase: db, orgId: ORG, userId: actorId }) })
  stubModule("@/lib/services/permissions", { requirePermission: async () => { if (denied) throw new Error("Forbidden") } })
  stubModule("@/lib/services/authorization", { getProjectReadScopeForUser: async () => ({ divisionIds: assignedOnly ? divisionIds : null, projectMembershipRequired }) })
  stubModule("@/lib/supabase/server", { createServiceSupabaseClient: () => db })
  stubModule("@/lib/services/trade-notices", {
    resolveTradePortalLink: async () => null,
    deliverTradeNotice: async (input) => {
      const draft = await input.build()
      deliveries.push({ input, draft })
      return draft ? "sent" : "skipped"
    },
  })
  process.env.ARC_TRADE_DATABASE_WORKSPACE_ENABLED = databaseWorkspace ? "true" : "false"
  return { ...freshRequire("lib/services/trade-lookahead.ts"), store: db.store, reads, deliveries }
}

test("the look-ahead includes schedules beyond the former 5000-item cap", async () => {
  const h = harness()
  const result = await h.getTradeLookahead({ weeks: 3 })
  assert.equal(result.rows[0].items.length, 5001)
  assert.ok(h.reads.some((read) => read.table === "schedule_items" && read.after === "item-004999"))
})

test("cancelled and completed work is left out and work already under way is kept", async () => {
  const h = harness({ count: 0 })
  h.store.schedule_items.push(
    schedule(1, { status: "cancelled" }), schedule(2, { status: "completed" }), schedule(3, { status: "in_progress", start: -3, end: 5 }),
    schedule(4, { start: -60, end: -50 }), schedule(5, { start: 90, end: 91 }), schedule(6, { start: 2, end: 4 }),
  )
  const result = await h.getTradeLookahead({ weeks: 3 })
  assert.deepEqual(result.rows[0].items.map((item) => item.name).sort(), ["Task 3", "Task 6"])
  assert.deepEqual([...LOOKAHEAD_EXCLUDED_STATUSES], ["cancelled", "completed"])
})

test("a purchase-order vendor is an inference, only from an awarded order, and never an assignment", async () => {
  const h = harness({ count: 1, unresolved: true })
  const inferred = await h.getTradeLookahead({ weeks: 3 })
  assert.equal(inferred.rows[0].companyId, COMPANY)
  assert.equal(inferred.rows[0].items[0].assignment, "inferred")

  for (const status of ["draft", "canceled"]) h.store.commitment_lines[0]["commitment.status"] = status
  assert.equal((await h.getTradeLookahead({ weeks: 3 })).rows[0].companyId, null, "a canceled order awards nothing")
  h.store.commitment_lines[0]["commitment.status"] = "complete"
  assert.equal((await h.getTradeLookahead({ weeks: 3 })).rows[0].items[0].assignment, "inferred")
  assert.deepEqual([...LOOKAHEAD_PO_STATUSES], ["approved", "complete"])

  h.store.commitment_lines.push(purchaseOrderLine(0, { company: "other-company", name: "Other" }))
  const ambiguous = await h.getTradeLookahead({ weeks: 3 })
  assert.equal(ambiguous.rows[0].companyId, null)
  assert.equal(ambiguous.rows[0].items[0].assignment, "unassigned")
  h.store.schedule_items[0].assignments = [{ company_id: COMPANY, company: { name: "Assigned" } }]
  const assigned = await h.getTradeLookahead({ weeks: 3 })
  assert.equal(assigned.rows[0].items[0].assignment, "assigned")
  assert.equal(assigned.rows[0].companyName, "Assigned")
})

test("trade schedules enforce division access without an organization-wide project roster", async () => {
  const h = harness({ count: 2, assignedOnly: true })
  h.store.schedule_items[1]["project.division_id"] = "hidden"
  assert.equal((await h.getTradeLookahead({ weeks: 3 })).rows[0].items.length, 1)
  assert.ok(!h.reads.some((read) => read.table === "projects"))
  const empty = harness({ assignedOnly: true, divisionIds: [] })
  assert.deepEqual(JSON.parse(JSON.stringify(await empty.getTradeLookahead({ weeks: 3 }))), { rows: [], total: 0 })
  assert.equal(empty.reads.length, 0)
  const forbidden = harness({ denied: true })
  await assert.rejects(forbidden.getTradeLookahead({ weeks: 3 }), /Forbidden/)
  assert.equal(forbidden.reads.length, 0)
})

test("purchase-order fallback reads bounded references and propagates failures", async () => {
  const h = harness({ count: 1001, unresolved: true })
  const result = await h.getTradeLookahead({ weeks: 3 })
  assert.equal(result.rows[0].companyId, COMPANY)
  assert.equal(result.rows[0].items.length, 1001)
  assert.equal(new Set(h.reads.filter((read) => read.table === "commitment_lines").map((read) => JSON.stringify(read.refs))).size, 11)
  await assert.rejects(harness({ count: 1, unresolved: true, fail: "commitment_lines" }).getTradeLookahead({ weeks: 3 }), /offline/)
  await assert.rejects(harness({ count: 1, fail: "schedule_items" }).getTradeLookahead({ weeks: 3 }), /offline/)
})

test("a company's look-ahead notice lists every assigned task and goes to every contact", async () => {
  const h = harness({ count: 101, multipleTrades: true })
  assert.deepEqual(await h.sendTradeLookahead(COMPANY, { weeks: 3 }), { sent: true })
  const { draft, input } = h.deliveries[0]
  assert.equal(draft.recipients.length, 1001)
  assert.equal(draft.snapshot.lines.length, 101)
  assert.ok(draft.snapshot.lines.some((line) => line.name === "Task 100"))
  assert.equal(input.kind, "lookahead")
})

test("work inferred from a purchase order is never emailed", async () => {
  const h = harness({ count: 2 })
  h.store.schedule_items[1].assignments = []
  await h.sendTradeLookahead(COMPANY, { weeks: 3 })
  assert.deepEqual(h.deliveries[0].draft.snapshot.lines.map((line) => line.name), ["Task 0"])
  const onlyInferred = harness({ count: 1, unresolved: true })
  await assert.rejects(onlyInferred.sendTradeLookahead(COMPANY, { weeks: 3 }), /No scheduled work/)
  assert.equal(onlyInferred.deliveries.length, 0)
})

test("a look-ahead's duplicate key follows its scope and its day, so a community send does not stand in for the full one", async () => {
  const h = harness({ count: 1 })
  await h.sendTradeLookahead(COMPANY, { weeks: 3 })
  await h.sendTradeLookahead(COMPANY, { weeks: 3, communityId: COMMUNITY })
  await h.sendTradeLookahead(COMPANY, { weeks: 3 })
  const keys = h.deliveries.map(({ input }) => input.dedupeKey)
  assert.equal(keys[0], keys[2])
  assert.notEqual(keys[0], keys[1])
  assert.match(keys[0], new RegExp(`${day(0)}$`))
})

test("a notice is never built when a contact read fails", async () => {
  const h = harness({ count: 1, fail: "contacts" })
  await assert.rejects(h.sendTradeLookahead(COMPANY, { weeks: 3 }), /offline/)
  const none = harness({ count: 1, contacts: 0 })
  await assert.rejects(none.sendTradeLookahead(COMPANY, { weeks: 3 }), /no email contacts/)
})

test("a task assigned to several companies appears for each, once", async () => {
  const h = harness({ count: 1 })
  h.store.schedule_items[0].assignments.push({ company_id: "other", company: { name: "Other" }, confirmed_at: "2026-01-01" }, { company_id: COMPANY, company: { name: "Partner" } })
  const result = await h.getTradeLookahead({ weeks: 3 })
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows.find((row) => row.companyId === COMPANY).items.length, 1)
  assert.equal(result.rows.find((row) => row.companyId === "other").items[0].confirmation, "confirmed")
})

test("a release notice is the trade's own work on that house, keyed to the house, and skipped when there is none", async () => {
  const h = harness({ count: 3 })
  const HOME = "10000000-0000-4000-8000-000000000007", NO_WORK = "10000000-0000-4000-8000-000000000008", OTHER_COMPANY = "10000000-0000-4000-8000-000000000009"
  h.store.schedule_items[1].project_id = HOME
  const release = (projectId, companyId = COMPANY) => h.sendReleaseTradeNotice({ companyId, packageId: "pkg", projectId, outboxId: 7, actorId: ACTOR }, ORG)
  assert.deepEqual(await release(HOME), { sent: true, skipped: false })
  const { input, draft } = h.deliveries[0]
  assert.equal(input.dedupeKey, `release:pkg:${COMPANY}`)
  assert.equal(input.projectId, HOME)
  assert.equal(input.outboxId, 7)
  assert.deepEqual(draft.snapshot.lines.map((line) => line.name), ["Task 1"])
  assert.deepEqual(await release(HOME, OTHER_COMPANY), { sent: false, skipped: true })
  assert.deepEqual(await release(NO_WORK), { sent: false, skipped: true })
})

const DIGEST_JOB = { org_id: ORG, job_id: 41, payload: { company_id: COMPANY, project_id: "project-1", actor_id: ACTOR } }

test("a schedule digest says what moved as it stood when queued, once per job", async () => {
  const h = harness({ count: 0 })
  h.store.lots = [{ org_id: ORG, project_id: "project-1", lot_number: "14", block: null, community: { name: "Cypress Landing" } }]
  h.store.companies = [{ id: COMPANY, org_id: ORG, name: "Partner" }]
  const job = { ...DIGEST_JOB, payload: { ...DIGEST_JOB.payload, changes: [
    { schedule_item_id: "a", name: "Rough framing", old_start: "2026-10-20", new_start: "2026-10-27" },
    { schedule_item_id: "b", name: "Trusses", old_start: null, new_start: "2026-10-28" },
  ] } }
  assert.deepEqual(await h.sendScheduleChangeDigestJob(createFakeSupabase(h.store), job), { sent: true, skipped: false })
  const { input, draft } = h.deliveries[0]
  assert.equal(input.dedupeKey, "schedule_change:41")
  assert.deepEqual(draft.snapshot.lines.map((line) => [line.label, line.name, line.dates]), [
    ["Cypress Landing · 14", "Rough framing", "2026-10-20 → 2026-10-27"],
    ["Cypress Landing · 14", "Trusses", "unscheduled → 2026-10-28"],
  ])
  const empty = await h.sendScheduleChangeDigestJob(createFakeSupabase(h.store), { ...DIGEST_JOB, payload: { ...DIGEST_JOB.payload, changes: [] } })
  assert.deepEqual(empty, { sent: false, skipped: true })
  assert.equal(h.deliveries.length, 1, "a digest whose changes cancelled out sends nothing")
})

test("the window is any overlap with today through the horizon, and a move into or out of it is told", () => {
  const window = lookaheadWindow(new Date("2026-10-14T12:00:00Z"), 3)
  assert.deepEqual(window, { start: "2026-10-14", end: "2026-11-04" })
  assert.equal(overlapsWindow({ startDate: "2026-10-12", endDate: "2026-10-16" }, window), true)
  assert.equal(overlapsWindow({ startDate: "2026-10-01", endDate: "2026-10-05" }, window), false)
  assert.equal(overlapsWindow({ startDate: "2026-11-05", endDate: "2026-11-06" }, window), false)
  assert.equal(overlapsWindow({ startDate: "2026-11-04", endDate: null }, window), true)
  const told = (oldStart, newStart) => scheduleChangeIsNotifiable(oldStart, newStart, "2026-10-14")
  assert.equal(told("2026-10-20", "2026-10-22"), true)
  assert.equal(told("2026-10-20", "2026-12-30"), true, "a move out of the horizon is still news")
  assert.equal(told("2026-12-30", "2026-10-22"), true, "and so is a move in")
  assert.equal(told("2026-12-30", "2027-01-05"), false)
  assert.equal(told("2026-10-20", null), true)
  assert.equal(told("2026-10-20", "2026-10-20"), false)
})

const databaseReply = (overrides = {}) => ({
  orgId: ORG, actorId: ACTOR, divisionId: null, communityId: null, weeks: 3, q: "", group: null, page: 1, pageSize: 50,
  itemPage: 1, itemPageSize: 50, total: 0, rows: [], selected: null, selectedUnavailable: false, ...overrides,
})

test("late groups are discoverable and list DTOs contain no task arrays", async () => {
  const h = harness({ count: 117, multipleTrades: true })
  const pages = await Promise.all([1, 2, 3].map((page) => h.getTradeLookaheadWorkspace({ weeks: 3, page })))
  assert.deepEqual(pages.map((page) => page.rows.length), [50, 50, 17])
  assert.ok(pages.every((page) => page.total === 117))
  assert.equal(new Set(pages.flatMap((page) => page.rows.map((row) => row.key))).size, 117)
  assert.ok(pages.flatMap((page) => page.rows).every((row) => !Object.hasOwn(row, "items")))
})

test("selected task pages bound the payload while whole-group counts stay accurate", async () => {
  const h = harness({ count: 117, unresolved: true })
  h.store.schedule_items[0].assignments = [{ company_id: COMPANY, confirmed_at: "2026-01-01", company: { name: "Partner" } }]
  const group = JSON.stringify([COMPANY, "trade"])
  const pages = await Promise.all([1, 2, 3].map((itemPage) => h.getTradeLookaheadWorkspace({ weeks: 3, group, itemPage })))
  assert.deepEqual(pages.map((page) => page.selected.items.length), [50, 50, 17])
  assert.ok(pages.every((page) => page.selected.itemCount === 117 && page.selected.confirmedCount === 1 && page.selected.inferredCount === 116))
  assert.equal(new Set(pages.flatMap((page) => page.selected.items.map((row) => row.scheduleItemId))).size, 117)
})

test("search totals and off-list selections use the authorized scope", async () => {
  const h = harness({ count: 117, multipleTrades: true })
  const group = JSON.stringify([COMPANY, "trade-116"])
  const page = await h.getTradeLookaheadWorkspace({ weeks: 3, q: "trade-1", group })
  assert.equal(page.total, 28)
  assert.equal(page.selected.items[0].name, "Task 116")
  const hidden = await h.getTradeLookaheadWorkspace({ weeks: 3, q: "missing", group })
  assert.equal(hidden.rows.length, 0)
  assert.equal(hidden.selected.itemCount, 1)
  const unavailable = await h.getTradeLookaheadWorkspace({ weeks: 3, group: "foreign" })
  assert.equal(unavailable.selected, null)
  assert.equal(unavailable.selectedUnavailable, true)
})

test("a requested division and community narrow reads without widening denied scope", async () => {
  const h = harness({ count: 3, assignedOnly: true, divisionIds: [DIVISION] })
  h.store.schedule_items[0]["project.division_id"] = DIVISION
  h.store.schedule_items[1]["project.division_id"] = DIVISION
  h.store.schedule_items[1].project.lot.community_id = "other-community"
  h.store.schedule_items[1]["project.lot.community_id"] = "other-community"
  const result = await h.getTradeLookaheadWorkspace({ weeks: 3, divisionId: DIVISION, communityId: COMMUNITY })
  assert.equal(result.rows[0].itemCount, 1)
  h.reads.length = 0
  const denied = await h.getTradeLookaheadWorkspace({ weeks: 3, divisionId: COMMUNITY })
  assert.equal(denied.total, 0)
  assert.equal(h.reads.length, 0)
})

test("a dispatch sends only the reviewed community and division", async () => {
  const h = harness({ count: 3 })
  h.store.schedule_items[0]["project.division_id"] = DIVISION
  h.store.schedule_items[1]["project.division_id"] = DIVISION
  h.store.schedule_items[1].project.lot.community_id = "other-community"
  h.store.schedule_items[1]["project.lot.community_id"] = "other-community"
  await h.sendTradeLookahead(COMPANY, { weeks: 3, divisionId: DIVISION, communityId: COMMUNITY })
  assert.deepEqual(h.deliveries[0].draft.snapshot.lines.map((line) => line.name), ["Task 0"])
})

test("assignment-only project scope is enforced before summaries and dispatch", async () => {
  const h = harness({ count: 3, projectMembershipRequired: true })
  h.store.schedule_items[1]["project.access.user_id"] = "someone-else"
  h.store.schedule_items[2]["project.access.status"] = "inactive"
  assert.equal((await h.getTradeLookaheadWorkspace({ weeks: 3 })).rows[0].itemCount, 1)
  await h.sendTradeLookahead(COMPANY, { weeks: 3 })
  assert.deepEqual(h.deliveries[0].draft.snapshot.lines.map((line) => line.name), ["Task 0"])
})

test("provider row caps below the requested page sizes cannot truncate the workspace or recipients", async () => {
  const h = harness({ count: 117, providerCap: 7 })
  const result = await h.getTradeLookaheadWorkspace({ weeks: 3 })
  assert.equal(result.rows[0].itemCount, 117)
  await h.sendTradeLookahead(COMPANY, { weeks: 3 })
  assert.equal(h.deliveries[0].draft.recipients.length, 1001)
  assert.equal(h.deliveries[0].draft.snapshot.lines.length, 117)
})

test("workspace failures and invalid queries reject rather than fabricate empty data", async () => {
  await assert.rejects(harness({ count: 1, fail: "schedule_items" }).getTradeLookaheadWorkspace({ weeks: 3 }), /offline/)
  await assert.rejects(harness({ count: 1 }).getTradeLookaheadWorkspace({ weeks: 3, itemPage: 0 }))
  await assert.rejects(harness({ count: 1 }).getTradeLookaheadWorkspace({ weeks: 3, q: "x".repeat(121) }))
  const malformed = harness({ count: 1 })
  malformed.store.schedule_items[0].start_date = `${day(0)}T`
  await assert.rejects(malformed.getTradeLookaheadWorkspace({ weeks: 3 }), /Invalid date/)
})

test("the fallback reads the purchase-order parent and a parent outside the reviewed home fails before dispatch", async () => {
  const h = harness({ count: 1, unresolved: true })
  assert.ok(!Object.hasOwn(h.store.commitment_lines[0], "project_id"), "the fixture follows the live line schema")
  h.store.commitment_lines[0].commitment.project_id = "foreign-home"
  await assert.rejects(h.sendTradeLookahead(COMPANY, { weeks: 3 }), /unexpected home/)
  assert.equal(h.deliveries.length, 0)
})

test("the SDK repeats the org, production, division, status and window predicates on every keyset request", async () => {
  const { createClient } = require("@supabase/supabase-js")
  const seen = []
  const rows = Array.from({ length: 31 }, (_, i) => ({
    id: `item-${String(i).padStart(6, "0")}`, project_id: `home-${i}`, name: `Task ${i}`, trade: "Framing", start_date: day(0), end_date: day(0),
    project: { lot: { lot_number: i, community_id: COMMUNITY, community: { name: "Community" } } }, assignments: [],
  }))
  const client = createClient("https://fixture.invalid", "fixture-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input) => {
    const url = new URL(String(input)); seen.push(url)
    assert.equal(url.pathname, "/rest/v1/schedule_items")
    assert.equal(url.searchParams.get("org_id"), `eq.${ORG}`)
    assert.equal(url.searchParams.get("project.property_type"), "eq.production")
    assert.equal(url.searchParams.get("project.division_id"), `in.(${DIVISION})`)
    assert.equal(url.searchParams.get("project.lot.community_id"), `eq.${COMMUNITY}`)
    assert.equal(url.searchParams.get("status"), "not.in.(cancelled,completed)")
    assert.equal(url.searchParams.get("start_date"), `lte.${lookaheadWindow(new Date(), 3).end}`)
    assert.match(url.searchParams.get("or"), new RegExp(`^\\(end_date\\.gte\\.${day(0)},and\\(end_date\\.is\\.null,start_date\\.gte\\.${day(0)}\\)\\)$`))
    assert.equal(url.searchParams.get("order"), "id.asc")
    assert.ok(Number(url.searchParams.get("limit")) <= 100)
    const after = url.searchParams.get("id")?.replace(/^gt\./, "")
    return new Response(JSON.stringify(rows.filter((row) => !after || row.id > after).slice(0, 7)), { status: 200, headers: { "content-type": "application/json" } })
  } } })
  const h = harness({ client, count: 0 })
  const result = await h.getTradeLookaheadWorkspace({ weeks: 3, divisionId: DIVISION, communityId: COMMUNITY })
  assert.equal(result.rows[0].itemCount, 31)
  assert.equal(seen.length, 6)
  assert.equal(seen.at(-1).searchParams.get("id"), "gt.item-000030")
})

test("the fallback filters the purchase-order parent to awarded orders and never a nonexistent line home", async () => {
  const { createClient } = require("@supabase/supabase-js")
  const seen = []
  const home = "10000000-0000-4000-8000-000000000006"
  const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  const client = createClient("https://fixture.invalid", "fixture-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input) => {
    const url = new URL(String(input)); seen.push(url)
    assert.equal(url.searchParams.get("org_id"), `eq.${ORG}`)
    if (url.searchParams.has("id")) return json([])
    if (url.pathname.endsWith("/schedule_items")) {
      return json([{ id: "item-a", project_id: home, name: "Framing", trade: "Framing", start_date: day(0), end_date: day(0), cost_code_id: "cost",
        project: { lot: { community_id: COMMUNITY, lot_number: "47", community: { name: "Community" } } }, assignments: [] }])
    }
    assert.equal(url.pathname, "/rest/v1/commitment_lines")
    assert.equal(url.searchParams.has("project_id"), false)
    assert.equal(url.searchParams.get("commitment.project_id"), `in.(${home})`)
    assert.equal(url.searchParams.get("commitment.commitment_type"), "eq.purchase_order")
    assert.equal(url.searchParams.get("commitment.status"), "in.(approved,complete)")
    return json([{ id: "line-a", cost_code_id: "cost", commitment: { project_id: home, company_id: COMPANY, company: { name: "PO company" } } }])
  } } })
  const result = await harness({ client, count: 0 }).getTradeLookaheadWorkspace({ weeks: 3 })
  assert.equal(result.rows[0].companyName, "PO company")
  assert.equal(result.rows[0].inferredCount, 1)
  assert.equal(seen.length, 4)
})

test("the dispatch action validates its scope and revalidates the desk", async () => {
  const calls = [], paths = []
  stubModule("next/cache", { revalidatePath: (value) => paths.push(value) })
  stubModule("@/lib/services/trade-lookahead", { sendTradeLookahead: async (...args) => { calls.push(args); return { sent: false } } })
  const { sendTradeLookaheadAction } = freshRequire("app/(app)/schedule/trade-actions.ts")
  for (const [company, input] of [["invalid", { weeks: 3 }], [COMPANY, { weeks: 5 }], [COMPANY, { weeks: 3, divisionId: "invalid" }], [COMPANY, { weeks: 3, releaseNoticeKey: "untrusted" }]]) {
    assert.equal((await sendTradeLookaheadAction(company, input)).success, false)
  }
  assert.equal(calls.length, 0)
  assert.equal(paths.length, 0)
  const result = await sendTradeLookaheadAction(COMPANY, { weeks: 3, communityId: COMMUNITY, divisionId: DIVISION })
  assert.equal(result.success, true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[COMPANY, { weeks: 3, communityId: COMMUNITY, divisionId: DIVISION }]])
  assert.deepEqual(paths, ["/schedule/trades"])
})

test("an enabled workspace reads through the authenticated database function with the reviewed scope", async () => {
  const { createClient } = require("@supabase/supabase-js")
  const calls = [], group = JSON.stringify([COMPANY, "trade"])
  const reply = databaseReply({
    divisionId: DIVISION, communityId: COMMUNITY, q: "missing", group,
    selected: { key: group, companyId: COMPANY, companyName: "Partner", trade: "trade", itemCount: 1, confirmedCount: 0, inferredCount: 1, firstDate: "2026-10-05", items: [{
      scheduleItemId: COMPANY, projectId: COMMUNITY, lotLabel: "47", communityName: "Community", name: "Task", startDate: "2026-10-05",
      endDate: "2026-10-06", status: "planned", assignment: "inferred", confirmation: "unsent" }] },
  })
  const client = createClient("https://isolated.example.test", "synthetic-key", { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: async (url, init) => { calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) }); return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } }) },
  } })
  const h = harness({ client, databaseWorkspace: true, actorId: ACTOR })
  const page = await h.getTradeLookaheadWorkspace({ weeks: 3, divisionId: DIVISION, communityId: COMMUNITY, q: " missing ", group })
  assert.equal(page.selected.items[0].assignment, "inferred")
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /rest\/v1\/rpc\/read_trade_lookahead_workspace$/)
  assert.deepEqual(calls[0].body, { p_org: ORG, p_actor: ACTOR, p_weeks: 3, p_division: DIVISION, p_community: COMMUNITY, p_q: "missing", p_page: 1, p_group: group, p_item_page: 1 })
  assert.equal(h.reads.length, 0)
})

test("a database reply that differs from the reviewed scope or page is refused, never replaced by a source scan", async () => {
  const group = JSON.stringify([COMPANY, "trade"])
  const row = { key: group, companyId: COMPANY, companyName: "Partner", trade: "trade", itemCount: 1, confirmedCount: 0, inferredCount: 0, firstDate: "2026-10-05" }
  const replies = [
    { data: null, error: { message: "migration unavailable" } },
    { data: databaseReply({ orgId: COMMUNITY }), error: null },
    { data: databaseReply({ actorId: COMPANY }), error: null },
    { data: databaseReply({ communityId: COMMUNITY }), error: null },
    { data: databaseReply({ q: "other" }), error: null },
    { data: databaseReply({ total: 1 }), error: null },
    { data: databaseReply({ total: 2, rows: [row, row] }), error: null },
    { data: databaseReply({ total: 1, rows: [{ ...row, key: "changed" }] }), error: null },
    { data: databaseReply({ total: 1, rows: [{ ...row, confirmedCount: 2 }] }), error: null },
    { data: databaseReply({ selectedUnavailable: true }), error: null },
    { data: databaseReply({ total: "0" }), error: null },
  ]
  for (const response of replies) {
    const client = createFakeSupabase({})
    client.rpc = async () => response
    const h = harness({ client, databaseWorkspace: true, actorId: ACTOR })
    await assert.rejects(h.getTradeLookaheadWorkspace({ weeks: 3 }))
    assert.equal(h.reads.length, 0)
  }
  const client = createFakeSupabase({})
  let calls = 0
  client.rpc = async () => { calls += 1; return { data: databaseReply(), error: null } }
  await assert.rejects(harness({ client, databaseWorkspace: true, actorId: ACTOR, denied: true }).getTradeLookaheadWorkspace({ weeks: 3 }), /Forbidden/)
  assert.equal(calls, 0)
})

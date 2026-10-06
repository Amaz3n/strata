require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const { createFakeSupabase } = require("./support/fake-supabase")
const ORG = "10000000-0000-4000-8000-000000000001"
const COMPANY = "10000000-0000-4000-8000-000000000002"
const COMMUNITY = "10000000-0000-4000-8000-000000000003"
function harness({ count = 5001, assignedOnly = false, divisionIds = ["division"], unresolved = false, fail = null, denied = false, multipleTrades = false, mailAccepted = true, providerCap = null, client = null, projectMembershipRequired = false, databaseWorkspace = false, actorId = "user" } = {}) {
  const date = new Date().toISOString().slice(0, 10)
  const tables = {
    schedule_items: Array.from({ length: count }, (_, i) => ({
      id: `item-${String(i).padStart(6, "0")}`, org_id: ORG, project_id: `project-${i}`,
      "project.org_id": ORG, "project.property_type": "production", "project.status": "active", "project.division_id": "division", "project.access.org_id": ORG, "project.access.user_id": "user", "project.access.status": "active", "project.lot.org_id": ORG, "project.lot.community.org_id": ORG, "project.lot.community_id": COMMUNITY,
      project: { lot: { lot_number: i, community_id: COMMUNITY, community: { name: "Community" } } },
      assignments: unresolved ? [] : [{ company_id: COMPANY, company: { name: "Partner" } }],
      name: `Task ${i}`, trade: multipleTrades ? `trade-${i}` : "trade", status: "planned", start_date: date, cost_code_id: "cost",
    })),
    commitment_lines: Array.from({ length: count }, (_, i) => ({ id: `line-${i}`, org_id: ORG, cost_code_id: "cost", "commitment.project_id": `project-${i}`, "commitment.org_id": ORG, "commitment.commitment_type": "purchase_order", commitment: { project_id: `project-${i}`, company_id: COMPANY, company: { name: "Partner" } } })),
    contacts: Array.from({ length: 1001 }, (_, i) => ({ id: `contact-${i}`, org_id: ORG, company_id: COMPANY, email: `person${i}@example.test` })),
    events: [], orgs: [{ id: ORG, name: "Builder" }], portal_access_tokens: [],
  }
  const db = client ?? createFakeSupabase(tables)
  const reads = [], mail = [], events = []
  const from = db.from.bind(db)
  db.from = (table) => {
    const q = from(table)
    if (typeof q.run !== "function") return q
    const run = q.run.bind(q), originalIn = q.in.bind(q), originalGt = q.gt.bind(q), originalLimit = q.limit.bind(q)
    let after = null, refs = null
    q.gt = (key, value) => { if (key === "id") after = value; return originalGt(key, value) }
    q.limit = value => originalLimit(providerCap ? Math.min(value, providerCap) : value)
    q.in = (key, ids) => { if (key === "commitment.project_id") refs = ids; if (["commitment.project_id", "cost_code_id"].includes(key)) assert.ok(ids.length <= 100); return originalIn(key, ids) }
    q.run = () => { reads.push({ table, range: q.rangeValue, after, refs }); return table === fail ? { data: null, count: null, error: { message: "offline" } } : run() }
    return q
  }
  const compiled = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../lib/services/trade-lookahead.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: compiled.exports, process: { env: { ARC_TRADE_DATABASE_WORKSPACE_ENABLED: databaseWorkspace ? "true" : "false" } }, require(name) {
      if (name === "server-only") return {}
      if (name === "@/lib/services/context") return { requireOrgContext: async () => ({ supabase: db, orgId: ORG, userId: actorId }) }
      if (name === "@/lib/services/permissions") return { requirePermission: async () => { if (denied) throw new Error("Forbidden") } }
      if (name === "@/lib/services/authorization") return { getProjectReadScopeForUser: async () => ({ divisionIds: assignedOnly ? divisionIds : null, projectMembershipRequired }) }
      if (name === "@/lib/services/mailer") return { escapeHtml: String, getOrgSenderEmail: () => "sender@example.test", renderStandardEmailLayout: (input) => input.messageHtml, sendEmail: async (input) => { mail.push(input); return mailAccepted } }
      if (name === "@/lib/services/events") return { recordEvent: async (input) => { events.push(input); return { id: "event" } } }
      if (name === "@/lib/services/audit") return { recordAudit: async () => {} }
      if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => db }
      if (name === "@/lib/land/paging") return require("../lib/land/paging")
      if (name === "@/lib/validation/starts") return require("../lib/validation/starts")
      if (name === "@/lib/starts/even-flow-math") return require("../lib/starts/even-flow-math")
      throw new Error(name)
    },
  })
  return { ...compiled.exports, store: db.store, reads, mail, events }
}
test("trade look-ahead includes schedules beyond the former 5000-item cap", async () => {
  const h = harness()
  const result = await h.getTradeLookahead({ weeks: 3 })
  assert.equal(result.rows[0].items.length, 5001)
  assert.ok(h.reads.some(read => read.table === "schedule_items" && read.after === "item-004999"))
})
test("trade schedules enforce division access without an organization-wide project roster", async () => {
  const h = harness({ count: 2, assignedOnly: true })
  h.store.schedule_items[1]["project.division_id"] = "hidden"
  assert.equal((await h.getTradeLookahead({ weeks: 3 })).rows[0].items.length, 1)
  assert.ok(!h.reads.some(read => read.table === "projects"))
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
  assert.equal(new Set(h.reads.filter(read => read.table === "commitment_lines").map(read => JSON.stringify(read.refs))).size, 11)
  assert.ok(h.reads.filter(read => read.table === "commitment_lines").length > 11, "Each reference batch also proves source exhaustion")
  await assert.rejects(harness({ count: 1, unresolved: true, fail: "commitment_lines" }).getTradeLookahead({ weeks: 3 }), /offline/)
  await assert.rejects(harness({ count: 1, fail: "schedule_items" }).getTradeLookahead({ weeks: 3 }), /offline/)
})
test("company email includes every trade group and all contacts beyond one page", async () => {
  const h = harness({ count: 101, multipleTrades: true })
  await h.sendTradeLookahead(COMPANY, { weeks: 3 })
  assert.equal(h.mail.length, 1)
  assert.equal(h.mail[0].to.length, 1001)
  assert.match(h.mail[0].html, /Task 100/)
  assert.equal(h.events[0].payload.item_count, 101)
})
test("failed notice deduplication and contact reads prevent sending incomplete mail", async () => {
  for (const fail of ["events", "contacts"]) {
    const h = harness({ count: 1, fail })
    await assert.rejects(h.sendTradeLookahead(COMPANY, { weeks: 3 }), /offline/)
    assert.equal(h.mail.length, 0)
  }
})

test("a schedule item appears for every assigned company without duplicate assignments", async () => {
  const h = harness({ count: 1 })
  h.store.schedule_items[0].assignments.push({ company_id: "other", company: { name: "Other" }, confirmed_at: "2026-01-01" }, { company_id: COMPANY, company: { name: "Partner" } })
  const result = await h.getTradeLookahead({ weeks: 3 })
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows.find(row => row.companyId === COMPANY).items.length, 1)
  assert.equal(result.rows.find(row => row.companyId === "other").items[0].confirmation, "confirmed")
})

test("release notice deduplication distinguishes homes released on the same day", async () => {
  const h = harness({ count: 1 })
  const key = "release-a"
  h.store.events.push({ id: "already", org_id: ORG, event_type: "trade_lookahead.sent", payload: { company_id: COMPANY, release_notice_key: key }, created_at: new Date().toISOString() })
  const skipped = await h.sendTradeLookahead(COMPANY, { weeks: 3, releaseNoticeKey: key })
  assert.equal(skipped.sent, false)
  assert.equal(h.mail.length, 0)
  await h.sendTradeLookahead(COMPANY, { weeks: 3, releaseNoticeKey: "release-b" })
  assert.equal(h.mail.length, 1)
  assert.equal(h.events[0].payload.release_notice_key, "release-b")
})

test("mailer's false acceptance cannot produce a sent event", async () => {
  const h = harness({ count: 1, mailAccepted: false })
  await assert.rejects(h.sendTradeLookahead(COMPANY, { weeks: 3 }), /was not accepted/)
  assert.equal(h.events.length, 0)
})

const DIVISION = "10000000-0000-4000-8000-000000000004"
test("workspace late groups are discoverable and list DTOs contain no task arrays", async () => {
  const h = harness({ count: 117, multipleTrades: true })
  const pages = await Promise.all([1,2,3].map(page => h.getTradeLookaheadWorkspace({ weeks: 3, page })))
  assert.deepEqual(pages.map(page => page.rows.length), [50,50,17])
  assert.ok(pages.every(page => page.total === 117))
  assert.equal(new Set(pages.flatMap(page => page.rows.map(row => row.key))).size, 117)
  assert.ok(pages.flatMap(page => page.rows).every(row => !Object.hasOwn(row, "items")))
})
test("workspace selected task pages bound payload while whole-group counts stay accurate", async () => {
  const h = harness({ count: 117 })
  h.store.schedule_items[0].assignments[0].confirmed_at = "2026-01-01"
  const group = JSON.stringify([COMPANY,"trade"])
  const pages = await Promise.all([1,2,3].map(itemPage => h.getTradeLookaheadWorkspace({ weeks: 3, group, itemPage })))
  assert.deepEqual(pages.map(page => page.selected.items.length), [50,50,17])
  assert.ok(pages.every(page => page.selected.itemCount === 117 && page.selected.confirmedCount === 1))
  assert.equal(new Set(pages.flatMap(page => page.selected.items.map(row => row.scheduleItemId))).size, 117)
})
test("search totals and separate off-list selections use the authorized original scope", async () => {
  const h = harness({ count: 117, multipleTrades: true })
  const group = JSON.stringify([COMPANY,"trade-116"])
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
test("requested division and community narrow original reads without widening denied scope", async () => {
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
test("workspace failures and invalid queries reject rather than fabricate empty data", async () => {
  await assert.rejects(harness({ count: 1, fail: "schedule_items" }).getTradeLookaheadWorkspace({ weeks: 3 }), /offline/)
  await assert.rejects(harness({ count: 1 }).getTradeLookaheadWorkspace({ weeks: 3, itemPage: 0 }))
  await assert.rejects(harness({ count: 1 }).getTradeLookaheadWorkspace({ weeks: 3, q: "x".repeat(121) }))
})
test("original dispatch sends only the reviewed community and division", async () => {
  const h = harness({ count: 3 })
  h.store.schedule_items[0]["project.division_id"] = DIVISION
  h.store.schedule_items[1]["project.division_id"] = DIVISION
  h.store.schedule_items[1].project.lot.community_id = "other-community"
  h.store.schedule_items[1]["project.lot.community_id"] = "other-community"
  await h.sendTradeLookahead(COMPANY, { weeks: 3, divisionId: DIVISION, communityId: COMMUNITY })
  assert.equal(h.mail.length, 1)
  assert.match(h.mail[0].html, /Task 0/)
  assert.doesNotMatch(h.mail[0].html, /Task [12]/)
  assert.equal(h.events[0].payload.item_count, 1)
})

test("provider row caps below requested page sizes cannot truncate workspace or recipients", async () => {
  const h = harness({ count: 117, providerCap: 7 })
  const result = await h.getTradeLookaheadWorkspace({ weeks: 3 })
  assert.equal(result.rows[0].itemCount, 117)
  await h.sendTradeLookahead(COMPANY, { weeks: 3 })
  assert.equal(h.mail[0].to.length, 1001)
  assert.equal(h.events[0].payload.item_count, 117)
})

test("actual SDK repeats org, production and reviewed division predicates on every keyset request", async () => {
  const { createClient } = require("@supabase/supabase-js")
  const seen = [], date = new Date().toISOString().slice(0,10)
  const rows = Array.from({ length: 31 }, (_,i) => ({ id: `item-${String(i).padStart(6,"0")}`, project_id: `home-${i}`, name: `Task ${i}`, trade: "Framing", start_date: date, end_date: date, project: { lot: { lot_number: i, community_id: COMMUNITY, community: { name: "Community" } } }, assignments: [{ company_id: COMPANY, company: { name: "Company" } }] }))
  const client = createClient("https://fixture.invalid", "fixture-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async input => {
    const url = new URL(String(input)); seen.push(url)
    assert.equal(url.pathname, "/rest/v1/schedule_items")
    assert.equal(url.searchParams.get("org_id"), `eq.${ORG}`)
    assert.equal(url.searchParams.get("project.org_id"), `eq.${ORG}`)
    assert.equal(url.searchParams.get("project.property_type"), "eq.production")
    assert.equal(url.searchParams.get("project.division_id"), `in.(${DIVISION})`)
    assert.equal(url.searchParams.get("project.lot.org_id"), `eq.${ORG}`)
    assert.equal(url.searchParams.get("project.lot.community.org_id"), `eq.${ORG}`)
    assert.equal(url.searchParams.get("project.lot.community_id"), `eq.${COMMUNITY}`)
    assert.equal(url.searchParams.get("order"), "id.asc")
    assert.ok(Number(url.searchParams.get("limit")) <= 100)
    const after = url.searchParams.get("id")?.replace(/^gt\./, "")
    const batch = rows.filter(row => !after || row.id > after).slice(0,7)
    return new Response(JSON.stringify(batch), { status: 200, headers: { "content-type": "application/json" } })
  } } })
  const h = harness({ client, count: 0 })
  const result = await h.getTradeLookaheadWorkspace({ weeks: 3, divisionId: DIVISION, communityId: COMMUNITY })
  assert.equal(result.rows[0].itemCount, 31)
  assert.equal(seen.length, 6)
  assert.equal(seen.at(-1).searchParams.get("id"), "gt.item-000030")
})
test("thin original dispatch action wraps invalid inputs and preserves reviewed scope/results", async () => {
  const calls = [], paths = [], compiled = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../app/(app)/schedule/trade-actions.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: compiled.exports, require(name) {
      if (name === "zod") return require("zod")
      if (name === "next/cache") return { revalidatePath: value => paths.push(value) }
      if (name === "@/lib/action-result") return { actionError: () => ({ success: false, error: "Invalid request" }) }
      if (name === "@/lib/services/trade-lookahead") return { sendTradeLookahead: async (...args) => { calls.push(args); return { sent: false } } }
      throw new Error(name)
    },
  })
  for (const [company,input] of [["invalid",{weeks:3}],[COMPANY,{weeks:5}],[COMPANY,{weeks:3,divisionId:"invalid"}],[COMPANY,{weeks:3,releaseNoticeKey:"untrusted"}]]) {
    assert.equal((await compiled.exports.sendTradeLookaheadAction(company,input)).success, false)
  }
  assert.equal(calls.length,0);assert.equal(paths.length,0)
  const result = await compiled.exports.sendTradeLookaheadAction(COMPANY,{weeks:3,communityId:COMMUNITY,divisionId:DIVISION})
  assert.equal(result.success,true);assert.equal(result.data.sent,false)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[[COMPANY,{weeks:3,communityId:COMMUNITY,divisionId:DIVISION}]])
  assert.deepEqual(paths,["/schedule/trades"])
})

test("purchase-order parent is the only fallback home source and ambiguous vendors stay unassigned", async () => {
  const h = harness({ count: 1, unresolved: true })
  assert.ok(!Object.hasOwn(h.store.commitment_lines[0], "project_id"), "Fixture follows verified live line schema")
  h.store.commitment_lines.push({ ...h.store.commitment_lines[0], id: "line-b", commitment: { ...h.store.commitment_lines[0].commitment, company_id: "other-company", company: { name: "Other" } } })
  const result = await h.getTradeLookaheadWorkspace({ weeks: 3 })
  assert.equal(result.rows[0].companyId, null)
  assert.equal(result.rows[0].itemCount, 1)
  h.store.schedule_items[0].assignments = [{ company_id: COMPANY, company: { name: "Assigned" } }]
  assert.equal((await h.getTradeLookaheadWorkspace({ weeks: 3 })).rows[0].companyName, "Assigned")
})
test("assignment-only project scope is enforced before summaries and dispatch", async () => {
  const h = harness({ count: 3, projectMembershipRequired: true })
  h.store.schedule_items[1]["project.access.user_id"] = "someone-else"
  h.store.schedule_items[2]["project.access.status"] = "inactive"
  assert.equal((await h.getTradeLookaheadWorkspace({ weeks: 3 })).rows[0].itemCount, 1)
  await h.sendTradeLookahead(COMPANY, { weeks: 3 })
  assert.equal(h.events[0].payload.item_count, 1)
  assert.doesNotMatch(h.mail[0].html, /Task [12]/)
})

test("actual SDK fallback filters the purchase-order parent and never a nonexistent line home", async () => {
  const { createClient } = require("@supabase/supabase-js")
  const seen = [], date = new Date().toISOString().slice(0,10)
  const home = "10000000-0000-4000-8000-000000000005"
  const client = createClient("https://fixture.invalid", "fixture-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async input => {
    const url = new URL(String(input)); seen.push(url)
    assert.equal(url.searchParams.get("org_id"), `eq.${ORG}`)
    if (url.searchParams.has("id")) return new Response("[]",{headers:{"content-type":"application/json"}})
    if (url.pathname.endsWith("/schedule_items")) {
      assert.equal(url.searchParams.get("project.access.org_id"),`eq.${ORG}`)
      assert.equal(url.searchParams.get("project.access.user_id"),"eq.user")
      assert.equal(url.searchParams.get("project.access.status"),"eq.active")
      assert.match(url.searchParams.get("select"),/project_members!project_members_project_id_fkey!inner/)
      return new Response(JSON.stringify([{id:"item-a",project_id:home,name:"Framing",trade:"Framing",start_date:date,end_date:date,cost_code_id:"cost",project:{lot:{community_id:COMMUNITY,lot_number:"47",community:{name:"Community"}}},assignments:[]}]),{headers:{"content-type":"application/json"}})
    }
    assert.equal(url.pathname,"/rest/v1/commitment_lines")
    assert.equal(url.searchParams.has("project_id"),false)
    assert.equal(url.searchParams.get("commitment.project_id"),`in.(${home})`)
    assert.equal(url.searchParams.get("commitment.org_id"),`eq.${ORG}`)
    assert.equal(url.searchParams.get("commitment.commitment_type"),"eq.purchase_order")
    const select=url.searchParams.get("select")
    assert.doesNotMatch(select.split("commitment:")[0],/project_id/)
    assert.match(select,/commitment:commitments!inner\(project_id,company_id/)
    return new Response(JSON.stringify([{id:"line-a",cost_code_id:"cost",commitment:{project_id:home,company_id:COMPANY,company:{name:"PO company"}}}]),{headers:{"content-type":"application/json"}})
  } } })
  const result=await harness({client,count:0,projectMembershipRequired:true}).getTradeLookaheadWorkspace({weeks:3})
  assert.equal(result.rows[0].companyName,"PO company")
  assert.equal(result.rows[0].itemCount,1)
  assert.equal(seen.length,4)
})
test("a returned purchase-order parent outside the reviewed home batch fails before dispatch", async () => {
  const h=harness({count:1,unresolved:true})
  h.store.commitment_lines[0].commitment.project_id="foreign-home"
  await assert.rejects(h.sendTradeLookahead(COMPANY,{weeks:3}),/unexpected home/)
  assert.equal(h.mail.length,0)
})

test("malformed schedule source cannot become an empty or misleading workspace", async () => {
  const h=harness({count:1})
  h.store.schedule_items[0].start_date=new Date().toISOString().slice(0,10)+"T"
  await assert.rejects(h.getTradeLookaheadWorkspace({weeks:3}),/Invalid date/)
  const missing=harness({count:1})
  delete missing.store.schedule_items[0].project_id
  await assert.rejects(missing.getTradeLookaheadWorkspace({weeks:3}))
})

const ACTOR = "10000000-0000-4000-8000-000000000005"
function databaseReply(overrides = {}) {
  return { orgId: ORG, actorId: ACTOR, divisionId: null, communityId: null, weeks: 3,
    q: "", group: null, page: 1, pageSize: 50, itemPage: 1, itemPageSize: 50,
    total: 0, rows: [], selected: null, selectedUnavailable: false, ...overrides }
}
test("enabled workspace uses authenticated Supabase RPC transport with the reviewed scope", async () => {
  const { createClient } = require("@supabase/supabase-js")
  const calls = [], group = JSON.stringify([COMPANY, "trade"])
  const reply = databaseReply({ divisionId: DIVISION, communityId: COMMUNITY, q: "missing", group,
    selected: { key: group, companyId: COMPANY, companyName: "Partner", trade: "trade", itemCount: 1,
      confirmedCount: 0, firstDate: "2026-10-05", items: [{ scheduleItemId: COMPANY, projectId: COMMUNITY,
        lotLabel: "47", communityName: "Community", name: "Task", startDate: "2026-10-05",
        endDate: "2026-10-06", status: "planned", confirmation: "unsent" }] } })
  const client = createClient("https://isolated.example.test", "synthetic-key", { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: async (url, init) => { calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) }); return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } }) },
  } })
  const h = harness({ client, databaseWorkspace: true, actorId: ACTOR })
  const page = await h.getTradeLookaheadWorkspace({ weeks: 3, divisionId: DIVISION, communityId: COMMUNITY, q: " missing ", group })
  assert.equal(page.selected.items.length, 1)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /rest\/v1\/rpc\/read_trade_lookahead_workspace$/)
  assert.equal(calls[0].method, "POST")
  assert.deepEqual(calls[0].body, { p_org: ORG, p_actor: ACTOR, p_weeks: 3, p_division: DIVISION, p_community: COMMUNITY, p_q: "missing", p_page: 1, p_group: group, p_item_page: 1 })
  assert.equal(h.reads.length, 0)
})
test("database reply failures and altered scope never fall back to source scans", async () => {
  const group = JSON.stringify([COMPANY, "trade"])
  const row = { key: group, companyId: COMPANY, companyName: "Partner", trade: "trade", itemCount: 1, confirmedCount: 0, firstDate: "2026-10-05" }
  const cases = [
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
  for (const response of cases) {
    const client = createFakeSupabase({}); client.rpc = async () => response
    const h = harness({ client, databaseWorkspace: true, actorId: ACTOR })
    await assert.rejects(h.getTradeLookaheadWorkspace({ weeks: 3 }))
    assert.equal(h.reads.length, 0)
  }
  const client = createFakeSupabase({}); let calls = 0; client.rpc = async () => { calls++; return { data: databaseReply(), error: null } }
  await assert.rejects(harness({ client, databaseWorkspace: true, actorId: ACTOR, denied: true }).getTradeLookaheadWorkspace({ weeks: 3 }), /Forbidden/)
  assert.equal(calls, 0)
})

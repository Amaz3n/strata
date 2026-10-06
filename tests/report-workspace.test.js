require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const original = Module._load
let permissions, enabled, projectAllowed, executed, members, runRow
const base = { tables: [{ key: "data", columns: [{ key: "name", header: "Name" }, { key: "amount", header: "Amount", type: "money", aggregation: "sum" }], rows: [{ key: "1", cells: { name: "A", amount: 100 } }] }] }
const definitions = Object.fromEntries(["ops", "books-test", "margin", "report-packet"].map(slug => [slug, { slug, scopes: ["org", "project"], permissions: [slug.startsWith("books-") ? "books.read" : slug === "margin" ? "financials.margin.read" : "report.read"], params: [{ key: "period", kind: "period" }], run: async ctx => { executed = ctx; return structuredClone(base) } }]))
const db = { from: () => ({ select() { return this }, eq() { return this }, in: async () => ({ data: members }), maybeSingle: async () => ({ data: runRow }) }) }
Module._load = function(name, ...args) {
  if (name === "@/lib/services/context") return { requireOrgContext: async () => ({ orgId: "org", userId: "user", supabase: db }) }
  if (name === "@/lib/services/permissions") return { getUserPermissions: async () => permissions, requireAnyPermission: async () => {}, requirePermission: async () => {}, requireProjectPermission: async () => { if (!projectAllowed) throw new Error("Project denied") } }
  if (name === "@/lib/reports/registry") return { getReportDefinition: slug => definitions[slug] }
  if (name === "@/lib/services/books/module") return { getBooksModuleSettings: async () => ({ enabled, settings: { ledger_authority: "arc", fiscal_year_start_month: 4 } }) }
  if (name === "@/lib/services/books/statement-detail") return {}
  if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => db }
  if (name === "@/lib/services/events") return { recordEvent: async () => {} }
  return original.call(this, name, ...args)
}
const { authorizeReport, evaluateReport, buildReportPacket } = require("../lib/services/report-workspace")
const { getReportRun } = require("../lib/services/report-runs")
Module._load = original
const context = params => ({ scope: "org", scopeLabel: "Organization-wide", posture: "residential", params })
test.beforeEach(() => { permissions = ["report.read"]; enabled = true; projectAllowed = true; members = []; executed = null })
test("report.read does not grant access to Books or margins", async () => {
  await assert.rejects(authorizeReport("books-test"), /access/)
  await assert.rejects(authorizeReport("margin"), /access/)
  await authorizeReport("ops")
})
test("Books disabled blocks statements even for an administrator", async () => {
  permissions = ["*"]; enabled = false
  await assert.rejects(authorizeReport("books-test"), /Enable Arc Books/)
  await authorizeReport("ops")
})
test("project permission is checked independently of report permission", async () => {
  projectAllowed = false
  await assert.rejects(authorizeReport("ops", "project"), /Project denied/)
})
test("custom dates reach the underlying service and saved parameters retain relative semantics", async () => {
  const result = await evaluateReport(definitions.ops, context({ period: "custom", _from: "2026-02-01", _to: "2026-02-28" }))
  assert.equal(executed.params.period, "range:2026-02-01:2026-02-28")
  assert.equal(result.context.params.period, "custom")
  assert.equal(result.context.params._division, "")
})
test("invalid calendar dates and backwards ranges cannot silently produce a report", async () => {
  await assert.rejects(evaluateReport(definitions.ops, context({ period: "custom", _from: "2026-02-30", _to: "2026-03-01" })))
  await assert.rejects(evaluateReport(definitions.ops, context({ period: "custom", _from: "2026-03-01", _to: "2026-02-01" })), /Start date/)
})
test("the server applies the same customization as the canvas", async () => {
  const result = await evaluateReport(definitions.ops, context({ _layout: JSON.stringify({ tables: { data: { labels: { amount: "Receivable" } } }, notes: "Owner review" }) }))
  assert.equal(result.result.tables[0].columns[1].header, "Receivable")
  assert.equal(result.base.tables[0].columns[1].header, "Amount")
  assert.equal(result.result.commentary, "Owner review")
})
const id = "11111111-1111-4111-8111-111111111111"
test("packet members require visibility and their own financial permission", async () => {
  members = [{ id, slug: "books-test", user_id: "user", scope: "org", params: {} }]
  await assert.rejects(buildReportPacket(context({ _packet: JSON.stringify([id]) })), /access/)
  members = [{ id, slug: "ops", user_id: "someone-else", scope: "org", params: {} }]
  await assert.rejects(buildReportPacket(context({ _packet: JSON.stringify([id]) })), /private/)
})
test("packets retain their access dependencies for later snapshot reads", async () => {
  members = [{ id, name: "Ops", slug: "ops", user_id: "someone-else", scope: "org", params: { _visibility: "team" } }]
  const result = await buildReportPacket(context({ _packet: JSON.stringify([id]) }))
  assert.deepEqual(result.sources, [{ slug: "ops", projectId: undefined }])
  assert.equal(result.tables[0].title, "Ops")
  assert.equal(result.tables[0].locked, true)
})
test("snapshot read rechecks access to every packet member", async () => {
  runRow = { id, slug: "report-packet", scope: "org", snapshot: { ...base, sources: [{ slug: "books-test" }] } }
  await assert.rejects(getReportRun(id), /access/)
  permissions = ["report.read", "books.read"]
  assert.equal((await getReportRun(id)).id, id)
})

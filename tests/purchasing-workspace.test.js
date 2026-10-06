require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")
const ts = require("typescript")

function workspace({ denied = false, deniedProject = false, exception = null, scope = { assignedOnly: false, divisionIds: [] }, lookupRows = [], homes = { rows: [], nextCursor: null }, vendors = { entries: [], total: 0, page: 1, pageSize: 25 } } = {}) {
  const calls = []
  const context = { orgId: "org-a", userId: "buyer-a", supabase: { from(table) {
    const filters = []
    const query = { order() { return query }, range(start, end) { filters.push(["range", [start, end]]); return query }, in(key, value) { filters.push([key, value]); return query }, or(value) { filters.push(["or", value]); return query }, ilike(key, value) { filters.push([key, value]); return query }, then(resolve) { calls.push({ table, filters }); return Promise.resolve({ data: lookupRows, error: null }).then(resolve) }, select() { return query }, eq(key, value) { filters.push([key, value]); return query }, async maybeSingle() {
      calls.push({ table, filters })
      return { data: exception, error: null }
    } }
    return query
  } } }
  const stubs = {
    zod: require("zod"),
    "@/lib/land/scope": require("../lib/land/scope"),
    "@/lib/services/desk-context": { getAmbientDeskContext: async () => ({ divisionId: null }) },
    "@/lib/services/authorization": { getDivisionAccessForUser: async () => scope, requireAuthorization: async (input) => {
      calls.push({ authorization: input })
      if (deniedProject) throw new Error("Project forbidden")
    } },
    "@/lib/services/price-book": { listPriceAgreements: async (query) => {
      calls.push({ agreements: query })
      return { items: query.agreementIds.map((id) => ({ id })) }
    } },
    "@/lib/services/context": { requireOrgContext: async () => context },
    "@/lib/services/permissions": { requirePermission: async (permission, ctx) => {
      calls.push({ permission, context: ctx })
      if (denied) throw new Error("Forbidden")
    } },
    "@/lib/services/project-directory": { loadProjectDirectory: async (query, ctx) => {
      calls.push({ kind: "home", query, context: ctx })
      return { page: homes }
    } },
    "@/lib/services/directory": { listDirectoryPage: async (query) => {
      calls.push({ kind: "vendor", query })
      return vendors
    } },
  }
  const compiled = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/purchasing-workspace.ts"), "utf8")
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { module: compiled, exports: compiled.exports, require: (id) => {
    assert.ok(stubs[id], `Unexpected dependency: ${id}`)
    return stubs[id]
  } })
  return { search: compiled.exports.searchPurchasingEntities, candidates: compiled.exports.getPoExceptionCandidates, calls, context }
}

test("purchasing lookup denies access before reading either directory", async () => {
  for (const kind of ["home", "vendor"]) {
    const { search, calls } = workspace({ denied: true })
    await assert.rejects(search({ kind }), /Forbidden/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].permission, "price_book.read")
  }
})

const uuid = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`

test("candidate lookup checks the exception's actual project before reading prices", async () => {
  const { candidates, calls } = workspace({ deniedProject: true, exception: { project_id: "restricted-project", status: "open", candidates: [uuid(1)] } })
  await assert.rejects(candidates({ exceptionId: uuid(99) }), /Project forbidden/)
  assert.deepEqual(calls[1].filters, [["org_id", "org-a"], ["id", uuid(99)]])
  assert.equal(calls[2].authorization.projectId, "restricted-project")
  assert.equal(calls.some((call) => call.agreements), false)
})

test("candidate lookup paginates the complete candidate set with bounded price reads", async () => {
  const ids = Array.from({ length: 60 }, (_, index) => uuid(index))
  const { candidates, calls } = workspace({ exception: { project_id: "home-1", status: "open", candidates: ids } })
  const result = await candidates({ exceptionId: uuid(99), page: 3 })
  assert.equal(result.pages, 3)
  assert.equal(result.items.length, 10)
  assert.deepEqual(Array.from(calls.at(-1).agreements.agreementIds), ids.slice(50))
  assert.equal(calls.at(-1).agreements.pageSize, 25)
})

test("resolved and absent exceptions cannot load actionable pricing", async () => {
  for (const exception of [null, { project_id: "home-1", status: "dismissed", candidates: [uuid(1)] }]) {
    const { candidates, calls } = workspace({ exception })
    await assert.rejects(candidates({ exceptionId: uuid(99) }), /not found|no longer open/)
    assert.equal(calls.some((call) => call.agreements), false)
  }
})

test("home lookup retains authorization context, search and cursor without leaking financial data", async () => {
  const { search, calls, context } = workspace({ homes: { rows: [{ id: "home-1", name: "Lot 42", address: "Model Road", value_cents: 70000000, client_name: "Private buyer" }], nextCursor: "next-page" } })
  const result = await search({ kind: "home", search: "  Lot 42 ", cursor: "current-page" })
  assert.equal(calls[1].context, context)
  assert.equal(calls[1].query.q, "Lot 42")
  assert.equal(calls[1].query.cursor, "current-page")
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { items: [{ id: "home-1", name: "Lot 42", detail: "Model Road" }], nextCursor: "next-page", nextPage: null })
})

test("vendor lookup is bounded and exposes continuation until the final page", async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({ id: `vendor-${i}`, name: `Trade ${i}`, trade: "Framing", email: "not-returned@example.com" }))
  const first = workspace({ vendors: { entries, total: 51, page: 2, pageSize: 25 } })
  const result = await first.search({ kind: "vendor", search: "framing", page: 2 })
  assert.equal(first.calls[1].query.kind, "company")
  assert.equal(first.calls[1].query.pageSize, 25)
  assert.equal(first.calls[1].query.page, 2)
  assert.equal(result.nextPage, 3)
  assert.equal(result.nextCursor, null)
  assert.equal(result.items[0].email, undefined)
  const last = workspace({ vendors: { entries: entries.slice(0, 1), total: 51, page: 3, pageSize: 25 } })
  assert.equal((await last.search({ kind: "vendor", page: 3 })).nextPage, null)
})

test("malformed or excessive lookup input fails before reading data", async () => {
  for (const input of [{ kind: "user" }, { kind: "vendor", page: 0 }, { kind: "vendor", page: 1.5 }, { kind: "vendor", page: 100001 }, { kind: "home", search: "x".repeat(201) }, { kind: "home", cursor: "x".repeat(4097) }]) {
    const { search, calls } = workspace()
    await assert.rejects(search(input))
    assert.equal(calls.length, 0)
  }
})


test("production parent search uses a bounded page and enforces assigned divisions", async () => {
  const { search, calls } = workspace({ scope: { assignedOnly: true, divisionIds: [uuid(1)] }, lookupRows: Array.from({ length: 26 }, (_, index) => ({ id: uuid(index + 10), name: `Community ${index}`, code: null })) })
  const result = await search({ kind: "community", page: 2 })
  assert.equal(result.items.length, 25)
  assert.equal(result.nextPage, 3)
  const query = calls.find((call) => call.table === "communities")
  assert.ok(query.filters.some(([key, value]) => key === "division_id" && value[0] === uuid(1)))
  assert.ok(query.filters.some(([key, value]) => key === "range" && value[0] === 25 && value[1] === 50))
})

test("an empty assigned division scope never queries production parents", async () => {
  const { search, calls } = workspace({ scope: { assignedOnly: true, divisionIds: [] } })
  const result = await search({ kind: "plan" })
  assert.equal(result.items.length, 0)
  assert.equal(calls.some((call) => call.table), false)
})

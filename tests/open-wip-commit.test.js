const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")
const test = require("node:test")

function harness(failure, options = {}) {
  const calls = []
  const poRows = options.withPo ? [{ natural_key: "community:1:PO-1", parsed: { community: "Community", lot_number: "1", company_id: "vendor", remaining_cents: 20, original_cents: 50, po_number: "PO-1", description: "Remaining work" } }] : []
  const database = {
    import_batches: [{ id: "budget-file", context: { file_kind: "budgets", as_of_date: "2026-10-02" } }, ...(options.withPo ? [{ id: "po-file", context: { file_kind: "purchase_orders", as_of_date: "2026-10-02" } }] : [])],
    import_rows: options.rows ?? [{ natural_key: "community:1:budget", parsed: { community: "Community", lot_number: "1", budget_cents: 100, cost_code_id: "code" } }],
    communities: { id: "community", name: "Community", division_id: "division" },
    lots: { id: "lot", project_id: options.existing ? "existing" : null },
    projects: options.existing ? { id: "existing", metadata: {} } : { id: "project" },
    commitments: { id: "commitment" }, budgets: { id: "budget" }, contacts: null,
    schedule_templates: { items: [{ name: "Foundation", offset_days: 0 }, { name: "Framing", offset_days: 20 }, { name: "Roof", offset_days: 30 }] },
  }
  const supabase = { from(table) {
    const call = { table, operation: "read", filters: [] }
    calls.push(call)
    const response = () => ({ data: table === "import_rows" && call.batchIds?.includes("po-file") ? poRows : table === "import_rows" && call.range ? database.import_rows.slice(call.range[0], call.range[1] + 1) : call.operation === "insert" && table === "contacts" ? { id: "buyer" } : table === "lots" && call.operation === "update" && options.conflict ? null : database[table] ?? null, error: failure === `${table}:${call.operation}` ? { message: "injected failure" } : null })
    const query = {
      select() { return query }, eq(...args) { call.filters.push(args); return query }, is(...args) { call.filters.push(args); return query },
      order() { return query }, range(start, end) { call.range = [start, end]; return query }, in(key, values) { if (key === "batch_id") call.batchIds = values; return query }, neq() { return query }, ilike() { return query }, limit() { return query },
      insert(payload) { call.operation = "insert"; call.payload = payload; return query },
      update(payload) { call.operation = "update"; call.payload = payload; return query },
      delete() { call.operation = "delete"; return query },
      async single() { return response() }, async maybeSingle() { return response() },
      then(resolve, reject) { return Promise.resolve(response()).then(resolve, reject) },
    }
    return query
  } }
  const filename = path.resolve(__dirname, "../lib/services/imports.ts")
  const compiled = new Module(filename, module)
  compiled.filename = filename
  compiled.paths = module.paths
  compiled.require = name => name === "zod" ? require("zod") : ({ normalizeKey: (value) => String(value ?? "").trim().toLowerCase() })
  const source = fs.readFileSync(filename, "utf8") + "\nexports.commitOpenWipForTest = commitOpenWip; exports.loadRowsForTest = loadImportCommitRows;"
  compiled._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
  const row = { id: "row", parsed: { community: "Community", community_id: "community", lot_number: "1", budget_total_cents: 100, schedule_template_id: "template", stage_task: "Framing", stage_date: "2026-10-02", sold: true, buyer_name: "Buyer", buyer_email: "buyer@example.com", sale_price_cents: 50000, sale_date: "2026-09-01" } }
  return { calls, loadRows: () => compiled.exports.loadRowsForTest({ supabase, orgId: "org" }, ["batch"]), run: () => compiled.exports.commitOpenWipForTest([row], { supabase, orgId: "org", userId: "user" }, "batch", { as_of_date: "2026-10-02" }, "houses", options.onboardingRunId ?? null) }
}

test("sold cutover creates an active agreement and anchors schedule to the current stage before publishing the lot", async () => {
  const { run, calls } = harness()
  const result = await run()
  assert.equal(result.get("row").action, "created")
  const agreement = calls.find((call) => call.table === "contracts").payload
  assert.equal(agreement.status, "active")
  assert.equal(agreement.signed_at, "2026-09-01T00:00:00Z")
  const schedule = calls.find((call) => call.table === "schedule_items").payload
  assert.deepEqual(schedule.map((item) => item.start_date), ["2026-09-12", "2026-10-02", "2026-10-12"])
  const last = calls.at(-1)
  assert.equal(last.table, "lots")
  assert.ok(last.filters.some(([key, value]) => key === "project_id" && value === null))
})

for (const failure of ["budgets:insert", "budget_lines:insert", "schedule_templates:read", "schedule_items:insert", "contacts:read", "contacts:insert", "projects:update", "contracts:insert"]) {
  test(`${failure} fails cutover and never publishes an incomplete lot`, async () => {
    const { run, calls } = harness(failure)
    await assert.rejects(run(), /injected failure/)
    assert.equal(calls.some((call) => call.table === "lots" && call.operation === "update"), false)
    assert.equal(calls.at(-1).operation, "delete")
    assert.equal(calls.at(-1).table, "projects")
  })
}

test("companion lookup failure stops before any writes", async () => {
  const { run, calls } = harness("import_batches:read")
  await assert.rejects(run(), /companion batches/)
  assert.ok(calls.every((call) => call.operation === "read"))
})

test("an unrelated existing home requires reconciliation instead of silently skipping", async () => {
  const { run, calls } = harness(null, { existing: true })
  await assert.rejects(run(), /already has a project/)
  assert.ok(calls.every((call) => call.operation === "read"))
})

test("a concurrent lot assignment cannot be overwritten", async () => {
  const { run, calls } = harness(null, { conflict: true })
  await assert.rejects(run(), /Lot was assigned during import/)
  assert.equal(calls.at(-1).operation, "delete")
})


test("large imports load all rows through bounded pages with organization scope", async () => {
  const rows = Array.from({ length: 1203 }, (_, index) => ({ id: `row-${index}`, row_number: index + 1, parsed: {}, natural_key: String(index) }))
  const { loadRows, calls } = harness(null, { rows })
  const loaded = await loadRows()
  assert.equal(loaded.length, 1203)
  assert.equal(new Set(loaded.map((row) => row.id)).size, 1203)
  assert.deepEqual(calls.map((call) => call.range), [[0, 499], [500, 999], [1000, 1499]])
  assert.ok(calls.every((call) => call.filters.some(([key, value]) => key === "org_id" && value === "org")))
})


test("companion files are isolated to the same onboarding run and as-of date", async () => {
  const { run, calls } = harness(null, { onboardingRunId: "run-a" })
  await run()
  const query = calls.find((call) => call.table === "import_batches")
  assert.ok(query.filters.some(([key, value]) => key === "onboarding_run_id" && value === "run-a"))
  assert.ok(query.filters.some(([key, value]) => key === "context->>as_of_date" && value === "2026-10-02"))
})


test("duplicate companion rows fail before any home is created", async () => {
  const duplicate = { natural_key: "community:1:budget", parsed: { community: "Community", lot_number: "1", budget_cents: 50 } }
  const { run, calls } = harness(null, { rows: [duplicate, duplicate] })
  await assert.rejects(run(), /Duplicate Open-WIP companion row/)
  assert.ok(calls.every((call) => call.operation === "read"))
})

test("companion matching uses the complete house identity instead of a shared text prefix", async () => {
  const { run } = harness(null, { rows: [
    { natural_key: "community:1:budget", parsed: { community: "Community", lot_number: "1", budget_cents: 100 } },
    { natural_key: "community:1:2:budget", parsed: { community: "Community", block: "1", lot_number: "2", budget_cents: 999 } },
  ] })
  const result = await run()
  assert.equal(result.get("row").action, "created")
})


test("PO line failure cannot leave an imported home marked successful", async () => {
  const { run, calls } = harness("commitment_lines:insert", { withPo: true })
  await assert.rejects(run(), /Failed to create imported PO lines/)
  assert.equal(calls.some((call) => call.table === "lots" && call.operation === "update"), false)
  assert.equal(calls.at(-1).operation, "delete")
})
